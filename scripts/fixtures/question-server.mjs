import readline from 'node:readline';
const send=value=>console.log(JSON.stringify(value));
const threadId='question-thread',turnId='question-turn';
const notify=(method,params)=>send({method,params:{threadId,turnId,...params}});
let mode,answered=[],timer;
const finish=text=>{clearInterval(timer);notify('item/completed',{item:{id:'final',type:'agentMessage',phase:'final_answer',text}});notify('turn/completed',{turn:{id:turnId,status:'completed'}});};
for await(const line of readline.createInterface({input:process.stdin})) {
  const m=JSON.parse(line),p=m.params||{};
  if(m.method==='initialize')send({id:m.id,result:{}});
  else if(m.method==='model/list')send({id:m.id,result:{data:[{id:'fixture',supportedReasoningEfforts:[{reasoningEffort:'low'}]}]}});
  else if(m.method==='thread/start')send({id:m.id,result:{thread:{id:threadId}}});
  else if(m.method==='turn/start') {
    mode=p.input[0].text;notify('turn/started',{turn:{id:turnId}});send({id:m.id,result:{turn:{id:turnId}}});
    if(mode==='approval'){send({id:'approval',method:'item/commandExecution/requestApproval',params:{threadId,turnId,itemId:'cmd'}});continue;}
    send({id:41,method:'item/tool/requestUserInput',params:{threadId,turnId,itemId:'ask-1',isBlocking:mode!=='async',autoResolutionMs:1,
      questions:[{id:'color',header:'Color',question:'Choose a color',isOther:true,options:[{label:'Blue',description:'cool'},{label:'Green',description:'natural'}]},
        {id:'name',header:'Name',question:'Name it',options:null}]}});
    let count=0;timer=setInterval(()=>notify('item/agentMessage/delta',{itemId:'progress',delta:'progress '+(++count)}),30);
    if(mode==='multiple')send({id:'second',method:'item/tool/requestUserInput',params:{threadId,turnId,itemId:'ask-2',isBlocking:false,questions:[{id:'second',header:'Second',question:'Another answer?'}]}});
    if(mode==='resolve')setTimeout(()=>{notify('serverRequest/resolved',{requestId:41});finish('expired');},220);
    if(mode==='disconnect')setTimeout(()=>process.exit(1),220);
  } else if(m.method==='turn/interrupt') {send({id:m.id,result:{}});clearInterval(timer);notify('turn/completed',{turn:{id:turnId,status:'interrupted'}});}
  else if(m.id===41||m.id==='second') {
    answered.push(m);notify('serverRequest/resolved',{requestId:m.id});
    if(mode!=='multiple'||answered.length===2)finish(JSON.stringify(answered));
  } else if(m.id==='approval')finish(m.error?'approval denied':'unsafe approval');
}
