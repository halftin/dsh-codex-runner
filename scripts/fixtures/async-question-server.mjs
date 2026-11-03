import readline from 'node:readline';
const send=m=>console.log(JSON.stringify(m));
let turnId='turn-1',count=0,mode,answers=[];
const threadId='async-thread',notify=(method,params)=>send({method,params:{threadId,turnId,...params}});
const finish=()=>{notify('item/completed',{item:{id:'final',type:'agentMessage',phase:'final_answer',text:JSON.stringify(answers)}});notify('turn/completed',{turn:{id:turnId,status:'completed'}});};
const reply=text=>{answers.push(...JSON.parse(text.replace(/^<send_user_message_question_reply>|<\/send_user_message_question_reply>$/g,'')));};
for await(const line of readline.createInterface({input:process.stdin})){
  const m=JSON.parse(line),p=m.params||{};
  if(m.method==='initialize')send({id:m.id,result:{}});
  else if(m.method==='model/list')send({id:m.id,result:{data:[{id:'fixture',supportedReasoningEfforts:[{reasoningEffort:'low'}]}]}});
  else if(m.method==='thread/start')send({id:m.id,result:{thread:{id:threadId}}});
  else if(m.method==='turn/start'){
    turnId='turn-'+(++count);notify('turn/started',{turn:{id:turnId}});send({id:m.id,result:{turn:{id:turnId}}});
    if(count>1){reply(p.input[0].text);finish();continue;}
    mode=p.input[0].text;
    for(const id of ['first','second']){
      const item={id,type:'agentMessage',delivery:'async',questions:[{title:'Which '+id+'?',options:['A','B']},{title:'Free text '+id+'?'}]};
      notify('item/started',{item});notify('item/completed',{item});
    }
    notify('item/agentMessage/delta',{itemId:'progress',delta:'CONTINUED_BEFORE_ANSWER'});
    if(mode==='next')finish();
    if(mode==='disconnect')setTimeout(()=>process.exit(1),400);
  }else if(m.method==='turn/steer'){
    if(mode==='race') {finish();send({id:m.id,error:{code:-32600,message:'No active turn'}});}
    else {reply(p.input[0].text);send({id:m.id,result:{turnId}});if(answers.length===4)finish();}
  }else if(m.method==='turn/interrupt'){send({id:m.id,result:{}});notify('turn/completed',{turn:{id:turnId,status:'interrupted'}});}
}
