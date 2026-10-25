import { validRunId } from './run-store.js';
// Dedicated authenticated owner Connection channel. Registry edits use fixed
// files with validation/revision checks; plugin settings still use configForms.
export function registerRunnerRpc(ctx,service) {
  // Exact Fetch routes are the carrier-neutral Connection extension point.
  // Connection authenticates them and permits owner peers only, before fetch().
  ctx.inject(['connection'],scope=>{
    if(typeof scope.connection.fetch?.register!=='function')return;
    for(const method of ['getCatalog','refreshCatalog','getQuota','getSubagents','getEditorRegistry','saveEditorRegistry']) {
      scope.effect(()=>scope.connection.fetch.register({
        path:'/api/codex-runner/'+method,methods:['POST'],requestBody:'buffered',
        fetch:async request=>{
          if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')return new Response('Expected JSON',{status:415});
          const text=await request.text();if(text.length>(method==='saveEditorRegistry'?1048576:16384))return new Response('Request too large',{status:413});
          let message;try{message=JSON.parse(text);}catch{return new Response('Invalid JSON',{status:400});}
          if(!message||message.type!=='client-request'||!validRunId(message.rpcId)||message.method!=='codex-runner/'+method
            ||Object.keys(message).some(key=>!['type','rpcId','method','payload'].includes(key)))return new Response('Invalid request envelope',{status:400});
          const result=await readRequest(service,method,message.payload,request.signal,{principal:{kind:'owner'}});
          return Response.json({type:'server-response',rpcId:message.rpcId,result});
        },
      }),'codex-runner: shared API '+method);
    }
  });
  ctx.inject(['connection','webServer'],scope=>{
    if(typeof scope.connection?.rpc?.handle!=='function')return;
    if(scope.connection.fetch?.register&&service.runEventStream)scope.effect(()=>scope.connection.fetch.register({path:'/api/codex-runner/run-events',methods:['GET'],requestBody:'buffered',fetch:request=>Promise.resolve(service.runEventStream(request.signal))}),'codex-runner: authenticated run events');
    scope.effect(()=>scope.connection.rpc.handle('/codex-runner',(method,args,signal,peer)=>readRequest(service,method,args,signal,peer)), 'codex-runner: read-only RPC');
  });
}
async function readRequest(service,method,args={},signal,peer) {
      try {
        if(peer?.principal?.kind!=='owner')throw Error('Owner access required');
        if(signal?.aborted)throw Error('Request aborted');
        const allowed={getCatalog:['refresh'],refreshCatalog:[],getQuota:['probe','timeoutMs','refresh'],getSubagents:['runId'],getEditorRegistry:['refresh'],saveEditorRegistry:['document','revision','preview']};
        if(!Object.hasOwn(allowed,method) || typeof args!=='object' || args===null || Array.isArray(args)
          || Object.keys(args).some(key=>!allowed[method].includes(key)))throw Error('Invalid read-only service request');
        if(args.refresh!==undefined && typeof args.refresh!=='boolean')throw Error('Invalid refresh');
        if(method==='getQuota' && ((args.probe!==undefined&&!['none','fresh','active','both'].includes(args.probe)) || (args.timeoutMs!==undefined&&(!Number.isInteger(args.timeoutMs)||args.timeoutMs<1||args.timeoutMs>60000)) || (args.refresh!==undefined&&typeof args.refresh!=='boolean')))throw Error('Invalid quota request');
        if(method==='getSubagents'&&!validRunId(args.runId))throw Error('Invalid runId');
        if(method==='saveEditorRegistry'&&(typeof args.revision!=='string'||!args.document||(args.preview!==undefined&&typeof args.preview!=='boolean')))throw Error('Invalid registry editor request');
        return {ok:true,value:await service[method](method==='getSubagents'?args.runId:args)};
      } catch(error) {return {ok:false,error:{code:'codex-runner/request',message:String(error.message),details:{}}};}
}
