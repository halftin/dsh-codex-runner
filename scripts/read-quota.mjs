// Read account quota without a model request. Authentication remains owned by Codex CLI.
import { withAppServer } from '../lib/app-server-client.js';
const response=await withAppServer(c=>c.request('account/rateLimits/read'));
const buckets=response.rateLimitsByLimitId || {codex:response.rateLimits};
const windows=[];
for(const [bucket,value]of Object.entries(buckets))for(const kind of ['primary','secondary']){
 const window=value?.[kind];if(!window)continue;
 windows.push({bucket,kind,usedPercent:window.usedPercent,windowDurationMins:window.windowDurationMins,resetsAt:window.resetsAt,
   resetLocal:typeof window.resetsAt==='number'?new Date(window.resetsAt*1000).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):null});
}
console.log(JSON.stringify({sampledAt:new Date().toISOString(),windows},null,2));
