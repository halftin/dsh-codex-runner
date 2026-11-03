import fs from 'node:fs';
import assert from 'node:assert/strict';
import {englishOpenApi} from './openapi-english.mjs';
const manifest=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8'));
const rpcSource=fs.readFileSync(new URL('../lib/runner-service.js',import.meta.url),'utf8');
const uuid='11111111-1111-4111-8111-111111111111';
const ref=name=>({$ref:'#/components/schemas/'+name});
const str=(description,extra={})=>({type:'string',...(description?{description}:{}),...extra});
const bool=description=>({type:'boolean',...(description?{description}:{})});
const num=(description,extra={})=>({type:'integer',...(description?{description}:{}),...extra});
const obj=(properties={},required=[],extra={})=>({type:'object',...(required.length?{required}:{}),properties,...extra});
const nullableString=(description,extra={})=>str(description,{nullable:true,...extra});
const map=(schema,description)=>({type:'object',additionalProperties:schema,...(description?{description}:{})});
const timestamp=description=>nullableString(description,{format:'date-time'});
const schemas={
  RpcId:str('小写 UUID v4；rpcId 用于请求关联，响应原样返回。runId 使用相同格式',{
    format:'uuid',pattern:'^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$',example:uuid}),
  ServiceError:obj({ok:{type:'boolean',enum:[false]},error:obj({code:str(null,{enum:['codex-runner/request']}),message:str('校验、读取或保存失败原因'),details:{type:'object',additionalProperties:true}},['code','message','details'])},['ok','error']),
  RefreshPayload:obj({refresh:{...bool('是否请求重新发现/刷新；可能更新本地参考缓存，但不启动模型回合'),default:false}},[],{additionalProperties:false}),
  EmptyPayload:obj({},[],{additionalProperties:false}),
  QuotaPayload:obj({probe:str('none 读取已有数据；fresh 查询账号；active 读取活动运行快照；both 合并两者，不发送 steer', {enum:['none','fresh','active','both'],default:'none'}),timeoutMs:num('原生查询超时，毫秒',{minimum:1,maximum:60000,default:15000}),refresh:{...bool('刷新标记；不会绕过 fresh 查询的三分钟限频'),default:false}},[],{additionalProperties:false}),
  SubagentsPayload:obj({runId:ref('RpcId')},['runId'],{additionalProperties:false}),
  NativeJsonSchema:{type:'object',additionalProperties:true,description:'作为数据传递的 Codex JSON Schema，不是本 OpenAPI 的 Schema Object；可能含原生扩展和递归定义'},
  FieldRule:obj({allow:bool('允许通用配置透传'),used:bool('插件专用控制使用的字段'),profile:bool('内置控件声明'),aliasOf:str('目标字段键；须满足原生安全键规则'),schema:ref('NativeJsonSchema'),fallbackSchema:ref('NativeJsonSchema'),name:str('字段名称',{maxLength:4000}),description:str('字段说明',{maxLength:4000}),deprecated:bool('弃用标记'),minVersion:str('最小 Codex 版本，含端点'),maxVersion:str('最大 Codex 版本，含端点'),excludedValues:{type:'array',maxItems:200,items:{type:'string'},description:'从原生枚举中排除的字符串值'}},[],{additionalProperties:false,description:'兼容规则；键为受校验的 Codex 字段名，不能借别名绕过权限控制'}),
  TranslationText:str('至多 200 字符的单行纯文本；不含尖括号、控制字符或换行',{maxLength:200,pattern:'^[^<>\\r\\n\\u0000-\\u001f\\u007f\\u2028\\u2029]*$'}),
  DescriptionTranslation:obj({description:ref('TranslationText'),_source:map({type:'string'},'兼容读取的来源元数据，手动保存不重新生成')},[],{additionalProperties:false}),
  NamedTranslation:obj({name:ref('TranslationText'),description:ref('TranslationText'),_source:map({type:'string'},'兼容读取的来源元数据')},[],{additionalProperties:false}),
  Translations:obj({version:{type:'integer',enum:[1]},locale:str(null,{enum:['zh-CN']}),models:map(ref('DescriptionTranslation')),efforts:map(ref('DescriptionTranslation')),tiers:map(ref('NamedTranslation')),settings:map(ref('NamedTranslation')),meta:{type:'object',additionalProperties:true}},['version','locale'],{additionalProperties:true,description:'用户中文翻译；空白值继承内置文本，保留原生 ID，不自动调用翻译模型'}),
  RegistryDocument:obj({version:{type:'integer',enum:[1]},codexVersion:nullableString('系统生成，保存时必须保留 getEditorRegistry 的原值'),updatedAt:timestamp('系统生成的最后成功刷新时间，保存时必须保留原值'),fields:map(ref('FieldRule'),'完整合并后的字段规则；不要以空对象替代读取结果'),translations:ref('Translations')},['version','codexVersion','updatedAt','fields','translations'],{additionalProperties:false,description:'先读取当前文档，修改需要的字段后原样保留其余内容；省略内置字段会被解释为禁用该字段'}),
  SaveRegistryPayload:obj({document:ref('RegistryDocument'),revision:str('必须使用最近 getEditorRegistry 返回的修订 SHA256；过期时返回业务错误',{pattern:'^[a-f0-9]{64}$'}),preview:{...bool('true 仅预检，不写用户规则/翻译文件；false 才提交保存'),default:false}},['document','revision'],{additionalProperties:false}),
  FieldRegistry:obj({version:{type:'integer',enum:[1]},codexVersion:nullableString('本地 Codex 版本'),source:str('注册表来源，例如 bundled、cache、installed-protocol'),referenceSource:str('参考定义来源'),referenceVersion:nullableString('参考快照版本'),referenceMatched:bool(),referenceFieldCount:num(null,{minimum:0}),localFieldCount:num(null,{minimum:0}),protocolSchemaCount:num(null,{minimum:0}),fields:map({type:'object',additionalProperties:true},'已编译字段定义，包含动态 schema 与兼容元数据'),config:map({},'允许通用透传的字段及其编译配置，值随原生版本变化'),error:nullableString('发现或读取诊断'),updatedAt:timestamp('最后成功更新'),stale:bool('缓存是否过期'),fallback:bool(),fallbackFile:str('内置回退文件的相对路径'),paths:map({type:'string',nullable:true},'宿主返回的本地文件位置；可能含本机路径，不应作为公开示例原样分享')},['version','fields','config'],{additionalProperties:true,description:'原生字段和发现元数据随 CLI 版本变化；额外字段被保留'}),
  SettingDefinition:obj({source:str(null,{enum:['codex','plugin']}),nativeKey:nullableString('对应原生键；插件自身设置为 null'),schema:ref('NativeJsonSchema'),defaultValue:{description:'该设置的默认 JSON 值，可为 null'}},['source','nativeKey','schema','defaultValue'],{additionalProperties:true}),
  RegistryEditorView:obj({document:ref('RegistryDocument'),revision:nullableString('可编辑时为修订 SHA256；只读时为 null',{pattern:'^[a-f0-9]{64}$'}),readOnly:bool('用户文件损坏或不可读取时为 true'),definitions:map(ref('SettingDefinition'),'当前插件配置字段定义，不包含当前 profile 的实际设置值'),configuration:ref('FieldRegistry')},['document','revision','readOnly','definitions','configuration'],{additionalProperties:true}),
  RegistryPreviewView:obj({configuration:ref('FieldRegistry'),definitions:map(ref('SettingDefinition'))},['configuration','definitions'],{additionalProperties:false,description:'preview=true 时的返回结果，不包含新的 document、revision 或 readOnly'}),
  Effort:obj({id:str('原生强度标识'),description:str('原生说明'),localized:{type:'object',additionalProperties:true}},['id','description'],{additionalProperties:true}),
  ServiceTier:obj({id:str('原生服务档标识'),name:str(),description:str(),localized:{type:'object',additionalProperties:true}},['id','name','description'],{additionalProperties:true}),
  Model:obj({id:str('模型 ID'),model:str('归一化后与 id 一致'),displayName:str(),description:str(),hidden:bool(),isDefault:bool(),defaultReasoningEffort:str(),efforts:{type:'array',items:ref('Effort')},serviceTiers:{type:'array',items:ref('ServiceTier')},inputModalities:{type:'array',items:{type:'string'}},multiAgentVersion:{description:'原生子任务能力版本，未提供时为 null'},localized:{type:'object',additionalProperties:true}},['id','model','displayName','description','hidden','isDefault','defaultReasoningEffort','efforts','serviceTiers'],{additionalProperties:true}),
  CatalogView:obj({models:{type:'array',items:ref('Model')},source:str('app-server、fallback 或缓存中保留的来源'),fetchedAt:timestamp('目录采样时间'),stale:bool(),cached:bool(),error:str('刷新失败时的错误，成功时通常省略'),configuration:ref('FieldRegistry'),settings:{type:'array',items:{type:'object',additionalProperties:true},description:'注册表设置的本地化说明，不是当前 profile 配置'},accountFingerprint:nullableString('账号指纹；不是登录凭据'),cacheKey:str(),cacheError:str(),i18n_error:str()},['models','source','fetchedAt','stale','configuration'],{additionalProperties:true}),
  QuotaWindow:obj({used_percent:{type:'number',minimum:0,maximum:100},remaining_percent:{type:'number',minimum:0,maximum:100},resets_at:timestamp('额度重置时间，未知为 null'),reset_in_sec:{type:'integer',minimum:0,nullable:true,description:'相对本次响应的重置倒计时秒数'}},['used_percent','remaining_percent','resets_at','reset_in_sec'],{nullable:true,additionalProperties:true}),
  QuotaProbe:obj({ok:bool(),latency_ms:num(null,{minimum:0}),error:nullableString()},['ok','latency_ms','error'],{nullable:true,additionalProperties:true}),
  RecoveryState:{type:'object',nullable:true,additionalProperties:true,description:'原运行的恢复状态，可能包含 phase、run_id、generation、resume_at、schedule_id、resumed_run_id、error、retention_warning；没有记录时为 null'},
  QuotaView:obj({status:str(null,{enum:['ok','stale','unknown','unavailable']}),scope:str(null,{enum:['account-wide']}),account:obj({plan:nullableString('账号计划'),fingerprint_prefix:nullableString('账号指纹前缀')},['plan','fingerprint_prefix']),windows:obj({five_hour:ref('QuotaWindow'),seven_day:ref('QuotaWindow')},['five_hour','seven_day']),warning:obj({enabled:bool(),threshold:{type:'number'},triggered:bool()},['enabled','threshold','triggered']),recovery:ref('RecoveryState'),source:str(null,{enum:['app-server','last-run','none']}),source_detail:nullableString(),sampled_at:timestamp('数据采样时间'),cached:bool(),stale:bool(),probe:obj({fresh:ref('QuotaProbe'),active:ref('QuotaProbe')},['fresh','active']),transport:str(null,{enum:['not-probed','reachable','unreachable','unknown']}),error:nullableString(),refresh_limited:bool(),next_probe_at:timestamp('下次允许 fresh 探测的时间')},['status','scope','account','windows','warning','recovery','source','source_detail','sampled_at','cached','stale','probe','transport','error','refresh_limited','next_probe_at'],{additionalProperties:true}),
  SubagentItem:obj({id:nullableString(null,{maxLength:200}),status:str(null,{enum:['running','completed','failed','unknown']}),tool:nullableString(null,{maxLength:200}),updated_at:nullableString(null,{maxLength:200})},['id','status','tool','updated_at']),
  SubagentsView:obj({count:num(null,{minimum:0}),running:num(null,{minimum:0}),completed:num(null,{minimum:0}),failed:num(null,{minimum:0}),unknown:num(null,{minimum:0}),truncated:bool(),items:{type:'array',maxItems:32,items:ref('SubagentItem')}},['count','running','completed','failed','unknown','truncated','items'],{nullable:true,additionalProperties:false,description:'找不到运行归属、记录或元数据时，value 直接为 null'}),
  RunEvent:obj({run_id:ref('RpcId'),status:str('output_changed 表示输出或独立记录确认变化；其他值为运行终态，例如 completed、failed、cancelled')},['run_id','status'],{additionalProperties:false})
};
const examples={
  catalog:{models:[{id:'gpt-6.1-sol',model:'gpt-6.1-sol',displayName:'gpt-6.1-sol',description:'Example model',hidden:false,isDefault:true,defaultReasoningEffort:'high',efforts:[{id:'high',description:'High effort'}],serviceTiers:[],inputModalities:[],multiAgentVersion:null}],source:'fallback',fetchedAt:null,stale:true,cached:false,configuration:{version:1,codexVersion:null,source:'bundled',fields:{},config:{},error:null}},
  quota:{status:'unknown',scope:'account-wide',account:{plan:null,fingerprint_prefix:null},windows:{five_hour:null,seven_day:null},warning:{enabled:false,threshold:5,triggered:false},recovery:null,source:'none',source_detail:null,sampled_at:null,cached:false,stale:false,probe:{fresh:null,active:null},transport:'unknown',error:null,refresh_limited:false,next_probe_at:null},
  editor:{document:{version:1,codexVersion:null,updatedAt:null,fields:{},translations:{version:1,locale:'zh-CN',models:{},efforts:{},tiers:{},settings:{},meta:{}}},revision:'0'.repeat(64),readOnly:false,definitions:{},configuration:{version:1,codexVersion:null,source:'bundled',fields:{},config:{},error:null}},
  preview:{configuration:{version:1,codexVersion:null,source:'bundled',fields:{},config:{},error:null},definitions:{}}
};
const definitions=[
  {method:'getCatalog',tag:'模型目录',summary:'读取模型目录与字段参考',payload:'RefreshPayload',response:'CatalogView',sample:{refresh:false},value:examples.catalog,
    description:'读取全部模型、支持的思考强度和服务档，以及注册表和本地化元数据。refresh=true 请求重新查询，缓存过期时也可能刷新。可能启动 CLI 的只读查询并更新缓存，不启动模型回合。这里返回的是服务目录结构，与 codex_models 工具经过裁剪的输出不同。示例模型仅展示格式，不能当作当前账号可用性证据'},
  {method:'refreshCatalog',tag:'模型目录',summary:'强制刷新模型目录',payload:'EmptyPayload',response:'CatalogView',sample:{},value:examples.catalog,
    description:'等价于服务 getCatalog({refresh:true})。payload 必须为空对象或省略。原生查询失败时可以成功返回带 stale=true/error 的回退目录，应结合 value 的来源与错误判断数据新鲜度'},
  {method:'getQuota',tag:'额度与子任务',summary:'查询账号级额度和恢复状态',payload:'QuotaPayload',response:'QuotaView',sample:{probe:'none',timeoutMs:15000,refresh:false},value:examples.quota,
    description:'返回账号级 5 小时/7 天窗口、采样时间、告警、探测和恢复状态，不按工作区分配额度。fresh 仅查询账号接口，不启动模型回合；三分钟限频不能通过 refresh 绕过。active 读取活动运行快照，不发送消息。无数据时 status=unknown，失败时可能仍保留旧数据'},
  {method:'getSubagents',tag:'额度与子任务',summary:'读取指定运行的原生子任务摘要',payload:'SubagentsPayload',response:'SubagentsView',sample:{runId:uuid},value:null,
    description:'只读取插件已知工作区中该运行保存的子任务状态，最多返回 32 项。运行归属、记录或元数据不可用时 result.ok=true 且 value=null。不会启动子任务、读取完整子消息或取消进程'},
  {method:'getEditorRegistry',tag:'注册表编辑',summary:'读取注册表编辑文档与修订号',payload:'RefreshPayload',response:'RegistryEditorView',sample:{refresh:false},value:examples.editor,
    description:'读取合并后的字段规则、中文翻译、生成元数据、修订号及设置定义。配置值仍由 DSH configForms 管理。refresh=true 会重新发现字段并更新参考缓存，不是仅刷新内存草稿。readOnly=true 时 revision=null，不能保存。响应示例已裁剪字段且 revision 为占位符，切勿拿示例直接替代实际文档'},
  {method:'saveEditorRegistry',tag:'注册表编辑',summary:'预检或保存字段规则与中文翻译',payload:'SaveRegistryPayload',response:null,sample:{document:examples.editor.document,revision:examples.editor.revision,preview:true},value:examples.preview,
    description:'先调用 getEditorRegistry，复制其完整 document 和 revision，再修改所需字段。本示例仅说明结构：零值 revision 与空 fields 都是占位符，不能直接用于保存。默认示例 preview=true 仅预检；preview=false 才向固定位置写入字段覆盖和用户中文翻译，不写当前 profile 配置。codexVersion/updatedAt 不能修改，缺失内置字段会被解释为禁用；revision 过期时须重读。规则和翻译文件写入失败会尝试回滚。预检返回 configuration/definitions；保存返回新的完整编辑视图。该接口不会调用翻译模型',write:true}
];
const actual=rpcSource.match(/for\(const method of \[([^\]]+)\]/)?.[1].match(/'([^']+)'/g)?.map(value=>value.slice(1,-1));
assert.deepEqual(actual,[...definitions.map(value=>value.method),'getOutput','getOutputResource'],'HTTP route definitions changed; review the contract before regenerating');
const paths={};
for(const entry of definitions){
  const name=entry.method[0].toUpperCase()+entry.method.slice(1),method='codex-runner/'+entry.method;
  schemas[name+'Request']=obj({type:str(null,{enum:['client-request']}),rpcId:ref('RpcId'),method:str(null,{enum:[method]}),payload:ref(entry.payload)},entry.write||entry.method==='getSubagents'?['type','rpcId','method','payload']:['type','rpcId','method'],{additionalProperties:false});
  const value=entry.response?ref(entry.response):{oneOf:[ref('RegistryPreviewView'),ref('RegistryEditorView')]};
  schemas[name+'Response']=obj({type:str(null,{enum:['server-response']}),rpcId:ref('RpcId'),result:{oneOf:[obj({ok:{type:'boolean',enum:[true]},value},['ok','value']),ref('ServiceError')]}},['type','rpcId','result'],{additionalProperties:false});
  paths['/api/codex-runner/'+entry.method]={post:{tags:[entry.tag],operationId:entry.method,summary:entry.summary,
    description:entry.description+'\n\nHTTP 200 仅表示封装处理完成，必须检查 result.ok；业务失败在 result.error 中，不会自动变为 HTTP 400 或 409。请求体必须是 client-request 封装，不能直接发送 payload。',
    'x-dsh-request-max-code-units':entry.write?1048576:16384,
    requestBody:{required:true,description:entry.write?'application/json；整个正文最多 1048576 个 JS 字符串代码单元，document 序列化后另限 1 MiB UTF-8 字节；宿主可能还有请求体限制':'application/json；整个正文最多 16384 个 JS 字符串代码单元；payload 省略时按空对象处理，但需要参数的接口仍会返回业务错误',content:{'application/json':{schema:ref(name+'Request'),example:{type:'client-request',rpcId:uuid,method,payload:entry.sample}}}},
    responses:{'200':{description:'成功或业务错误，通过 result.ok 区分',content:{'application/json':{schema:ref(name+'Response'),examples:{success:{summary:entry.write?'预检成功示例':'成功示例（示意数据）',value:{type:'server-response',rpcId:uuid,result:{ok:true,value:entry.value}}},businessError:{summary:'业务错误仍为 HTTP 200',value:{type:'server-response',rpcId:uuid,result:{ok:false,error:{code:'codex-runner/request',message:entry.write?'Registry changed on disk. Reopen the editor before saving.':'Invalid read-only service request',details:{}}}}}}}}},
      '400':{$ref:'#/components/responses/InvalidRequest'},'413':{$ref:'#/components/responses/RequestTooLarge'},'415':{$ref:'#/components/responses/ExpectedJson'},
      '401':{$ref:'#/components/responses/Unauthenticated'},'403':{$ref:'#/components/responses/Forbidden'},'404':{$ref:'#/components/responses/NotFound'},default:{$ref:'#/components/responses/HostError'}}}};
}
assert.ok(rpcSource.includes("path:'/api/codex-runner/run-events'"));
paths['/api/codex-runner/run-events']={get:{tags:['运行事件'],operationId:'runEvents',summary:"订阅输出变化与运行终态事件（SSE）",description:"需要宿主 connection、webServer、rpc.handle 及 runEventStream 支持。连接先收到注释，之后收到 data: JSON 形式的变化通知；status=output_changed 表示输出索引或独立记录确认发生变化，其他状态表示每个运行的一次终态通知。通知不含正文，不重放历史，也不保证 Last-Event-ID 恢复；慢客户端可丢弃通知。客户端应在初次连接、重连和必要的补偿查询时按输出游标补读。每 15 秒发送保活注释。读取输出时可登记已有运行；终态后保留 30 秒文件监听以捕获末尾提交。不会启动任务",responses:{'200':{description:'持续的 Server-Sent Events；每条 data 后有两个换行',headers:{'Cache-Control':{schema:{type:'string',enum:['no-store']}}},content:{'text/event-stream':{schema:{type:'string'},example:': codex-runner read-only run invalidation\n\ndata: '+JSON.stringify({run_id:uuid,status:'completed'})+'\n\n'}},'x-dsh-event-data':ref('RunEvent')},'401':{$ref:'#/components/responses/Unauthenticated'},'403':{$ref:'#/components/responses/Forbidden'},'404':{$ref:'#/components/responses/NotFound'},default:{$ref:'#/components/responses/HostError'}}}};
const textResponse=(description,example)=>({description,content:{'text/plain':{schema:{type:'string'},example}}});
const specification={openapi:'3.0.3',info:{title:'dsh-codex-runner 通信接口',version:manifest.version,description:'供 Apipost 导入的插件设置页与宿主通信接口，不包含 codex_run 等 15 个模型工具，也不是独立 HTTP 服务。必须启用插件和 DSH Connection Fetch。所有接口要求 DSH owner 权限；在 Apipost 把示例 server 替换为实际 DSH Web 服务地址（包含端口和部署前缀），并配置有效 owner 会话 Cookie。Cookie 名称按宿主地址动态生成，本文件用完整 Cookie 请求头建模，不引入新的插件 API Key。不要使用 Codex 登录凭据替代 DSH 会话。HTTP 200 的业务错误查看 result.ok/result.error。所有示例均为合成数据，没有包含真实凭据、账号或本机路径。',license:{name:'MIT',url:'https://github.com/halftin/dsh-codex-runner/blob/main/LICENSE'}},
  servers:[{url:'http://localhost',description:'占位地址；请替换为实际 DSH Web 服务根地址，含端口与部署前缀，HTTPS 部署应使用 https'}],
  tags:[{name:'模型目录',description:'目录读取和刷新，不启动模型回合'},{name:'额度与子任务',description:'账号额度和运行快照读取'},{name:'注册表编辑',description:'字段规则、中文翻译、预检与保存'},{name:'运行事件',description:'SSE 终态通知'}],
  security:[{DshOwnerSession:[]}],paths,components:{securitySchemes:{DshOwnerSession:{type:'apiKey',in:'header',name:'Cookie',description:'填写已通过 DSH owner 登录的完整 Cookie 请求头值（name=value; ...）。名称与宿主地址有关，不应硬编码。此处仅描述 HTTP 会话传递方式；真正的签名校验和 owner 权限检查由 DSH Connection 执行。请在 Apipost 私有环境中配置，不写入共享文档'}},schemas,responses:{
    InvalidRequest:textResponse('插件封装/JSON 校验失败，纯文本，不是 result.error','Invalid request envelope'),
    RequestTooLarge:textResponse('请求正文超出插件字符串长度上限；也可能先由宿主拒绝','Request too large'),
    ExpectedJson:textResponse('Content-Type 不是 application/json','Expected JSON'),
    Unauthenticated:{description:'未通过 DSH 宿主认证；由宿主返回，正文格式依部署而异'},Forbidden:textResponse('已连接但不是 owner，DSH Connection 拒绝访问','forbidden'),
    NotFound:textResponse('插件未启用、接口未注册、缺少宿主服务或 URL/方法不匹配','not found'),HostError:{description:'宿主、代理或未捕获异常返回的其他响应；具体状态与格式依部署而异'}
  }},'x-dsh-contract-source':['lib/runner-service.js','lib/index.js','lib/model-catalog.js','lib/quota-view.js','lib/configuration-editor.js','lib/subagent-view.js','lib/run-events.js']};
fs.mkdirSync(new URL('../docs/api/',import.meta.url),{recursive:true});
const output=JSON.stringify(specification,null,2)+'\n';fs.writeFileSync(new URL('../docs/api/openapi.json',import.meta.url),output);
fs.writeFileSync(new URL('../docs/api/openapi.en.json',import.meta.url),JSON.stringify(englishOpenApi(specification),null,2)+'\n');
await import('./sync-output-api.mjs');
const generated=JSON.parse(fs.readFileSync(new URL('../docs/api/openapi.json',import.meta.url)));
console.log('OPENAPI-GENERATED '+JSON.stringify({version:manifest.version,operations:Object.keys(generated.paths).length,schemas:Object.keys(generated.components.schemas).length}));
