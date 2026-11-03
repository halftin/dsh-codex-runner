// Keep the two output transport descriptions structurally identical.
import fs from 'node:fs';
const object=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
const integer=(minimum=0,maximum=Number.MAX_SAFE_INTEGER)=>({type:'integer',minimum,maximum});
const string={type:'string'},boolean={type:'boolean'},ref=name=>({$ref:'#/components/schemas/'+name});
const id='11111111-1111-4111-8111-111111111111';
for(const english of [false,true]){
  const file=new URL('../docs/api/openapi'+(english?'.en':'')+'.json',import.meta.url),spec=JSON.parse(fs.readFileSync(file));
  spec.info.description=spec.info.description.replace('15','19');
  const tag=english?'Live output':'实时输出';
  if(!spec.tags.some(t=>t.name===tag))spec.tags.push({name:tag,description:english?'Read stored output without invoking a model':'读取已保存输出，不调用模型'});
  const schemas=spec.components.schemas;
  schemas.OutputPayload=object({sessionId:string,callId:{type:'string',minLength:1,maxLength:512},after:integer(),limit:integer(1,200)},['sessionId','callId']);
  schemas.OutputResourcePayload=object({sessionId:string,callId:{type:'string',minLength:1,maxLength:512},sequence:integer(1),offset:integer(),limit:integer(1,65536)},['sessionId','callId','sequence']);
  schemas.OutputEvent={type:'object',required:['version','runId','sequence','backend','method','receivedAt'],properties:{version:{type:'integer',enum:[1]},runId:ref('RpcId'),sequence:integer(1),backend:{type:'string',enum:['exec','app-server']},method:string,receivedAt:{type:'string',format:'date-time'},threadId:{type:'string',nullable:true},turnId:{type:'string',nullable:true},itemId:{type:'string',nullable:true},params:{},payload:{type:'object',required:['resource','bytes','sha256','complete','preview','previewTruncated'],properties:{resource:string,bytes:integer(),sha256:string,complete:boolean,preview:string,previewTruncated:boolean}}}};
  schemas.OutputView=object({status:{type:'string',enum:['ok','unavailable','disabled']},run_id:ref('RpcId'),events:{type:'array',maxItems:200,items:ref('OutputEvent')},next_cursor:integer(),has_more:boolean,latest_cursor:integer(),gap:{},truncated:boolean,diagnostic:{type:'string',nullable:true},backend:{type:'string',enum:['exec','app-server']},execution_status:string,mobile:{type:'string',enum:['unverified']}},['status','run_id','events','next_cursor','has_more']);
  schemas.OutputResourceView=object({encoding:{type:'string',enum:['base64']},data:{type:'string',format:'byte'},offset:integer(),next_offset:integer(),bytes:integer(),has_more:boolean,sha256:{type:'string',pattern:'^[a-f0-9]{64}$'}});
  for(const resource of [false,true]){
    const method=resource?'getOutputResource':'getOutput',prefix=resource?'GetOutputResource':'GetOutput',payload=resource?'OutputResourcePayload':'OutputPayload',view=resource?'OutputResourceView':'OutputView';
    const request=structuredClone(schemas.GetSubagentsRequest);request.properties.method.enum=['codex-runner/'+method];request.properties.payload=ref(payload);schemas[prefix+'Request']=request;
    const response=structuredClone(schemas.GetSubagentsResponse);response.properties.result.oneOf[0].properties.value=ref(view);schemas[prefix+'Response']=response;
    const op=structuredClone(spec.paths['/api/codex-runner/getSubagents'].post);op.tags=[tag];op.operationId=method;
    op.summary=english?(resource?'Read a complete output resource in byte chunks':'Read output for an exact session tool call'):(resource?'按字节分块读取完整输出资源':'读取精确会话工具调用的增量输出');
    op.description=english?'Owner access is required. sessionId and callId must identify exactly one run in that live session workspace. Display uses an independent cursor and never invokes the model. Reopening starts at zero. Disabled display returns disabled for output and rejects resources. Large events keep full JSON in a named resource; a preview is incomplete. Resource chunks are base64 bytes: concatenate before UTF-8 decoding. The checksum covers the complete resource. Mobile display remains unverified.':'需要 owner 权限。sessionId 与 callId 必须对应活动会话工作区内唯一运行。显示游标独立，不唤醒模型，重开从零补读。关闭显示时输出返回 disabled，资源读取拒绝。大事件保留完整 JSON 资源，预览不完整；资源按字节返回 base64，拼接后再解码 UTF-8，校验和对应完整资源。手机显示尚未验收。';
    const req=op.requestBody.content['application/json'];req.schema=ref(prefix+'Request');req.example={type:'client-request',rpcId:id,method:'codex-runner/'+method,payload:{sessionId:id,callId:'call_example',...(resource?{sequence:1,offset:0,limit:32768}:{after:0,limit:100})}};
    const res=op.responses['200'].content['application/json'];res.schema=ref(prefix+'Response');
    res.examples.success.value.result.value=resource?{encoding:'base64',data:'e30=',offset:0,next_offset:2,bytes:2,has_more:false,sha256:'44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a'}:{status:'ok',run_id:id,events:[],next_cursor:0,has_more:false,latest_cursor:0,gap:null,truncated:false,diagnostic:null,backend:'app-server',execution_status:'running',mobile:'unverified'};
    spec.paths['/api/codex-runner/'+method]={post:op};
  }
  fs.writeFileSync(file,JSON.stringify(spec,null,2)+'\n');
}
