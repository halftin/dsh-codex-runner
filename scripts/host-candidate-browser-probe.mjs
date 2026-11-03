// Real candidate installation, real DSH Web and Chromium. Model transports are fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';

export async function verifyBrowser({ctx,root,prepareOutput}) {
  const chrome=[process.env.CHROME_PATH,...[process.env.ProgramFiles,process.env['ProgramFiles(x86)'],process.env.LOCALAPPDATA].filter(Boolean).map(dir=>path.join(dir,'Google/Chrome/Application/chrome.exe'))].find(file=>file&&fs.existsSync(file));
  assert.ok(chrome,'Chrome required');const profile=path.join(root,'candidate-browser');
  const proc=spawn(chrome,['--headless','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
  const pause=ms=>new Promise(r=>setTimeout(r,ms)),results=[],errors=[];let socket,call,evaluate;
  const service=ctx.get('codexRunner'),originalRead=service.getOutput,reads=new Map();
  service.getOutput=function(args){reads.set(args.callId,(reads.get(args.callId)||0)+1);return originalRead.call(this,args);};
  try{
    let port;for(let n=0;n<100;n++){try{port=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];break;}catch{await pause(100);}}
    assert.ok(port,'Browser startup');const tabs=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();
    socket=new WebSocket(tabs.find(tab=>tab.type==='page').webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
    let id=0;const pending=new Map();socket.onmessage=event=>{const m=JSON.parse(event.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails);};
    call=(method,params={})=>new Promise((resolve,reject)=>{const next=++id;pending.set(next,{resolve,reject});socket.send(JSON.stringify({id:next,method,params}));});
    evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
    const wait=async(expression,label)=>{for(let n=0;n<200;n++){if(await evaluate(expression))return;await pause(100);}throw Error('Browser timeout: '+label);};
    await call('Runtime.enable');await call('Network.enable');await call('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    const url=ctx.get('connection').authenticatedUrl(ctx.get('webApp').getAdvertisedUrl());
    for(const backend of ['app-server','exec']){
      const probe=await prepareOutput(backend);
      try{
        await call('Page.navigate',{url});
        const welcome="[...document.querySelectorAll('button')].find(n=>['继续','Continue'].includes(n.textContent.trim()))";
        for(let n=0;n<20;n++){if(await evaluate('!!('+welcome+')')){await evaluate(welcome+'.click()');break;}await pause(100);}
        const session="[...document.querySelectorAll('*')].find(n=>n.children.length===0&&n.textContent.trim()==="+JSON.stringify(probe.title)+"&&n.getBoundingClientRect().width>0)";
        await wait('!!('+session+')','session sidebar');await evaluate(session+'.click()');
        const selector='[data-codex-item^="'+probe.runId+':"]',text='[...document.querySelectorAll('+JSON.stringify(selector)+')].map(n=>n.textContent).join("\\n")';
        await wait(text+'.includes("Live 中文")','independent message records');probe.assertPassive();
        const before=await evaluate(text);await wait(text+'!=='+JSON.stringify(before),'live record updates');
        assert.equal(await evaluate('document.querySelectorAll('+JSON.stringify(selector+' script, '+selector+' iframe')+').length'),0);
        await probe.set(false);await wait('document.querySelectorAll('+JSON.stringify(selector)+').length===0','committed display setting hides existing records');
        await probe.set(true);await wait(text+'.includes("Live 中文")','display enabled catches up');probe.assertPassive();
        await call('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});await pause(1500);
        const captured=originalRead.call(service,{sessionId:probe.sessionId,callId:probe.callId,runId:probe.runId,after:0,limit:200});
        const marker=captured.events.map(e=>e.params?.item?.text).filter(t=>t?.startsWith('Live 中文')).at(-1);assert.ok(marker);
        await call('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});
        await wait(text+'.includes('+JSON.stringify(marker)+')','reconnect catches missed records');probe.assertPassive();
        await probe.finish();await wait(text+'.includes('+JSON.stringify('SMOKE_FINAL_'+backend)+')','final answer');
        await pause(1500);const count=reads.get(probe.callId);await pause(2500);assert.equal(reads.get(probe.callId),count,'Terminal records must stop polling');
        const identities=await evaluate('[...document.querySelectorAll('+JSON.stringify(selector)+')].map(n=>n.dataset.codexItem)');assert.equal(new Set(identities).size,identities.length);
        await probe.set(false);await wait('document.querySelectorAll('+JSON.stringify(selector)+').length===0','terminal display off');
        await probe.set(true);await wait(text+'.includes('+JSON.stringify('SMOKE_FINAL_'+backend)+')','terminal display on');
        await call('Page.reload');await wait(text+'.includes('+JSON.stringify('SMOKE_FINAL_'+backend)+')','reload restores final answer');
        fs.writeFileSync(path.join(root,'candidate-'+backend+'.png'),Buffer.from((await call('Page.captureScreenshot',{format:'png'})).data,'base64'));
        results.push({backend,independentRecords:true,liveUpdates:true,displayToggle:true,reconnectCatchup:true,finalAnswer:true,terminalIdle:true,uniqueRecords:true,reload:true});
        console.log('PASS candidate browser '+backend);
      }finally{await probe.close();}
    }
    assert.equal(errors.length,0,JSON.stringify(errors));fs.writeFileSync(path.join(root,'candidate-browser.json'),JSON.stringify({classification:'real-DSH-Web/real-Chromium/deterministic-models',results,browserErrors:errors,realModelCalls:0},null,2));
  }catch(error){if(call)try{fs.writeFileSync(path.join(root,'candidate-browser-failure.png'),Buffer.from((await call('Page.captureScreenshot',{format:'png'})).data,'base64'));fs.writeFileSync(path.join(root,'candidate-browser-failure.txt'),await evaluate('document.body.innerText'));}catch{}throw error;
  }finally{service.getOutput=originalRead;if(call)await call('Browser.close').catch(()=>{});socket?.close();proc.unref();}
}
