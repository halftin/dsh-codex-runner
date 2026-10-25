import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { withAppServer } from './app-server-client.js';
import { codexEnvironment } from './executable.js';
import { accountFingerprint, quotaDecision } from './quota-policy.js';
import { listRecords, runDirectory, readJson, runEvidence } from './run-store.js';

export function normalizeQuotaWindows(response,now=Date.now()) {
  const windows={five_hour:null,seven_day:null};
  const buckets=response?.rateLimitsByLimitId || (response?.rateLimits?{codex:response.rateLimits}:{});
  for(const [bucket,limits] of Object.entries(buckets)) {
    if(bucket!=='codex')continue;
    for(const kind of ['primary','secondary']) {
      const item=limits?.[kind];if(!item)continue;
      const used=item.usedPercent ?? item.used_percent,duration=item.windowDurationMins ?? item.window_minutes;
      if(!Number.isFinite(used)||used<0||used>100)continue;
      const key=duration===300?'five_hour':duration===10080?'seven_day':null;if(!key)continue;
      const seconds=item.resetsAt ?? item.resets_at;
      const reset=Number.isSafeInteger(seconds)&&seconds>0&&seconds*1000<now+370*86400000?seconds*1000:null;
      const value={used_percent:used,remaining_percent:100-used,resets_at:reset?new Date(reset).toISOString():null,reset_in_sec:reset?Math.max(0,Math.ceil((reset-now)/1000)):null};
      if(!windows[key]||windows[key].used_percent<used)windows[key]=value;
    }
  }
  return windows;
}
export function quotaFromMeta(meta,now=Date.now()) {
  if(!meta)return null;
  const raw=meta.quota?.windows?{rateLimits:{primary:meta.quota.windows.find(w=>w.kind==='primary'),secondary:meta.quota.windows.find(w=>w.kind==='secondary')}}:{rateLimits:meta.rateLimits};
  const windows=normalizeQuotaWindows(raw,now);
  if(!windows.five_hour&&!windows.seven_day)return null;
  const sampledAt=meta.quota?.sampledAt || meta.quotaSampledAt || Date.parse(meta.end || meta.start || '');
  return {windows,account:{plan:meta.accountPlan||null,fingerprint_prefix:meta.accountFingerprint?.slice(0,6)||null},
    sampledAt:Number.isFinite(sampledAt)?sampledAt:null,source:meta.backend==='app-server'?'app-server':'last-run',source_detail:'run-meta',
    stale:meta.backend!=='app-server'||!Number.isFinite(sampledAt)||now-sampledAt>60000};
}
function cacheIdentity(settings={}) {
  const env=codexEnvironment(settings);
  const home=env.CODEX_HOME||path.join(os.homedir(),'.codex');let auth='anonymous';
  try{auth=createHash('sha256').update(fs.readFileSync(path.join(home,'auth.json'))).digest('hex');}catch{}
  return JSON.stringify([home,auth,env.CODEX_EXE||'default',env.NODE_OPTIONS||'']);
}
function recentSnapshots(logs,now) {
  let latest=null,active=null,recoveryRecord=null;
  if(!logs)return {latest,active,recoveryRecord};
  for(const record of listRecords(logs).slice(0,100)) {
    const dir=runDirectory(logs,record),meta=readJson(path.join(dir,'result.meta.json')),hb=readJson(path.join(dir,'result.hb.json'));
    if(!recoveryRecord && (meta?.status==='waiting_quota'||meta?.quota?.state==='blocked'))recoveryRecord=record;
    const snapshot=quotaFromMeta(meta,now)||quotaFromMeta(hb,now);if(!snapshot)continue;
    latest ||= {...snapshot,run_id:record.runId};
    if(!active && !meta?.status && runEvidence(logs,record).running)active={...snapshot,run_id:record.runId,source_detail:'active-driver'};
    if(latest&&active&&recoveryRecord)break;
  }
  return {latest,active,recoveryRecord};
}
export function createQuotaView({connect=withAppServer,now=Date.now,minIntervalMs=180000,identity=cacheIdentity}={}) {
  const cache=new Map();
  return {async get({probe='none',timeoutMs=15000,refresh=false,logs=null,settings={},recovery}={}) {
    if(!['none','fresh','active','both'].includes(probe))throw Error('Invalid quota probe');
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000||typeof refresh!=='boolean')throw Error('Invalid quota timeout/refresh');
    const key=identity(settings),stamp=now(),cached=cache.get(key),recent=recentSnapshots(logs,stamp),probes={fresh:null,active:null};
    let data=cached?.data || recent.latest,wasCached=!!cached,probeError=null,limited=false;
    if(probe==='active'||probe==='both') {
      if(recent.active){data=recent.active;wasCached=false;probes.active={ok:true,latency_ms:0,error:null};}
    }
    if(probe==='fresh'||probe==='both') {
      if(settings.backend==='exec')probes.fresh={ok:false,latency_ms:0,error:'Exec backend exposes last-run quota only'};
      else if(cached && stamp-cached.at<minIntervalMs) {if(cached.data && (!data||cached.data.sampledAt>=data.sampledAt))data=cached.data;limited=true;probes.fresh=cached.probe;probeError=cached.probe?.error||null;}
      else {
        const entry={at:stamp,data:cached?.data||null,pending:null};cache.set(key,entry);
        const started=now();
        entry.pending=(async()=>{
          try {
            const sample=await connect(async client=>{
              const [account,limits]=await Promise.all([client.request('account/read',{refreshToken:false},timeoutMs),client.request('account/rateLimits/read',{},timeoutMs)]);
              return {account,limits};
            },{timeoutMs,settings});
            const sampledAt=now(),fingerprint=accountFingerprint(sample.account),windows=normalizeQuotaWindows(sample.limits,sampledAt);
            const decision=quotaDecision(sample.limits,sampledAt,sampledAt);
            entry.data={windows,account:{plan:String(sample.account.account?.planType||sample.account.account?.plan_type||'unknown').slice(0,40),fingerprint_prefix:fingerprint?.slice(0,6)||null},
              sampledAt,source:'app-server',source_detail:'fresh-probe',stale:false,unknown:!fingerprint||decision.state==='unknown',reason:!fingerprint?'account-unverified':decision.reason};
            entry.probe={ok:true,latency_ms:Math.max(0,now()-started),error:null};
          }catch(error){entry.probe={ok:false,latency_ms:Math.max(0,now()-started),error:String(error.message).slice(0,500)};}
          finally{entry.pending=null;}
        })();
        await entry.pending;data=entry.data||data;probes.fresh=entry.probe;probeError=entry.probe.error;wasCached=false;
      }
    }
    const latest=cache.get(key);
    if(latest?.pending) {await latest.pending;data=latest.data||data;probes.fresh=latest.probe;probeError=latest.probe?.error||null;}
    const windows=data?.windows||{five_hour:null,seven_day:null};
    const sampledAt=data?.sampledAt??null,age=sampledAt===null?null:Math.max(0,now()-sampledAt);
    const stale=!!data&&(data.stale||settings.backend==='exec'||age===null||age>60000||!!probeError);
    // Reset countdowns refer to this response time, even when the sample is cached.
    for(const window of Object.values(windows))if(window?.resets_at)window.reset_in_sec=Math.max(0,Math.ceil((Date.parse(window.resets_at)-now())/1000));
    const threshold=Number.isFinite(settings.quotaWarningThreshold)?settings.quotaWarningThreshold:5;
    const remaining=Object.values(windows).filter(Boolean).map(w=>w.remaining_percent);
    let recoveryState=null;
    try{recoveryState=recovery?await recovery(recent.recoveryRecord?.runId || recent.latest?.run_id):null;}catch(error){recoveryState={phase:'needs_attention',error:error.message};}
    return {status:!data?(probeError?'unavailable':'unknown'):stale?'stale':data.unknown?'unknown':'ok',scope:'account-wide',
      account:data?.account||{plan:null,fingerprint_prefix:null},windows:structuredClone(windows),warning:{enabled:settings.quotaWarning===true,threshold,triggered:settings.quotaWarning===true&&remaining.some(n=>n<=threshold)},
      recovery:recoveryState,source:settings.backend==='exec'?'last-run':data?.source||'none',source_detail:data?.source_detail||null,
      sampled_at:sampledAt===null?null:new Date(sampledAt).toISOString(),cached:wasCached,stale,probe:probes,
      transport:settings.backend==='exec'?'not-probed':probes.fresh?probes.fresh.ok?'reachable':'unreachable':'unknown',error:probeError||data?.reason||null,refresh_limited:limited,
      next_probe_at:latest?new Date(latest.at+minIntervalMs).toISOString():null};
  }};
}
