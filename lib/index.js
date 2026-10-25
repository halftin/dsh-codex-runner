import { boundedSubagents } from './subagent-view.js';
import { recordFor, readJson } from './run-store.js';
import { createQuotaView } from './quota-view.js';
import { quotaTools } from './quota-tools.js';
import { createRunEvents } from './run-events.js';
import { RunNotifier } from './run-notifier.js';
import { StatusPolling } from './status-polling.js';
import { createRunRetention } from './run-retention.js';
import { loadEffectiveSettings, LOGS_REL } from './core.js';
import { runDirectory } from './run-store.js';
import path from 'node:path';
import { selectionTools } from './selection-audit.js';
import { Service } from '@deepseek-ai/cordis';
import { getCatalog, catalogTools } from './model-catalog.js';
import { registerRunnerRpc } from './runner-service.js';
import { createConfigurationEditor } from './configuration-editor.js';
import { previewFieldRegistry, getFieldRegistry } from './codex-fields.js';
/**
 * dsh-codex-runner：注册任务、状态、控制、历史与设置工具。
 * exec 保持兼容；App Server 提供活动轮插话与额度暂停。
 * 自动恢复按需接入宿主 Schedule 和 StorageDomain，关联原 DSH 会话。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import { buildToolDefinition, buildStatusToolDefinition, buildConfigToolDefinition, buildSayToolDefinition, killTree } from './core.js';
import { managementTools } from './management.js';
import { QuotaCoordinator } from './quota-coordinator.js';
import { historyTools } from './history.js';

export const name = 'dsh-codex-runner';

/**
 * 插件配置 schema —— **设置表单（P3）的宿主半边**。
 *
 * `.volatile()` 的字段会被 DSH 的 `settings` 服务投影成"可编辑的设置项"，
 * 表单以**插件的 profile 入口 id**（`dsh-codex-runner`）寻址，写入落进当前 profile 的
 * Cordis patch（即本插件 `cordis.patch.yml` 那一层），并由 config-editor 即时应用。
 *
 * 字段名与 `core.js` 的 `SETTINGS_SPEC` 保持一致 —— 两套入口共用同一条优先级：
 * 代码默认 ← DSH profile 配置（表单与 JSON 编辑器共用）← 支持的单次工具参数。
 * 注意：外部插件无需安装 `@deepseek-ai/schemastery`，宿主 Loader 在运行时解析（与 bridge 同款 peer 依赖）。
 */
export const Config = z.object({
  'agents.interrupt_message': z.any().volatile(),
  'maxConcurrent': z.number().volatile(),
  'retentionDays': z.number().volatile(),
  'retentionMaxRuns': z.number().volatile(),
  debugLogs: z.boolean().volatile(),
  debugMaxBytes: z.number().volatile(),
  statusPollingEnabled: z.boolean().volatile(),
  statusPollingIntervalMinutes: z.number().volatile(),

  pauseGraceMs: z.number().volatile(),
  backend: z.string().volatile(),
  codexConfig: z.any().volatile(),
  extraCodexConfig: z.any().volatile(),
  autoResumeAfterQuota: z.boolean().volatile(),
  quotaWarning: z.boolean().volatile(),
  quotaWarningThreshold: z.number().volatile(),
  selectionPolicy: z.string().volatile(),
  selectionMode: z.string().volatile(),
  defaultModel: z.string().volatile(),
  defaultEffort: z.string().volatile(),
  maxEffortAllowed: z.string().volatile(),
  autoModelAndEffort: z.boolean().volatile(),
  defaultBudgetMs: z.number().volatile(),
  driverPath: z.string().volatile(),
  codexExecutable: z.string().volatile(),
  codexHome: z.string().volatile(),
  serviceTier: z.string().volatile(),
  sandboxMode: z.string().volatile(),
  approvalPolicy: z.string().volatile(),
  workspaceNetworkAccess: z.boolean().volatile(),
});

/** 只依赖工具注册表；不碰投影/UI，保持宿主面最小。 */
export const inject = ['tools'];

/** 在跑的 driver 子进程（宿主卸载/热更新时整树终止，避免孤儿 codex）。 */

/** fail closed：拿不到会话工作目录就不跑（绝不用宿主 cwd 兜底）。 */
function resolveCwd(exec) {
  const header = exec && exec.agent && exec.agent.session ? exec.agent.session.header : null;
  const cwd = header ? header.cwd : null;
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : null;
}

export function apply(ctx, config = {}) {
  const configurationEditor=createConfigurationEditor({registryCompiler:overrides=>previewFieldRegistry(overrides,{settings:loadEffectiveSettings({config}).settings})});
  let lastWorkspace=null,coordinator;
  const quotaView=createQuotaView(),runEvents=createRunEvents(),knownRuns=new Map();
  const notifier=new RunNotifier().start();
  const statusPolling=new StatusPolling({settings:()=>loadEffectiveSettings({config}).settings}).start();
  ctx.effect(()=>()=>statusPolling.close(),'codex-runner: optional status query');
  const retention=createRunRetention({retentionDays:()=>loadEffectiveSettings({config}).settings.retentionDays,
    retentionMaxRuns:()=>loadEffectiveSettings({config}).settings.retentionMaxRuns});
  ctx.effect(()=>()=>retention.close(),'codex-runner: daily retention');
  ctx.effect(()=>()=>notifier.close(),'codex-runner: detach failure notifier');
  ctx.effect(()=>()=>runEvents.close(),'codex-runner: run event watches');
  class CodexRunnerService extends Service {
    constructor(context) {super(context,'codexRunner');}
    getCatalog(options={}) {return getCatalog({...options,settings:loadEffectiveSettings({config}).settings});}
    refreshCatalog() {return this.getCatalog({refresh:true});}
    async getEditorRegistry({refresh=false}={}) {
      if(refresh)await getFieldRegistry({refresh:true,settings:loadEffectiveSettings({config}).settings});
      return configurationEditor.get(await this.getCatalog());
    }
    async saveEditorRegistry(args) {return configurationEditor.save(await this.getCatalog(),args);}
    async getQuota(options={}) {
      let latest;try{latest=await coordinator?.latestState();}catch(error){latest={recovery:{phase:'needs_attention',error:error.message}};}
      const cwd=lastWorkspace||latest?.cwd;
      return quotaView.get({...options,settings:loadEffectiveSettings({config}).settings,logs:cwd?path.join(cwd,LOGS_REL):null,recovery:id=>cwd&&id?coordinator?.state(cwd,id):latest?.recovery||null});
    }
    getSubagents(runId) {
      const cwd=knownRuns.get(runId)||lastWorkspace;if(!cwd)return null;
      const logs=path.join(cwd,LOGS_REL),record=recordFor(logs,runId);if(!record)return null;
      const meta=readJson(path.join(runDirectory(logs,record),'result.meta.json'));return meta?boundedSubagents(meta.subagents):null;
    }
    runEventStream(signal) {return runEvents.stream(signal);}
  }
  const service=new CodexRunnerService(ctx);
  registerRunnerRpc(ctx,service);
  void service.getCatalog({refresh:true}).catch(()=>{});
  for(const tool of catalogTools({defineTool,catalog:options=>service.getCatalog(options)}))ctx.tools.register(tool);
  for(const tool of selectionTools({defineTool,resolveCwd,logsRelative:'.codex-runner/logs'}))ctx.tools.register(tool);
  const live = new Set();
  const quotaCoordinator = {
    available: exec => !!coordinator?.available(exec),
    track: options => coordinator.track(options),
    cancel: (cwd, runId) => coordinator?.cancel(cwd, runId),
    state: (cwd, runId) => coordinator?.state(cwd, runId),
  };
  const runner = buildToolDefinition({
    defineTool,
    resolveCwd,
    config,
    quotaCoordinator,
    quotaView,
    onRunReserved:({cwd,record})=>{lastWorkspace=cwd;knownRuns.set(record.runId,cwd);notifier.track({cwd,record});statusPolling.track({cwd,record});runEvents.track(runDirectory(path.join(cwd,LOGS_REL),record),record);retention.track(cwd);},
    onSpawn: (child) => { live.add(child); },
    onClose: (child) => { live.delete(child); },
  });
  ctx.tools.register(runner);
  for(const tool of quotaTools({defineTool,resolveCwd,config,quotaCoordinator,view:quotaView}))ctx.tools.register(tool);
  // The same host schedule service as quota recovery, without making failure
  // reminders depend on StorageDomain or quota recovery being enabled.
  ctx.inject(['schedule'],services=>{
    const schedule=services.schedule;notifier.bind(schedule);statusPolling.bind(schedule);
    services.effect(()=>()=>{if(notifier.schedule===schedule)notifier.bind(null);if(statusPolling.schedule===schedule)statusPolling.bind(null);});
  });
  ctx.inject(['schedule', 'storageDomain'], services => {
    coordinator = new QuotaCoordinator({ schedule: services.schedule, storageDomain: services.storageDomain, config, runner: () => runner }).start();
    const owned = coordinator;
    services.effect(() => async () => { if(coordinator===owned)coordinator=null;await owned.close(); });
  });
  ctx.tools.register(defineTool({
    name: 'codex_quota_resume', description: 'Check an exact quota reminder and resume its existing authorized Codex task once. Stale reminders cannot start a task.',
    parameters: { run_id:{type:'string',required:true}, generation:{type:'string',required:true} },
    output: { schema:{type:'json'}, render:(_a,v)=>[{type:'text',text:v.summary_text}] },
    isConcurrencySafe:()=>true, presentCall:()=>({card:'generic',title:'Codex quota recovery',kind:'execute'}),
    async execute(args,exec) { try {return coordinator ? await coordinator.recover(args,exec) : {status:'error',summary_text:'DSH Schedule or storage is unavailable'};}catch(error){return {status:'error',summary_text:error.message};} },
  }));

  // 后台（detach）任务的取回通道。注意：detach 的 driver **不进 live 集合** ——
  // 它必须活过宿主卸载/热更新，否则就白建这套机制了。
  ctx.tools.register(buildStatusToolDefinition({ defineTool, resolveCwd, config, quotaCoordinator }));

  // 配置只读查询；所有持久化修改统一由 DSH 设置页保存。
  ctx.tools.register(buildConfigToolDefinition({ defineTool, config }));

  // exec 支持 queue；App Server 支持 queue、steer 与 interrupt。
  ctx.tools.register(buildSayToolDefinition({ defineTool, resolveCwd, config }));
  for (const tool of managementTools({ defineTool, resolveCwd, quotaCoordinator, config })) ctx.tools.register(tool);
  for (const tool of historyTools({ defineTool, resolveCwd, config })) ctx.tools.register(tool);

  ctx.effect(() => () => {
    for (const child of live) child.stop ? child.stop() : killTree(child);
    live.clear();
  }, 'dsh-codex-runner: shutdown');
}
