const LIMIT=32,TRACK_LIMIT=512;
const clean=value=>typeof value==='string'?value.slice(0,200):null;
function statusOf(value) {
  const status=String(typeof value==='object'&&value?value.status||value.type||'':value||'').replace(/[_-]/g,'').toLowerCase();
  if(['running','inprogress','pending','spawned','initializing'].includes(status))return 'running';
  if(['completed','done','closed','shutdown'].includes(status))return 'completed';
  if(['failed','error','errored','interrupted'].includes(status))return 'failed';
  return 'unknown';
}
export function createSubagentTracker() {
  const agents=new Map();let truncated=false;
  function update(id,status,item) {
    id=clean(id);if(!id)return;
    if(!agents.has(id)&&agents.size>=TRACK_LIMIT){truncated=true;return;}
    const prior=agents.get(id);
    // A parent tool-call completion is not evidence of child completion.
    agents.set(id,{id,status:status==='unknown'&&prior?prior.status:status,tool:clean(item?.tool)||prior?.tool||null,updated_at:new Date().toISOString()});
  }
  function observe(item) {
    if(!item||typeof item!=='object')return;
    const type=String(item.type||'').replace(/[_-]/g,'').toLowerCase();
    if(!['collabagenttoolcall','collabagenttoolcallthreaditem','subagentactivity','subagentactivitythreaditem'].includes(type))return;
    const states=item.agentsStates||item.agentStates||{};
    if(states&&typeof states==='object'&&!Array.isArray(states)) {
      const entries=Object.entries(states);if(entries.length>TRACK_LIMIT)truncated=true;
      for(const [id,state] of entries.slice(0,TRACK_LIMIT))update(id,statusOf(state),item);
    }
    if(type.startsWith('subagentactivity')) {
      const id=item.agentId||item.subAgentId||item.childThreadId||item.threadId||item.id;
      update(id,statusOf(item.status||item.activity?.status),item);
    } else {
      for(const id of (Array.isArray(item.receiverThreadIds)?item.receiverThreadIds:[]).slice(0,TRACK_LIMIT))
        if(!Object.hasOwn(states||{},id))update(id,'unknown',item);
    }
  }
  function snapshot() {
    const items=[...agents.values()];
    return {count:items.length,running:items.filter(i=>i.status==='running').length,completed:items.filter(i=>i.status==='completed').length,
      failed:items.filter(i=>i.status==='failed').length,unknown:items.filter(i=>i.status==='unknown').length,truncated:truncated||items.length>LIMIT,items:items.slice(-LIMIT)};
  }
  return {observe,snapshot};
}
export function boundedSubagents(value) {
  const count=key=>Number.isSafeInteger(value?.[key])&&value[key]>=0?value[key]:0;
  return {count:count('count'),running:count('running'),completed:count('completed'),failed:count('failed'),unknown:count('unknown'),
    truncated:value?.truncated===true||(value?.items?.length||0)>LIMIT,items:Array.isArray(value?.items)?value.items.slice(-LIMIT).map(item=>({id:clean(item?.id),status:['running','completed','failed','unknown'].includes(item?.status)?item.status:'unknown',tool:clean(item?.tool),updated_at:clean(item?.updated_at)})):[]};
}
