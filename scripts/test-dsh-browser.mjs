// Optional companion to test-dsh-package: real Web UI, real owner connection,
// native settings persistence. Chromium is isolated and headless throughout.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';

export async function verifyBrowser({ctx,root,prepareOutput}) {
  const candidates=[process.env.CHROME_PATH,...[process.env.ProgramFiles,process.env['ProgramFiles(x86)'],process.env.LOCALAPPDATA].filter(Boolean).map(dir=>path.join(dir,'Google','Chrome','Application','chrome.exe'))];
  const chrome=candidates.find(file=>file&&fs.existsSync(file));assert.ok(chrome,'Set CHROME_PATH to a Chromium executable for browser acceptance');
  const profile=path.join(root,'browser'),proc=spawn(chrome,['--headless','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
  let port,socket;
  try {
    for(let i=0;i<100;i++){try{port=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];break;}catch{await new Promise(r=>setTimeout(r,100));}}
    assert.ok(port,'Headless browser must start');
    const tabs=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();
    socket=new WebSocket(tabs.find(tab=>tab.type==='page').webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
    let id=0;const pending=new Map();socket.onmessage=event=>{const message=JSON.parse(event.data);if(message.id){const next=pending.get(message.id);pending.delete(message.id);message.error?next.reject(Error(JSON.stringify(message.error))):next.resolve(message.result);}};
    const call=(method,params={})=>new Promise((resolve,reject)=>{const next=++id;pending.set(next,{resolve,reject});socket.send(JSON.stringify({id:next,method,params}));});
    const evaluate=async expression=>{const result=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value;};
    const wait=async(expression,label)=>{for(let i=0;i<100;i++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,100));}throw Error('Browser timeout: '+label);};
    const frame=()=>evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    const click=async expression=>{
      await evaluate(expression+".scrollIntoView({block:'center'})");await frame();
      const position=`(()=>{const el=${expression},r=el.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return el.contains(document.elementFromPoint(x,y))?{x,y}:null})()`;
      try{await wait('!!'+position,'uncovered click target');}catch(error){error.message+=' '+JSON.stringify(await evaluate(`(()=>{const el=${expression},r=el.getBoundingClientRect(),top=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return {target:el.outerHTML.slice(0,400),rect:{x:r.x,y:r.y,width:r.width,height:r.height},top:top?.outerHTML.slice(0,400)}})()`));throw error;}const point=await evaluate(position);
      for(const type of ['mousePressed','mouseReleased'])await call('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point});await frame();
    };
    const button=(labels,scope='document')=>`[...${scope}.querySelectorAll('button,a')].find(n=>${JSON.stringify(labels)}.includes(n.textContent.trim())&&n.getBoundingClientRect().width>0&&n.getBoundingClientRect().height>0)`;
    const fill=async(selector,value)=>{await evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}))})()`);await frame();};
    const snapshot=async name=>{const shot=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(root,name+'.png'),Buffer.from(shot.data,'base64'));};
    try {
      await call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
      const url=ctx.get('connection').authenticatedUrl(ctx.get('webApp').getAdvertisedUrl());
      await call('Page.navigate',{url});
      const plugins=button(['Plugins','插件']);await wait('!!('+plugins+')','Plugins navigation');
      const welcome=button(['继续','Continue']);
      for(let i=0;i<20;i++){if(await evaluate('!!('+welcome+')')){await click(welcome);break;}await new Promise(r=>setTimeout(r,100));}
      await click(plugins);
      const entry="[...document.querySelectorAll('*')].find(n=>n.children.length===0&&n.textContent.trim()==='dsh-codex-runner'&&n.getBoundingClientRect().width>0)";
      await wait('!!('+entry+')','installed plugin entry');
      await click(entry);
      await wait("!!document.querySelector('[data-section=advanced]')",'native plugin settings');
      assert.equal((await ctx.get('tools').get('codex_config').execute({})).settings.autoModelAndEffort,false);
      await wait("!!document.querySelector('[data-section=policy]')",'selection policy remains visible with automatic completion off');
      const stream="document.querySelector('[aria-label=\"流式实时显示 Codex 输出\"],[aria-label=\"Stream Codex output live\"]')";
      const supervise="document.querySelector('[aria-label=\"DSH 主动监督 Codex 执行\"],[aria-label=\"Let DSH supervise Codex\"]')";
      await wait('!!('+stream+')&&!!('+supervise+')','streaming switches');
      await click(stream);await click(supervise);
      const saveSwitches="document.querySelector('[data-codex-runner-savebar] button')";
      await wait('!'+saveSwitches+'.disabled','streaming preferences dirty');await click(saveSwitches);
      for(let i=0;i<60;i++){if((await ctx.get('tools').get('codex_config').execute({})).settings.supervisionEnabled===true)break;await new Promise(r=>setTimeout(r,100));}
      const enabled=(await ctx.get('tools').get('codex_config').execute({})).settings;
      assert.equal(enabled.streamOutputEnabled,true);assert.equal(enabled.supervisionEnabled,true);
      const polling="document.querySelector('[aria-label=\"定时查询 Codex 状态\"],[aria-label=\"Query Codex status periodically\"]')";
      const interval="document.querySelector('[aria-label=\"查询间隔（分钟）\"],[aria-label=\"Query interval (minutes)\"]')";
      await wait(polling+'.disabled&&'+interval+'.disabled','streaming disables polling controls');

      await wait(saveSwitches+'.disabled&&!'+stream+'.disabled','saved form settled before keyboard input');await frame();
      await evaluate(stream+'.focus()');
      await wait('document.activeElement==='+stream,'keyboard focus on switch');
      for(const type of ['keyDown','keyUp'])await call('Input.dispatchKeyEvent',{type,key:' ',code:'Space',windowsVirtualKeyCode:32});
      await frame();await wait('!'+saveSwitches+'.disabled','keyboard switch edit');await click(saveSwitches);
      for(let i=0;i<60;i++){if((await ctx.get('tools').get('codex_config').execute({})).settings.streamOutputEnabled===false)break;await new Promise(r=>setTimeout(r,100));}
      assert.equal((await ctx.get('tools').get('codex_config').execute({})).settings.streamOutputEnabled,false);
      await wait(polling+'.disabled&&'+interval+'.disabled','supervision alone disables polling');
      await wait(saveSwitches+'.disabled&&!'+supervise+'.disabled','saved form settled');
      await click(supervise);await wait('!'+polling+'.disabled','both off reenable polling');
      await click(polling);await wait('!'+interval+'.disabled','enabled polling permits interval editing');
      await click(supervise);await wait(polling+'.disabled&&'+interval+'.disabled','draft supervision immediately disables polling');
      await click(saveSwitches);await wait(saveSwitches+'.disabled&&!'+supervise+'.disabled','save preserved polling setting');
      assert.equal((await ctx.get('tools').get('codex_config').execute({})).settings.statusPollingEnabled,true);

      for(const width of [1280,375])for(const theme of ['light','dark']){
        await call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
        await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:theme}]});
        await evaluate(stream+".scrollIntoView({block:'center'})");await frame();
        assert.ok(await evaluate(`(()=>{const r=${stream}.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth})()`),'Switch must fit viewport');
        await snapshot('stream-settings-'+width+'-'+theme);
      }
      await call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
      await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'light'}]});
      await evaluate("document.querySelector('[data-section=advanced]').open=true");await frame();
      await fill('input[name=retentionDays]','90');
      const save="document.querySelector('[data-codex-runner-savebar] button')";
      await wait('!'+save+'.disabled','dirty settings');await click(save);
      for(let i=0;i<60;i++){if((await ctx.get('tools').get('codex_config').execute({})).settings.retentionDays===90)break;await new Promise(r=>setTimeout(r,100));}
      assert.equal((await ctx.get('tools').get('codex_config').execute({})).settings.retentionDays,90,'Native UI Save must update runtime settings');
      const edit=button(['编辑完整配置与注册表','Edit full configuration and registry']);await click(edit);
      await wait("document.querySelectorAll('[data-editor-row^=\"registry:\"]').length===21",'loaded registry editor');
      const dialog="[...document.querySelectorAll('[role=dialog]')].find(n=>['编辑完整配置与注册表','Edit full configuration and registry'].includes(n.getAttribute('aria-label')))";
      await click(button(['配置 JSON','Configuration JSON'],dialog));
      await wait("!!document.querySelector('[role=dialog] [role=tabpanel] textarea')",'configuration JSON');
      const config=JSON.parse(await evaluate("document.querySelector('[role=dialog] [role=tabpanel] textarea').value"));
      assert.equal(config.streamOutputEnabled,false);assert.equal(config.supervisionEnabled,true);
      assert.equal(config.retentionDays,90);config.retentionMaxRuns=321;
      await fill('[role=dialog] [role=tabpanel] textarea',JSON.stringify(config,null,2));
      await click(button(['表格','Table'],dialog));
      assert.equal(await evaluate("document.querySelector('[data-editor-row=\"config:retentionMaxRuns\"] textarea').value"),'321','JSON changes must synchronize to the table');
      await click(button(['保存','Save'],dialog));await wait('!('+dialog+')','saved configuration');
      assert.equal((await ctx.get('tools').get('codex_config').execute({})).settings.retentionMaxRuns,321);
      await click(edit);await wait("document.querySelectorAll('[data-editor-row^=\"registry:\"]').length===21",'reopened editor');
      await click(button(['注册表 JSON','Registry JSON'],dialog));
      const registry=JSON.parse(await evaluate("document.querySelector('[role=dialog] [role=tabpanel] textarea').value"));
      registry.translations.settings.log_dir.description='浏览器保存验收';
      await fill('[role=dialog] [role=tabpanel] textarea',JSON.stringify(registry,null,2));
      await click(button(['保存','Save'],dialog));await wait('!('+dialog+')','saved registry');
      assert.equal((await ctx.get('codexRunner').getEditorRegistry()).document.translations.settings.log_dir.description,'浏览器保存验收');
      await click(edit);await wait("document.querySelectorAll('[data-editor-row^=\"registry:\"]').length===21",'final editor');
      for(const width of [1280,375]){
        await call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await frame();
        assert.ok(await evaluate("(()=>{const r=document.querySelector('[role=dialog]').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()"),'Editor must fit the viewport');
        await snapshot('web-settings-'+width);
      }
      if(prepareOutput) for(const backend of ['app-server','exec']) {
        const probe=await prepareOutput(backend);
        try {
          await call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
          await call('Page.navigate',{url});
          const session="[...document.querySelectorAll('*')].find(n=>n.children.length===0&&n.textContent.trim()==="+JSON.stringify(probe.title)+"&&n.getBoundingClientRect().width>0)";
          await wait('!!('+session+')','streaming session in sidebar');await click(session);
          const card='document.querySelector('+JSON.stringify('[data-codex-output="'+probe.callId+'"]')+')';
          await wait('!!('+card+')&&'+card+".textContent.includes('Live 中文')",'live native tool card');
          const before=await evaluate(card+'.textContent');await new Promise(r=>setTimeout(r,1500));
          assert.notEqual(await evaluate(card+'.textContent'),before,'Output must update before completion');probe.assertPassive();
          assert.equal(await evaluate(card+".querySelector('script')!==null"),false);
          await wait(card+".textContent.includes('SPECIAL_WIDGET')&&"+card+".textContent.includes('SPECIAL_LARGE')",'special content fallback');
          for(const marker of ['SPECIAL_MARKDOWN','SPECIAL_IMAGE','SPECIAL_AUDIO','SPECIAL_FILE'])assert.ok((await evaluate(card+'.textContent')).includes(marker));
          assert.equal(await evaluate(card+".querySelector('iframe,img,audio,video,script')!==null"),false,'Unknown content must not execute or fetch media');
          assert.equal(await evaluate('globalThis.RUNNER_UNSAFE===true'),false);
          const downloadDir=path.join(root,'downloads-'+backend);fs.mkdirSync(downloadDir);
          await call('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloadDir});
          const download=button(['下载完整记录','Download full record'],card);await click(download);
          let downloaded;
          for(let i=0;i<100;i++){downloaded=fs.readdirSync(downloadDir).find(name=>name.endsWith('.json'));if(downloaded)break;await new Promise(r=>setTimeout(r,100));}
          assert.ok(downloaded,'Full payload must download through the actual browser/owner connection');
          assert.deepEqual(fs.readFileSync(path.join(downloadDir,downloaded)),probe.fullResource,'Downloaded bytes must equal the complete original payload');
          for(const width of [1280,375])for(const theme of ['light','dark']) {
            await call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
            await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:theme}]});await frame();
            assert.ok(await evaluate(`(()=>{const r=${card}.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth})()`));await snapshot('output-'+backend+'-'+width+'-'+theme);
          }
          await probe.set(false);await wait('!'+card+".textContent.includes('Live 中文')",'disable live output');probe.assertPassive();
          await probe.set(true);await wait(card+".textContent.includes('Live 中文')",'reenable live output');
          await call('Page.reload');await wait('!!('+card+')&&'+card+".textContent.includes('Live 中文')",'reopen output and catch up');probe.assertPassive();
        } finally {await probe.close();}
      }
      await call('Browser.close');
    }catch(error){await snapshot('browser-failure').catch(()=>{});fs.writeFileSync(path.join(root,'browser-failure.txt'),await evaluate('document.body.innerText').catch(()=>''));await call('Browser.close').catch(()=>{});throw error;}
  } finally {socket?.close();proc.unref();}
}
