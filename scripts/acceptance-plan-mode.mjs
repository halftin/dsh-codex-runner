// Opt-in live acceptance only. Imported by the installed driver's Node process.
// Plan mode enables the actual native blocking tool; answers are never fabricated.
import fs from 'node:fs';
if (!process.env.DSH_ACCEPT_CLIENT_URL || !process.env.DSH_ACCEPT_WIRE_LOG) throw Error('Missing acceptance context');
const {AppServerClient}=await import(process.env.DSH_ACCEPT_CLIENT_URL);
const record=value=>fs.appendFileSync(process.env.DSH_ACCEPT_WIRE_LOG,JSON.stringify(value)+'\n');
const request=AppServerClient.prototype.request;
AppServerClient.prototype.request=function(method,params,timeout){
  if(method==='turn/start'){
    params={...params,collaborationMode:{mode:'plan',settings:{model:'gpt-6.1-sol',reasoning_effort:'low'}}};
    record({kind:'plan-override',method});
  }
  return request.call(this,method,params,timeout);
};
const defer=AppServerClient.prototype.deferRequest;
AppServerClient.prototype.deferRequest=function(message){
  const context=defer.call(this,message),respond=context.respond;
  record({kind:'server-request',message,connectionId:context.connectionId});
  context.respond=async value=>{
    const receipt=await respond(value);
    record({kind:'original-response',id:context.id,connectionId:context.connectionId,value,receipt});
    return receipt;
  };
  return context;
};
