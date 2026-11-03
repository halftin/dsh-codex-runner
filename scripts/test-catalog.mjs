import './offline-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fetchCatalog, createCatalogStore, normalizeModels, FALLBACK_CATALOG, validateCatalogSelection, catalogTools } from '../lib/model-catalog.js';
import { registerRunnerRpc } from '../lib/runner-service.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'runner-catalog-'));
const row=(id,extra={})=>({id,displayName:id,description:'English source',supportedReasoningEfforts:[{reasoningEffort:'high',description:'Think'}],serviceTiers:[{id:'priority',name:'Fast'}],...extra});
const account={account:{type:'chatgpt',email:'catalog@example.invalid'}};
let pass=0;async function test(name,fn){await fn();console.log('PASS '+name);pass++;}
await test('pagination normalization and hidden data use model/list only, never a turn',async()=>{
  const calls=[];
  const view=await fetchCatalog({connect:async fn=>fn({request:async(method,args)=>{
    calls.push([method,args]);if(method==='account/read')return account;
    return args.cursor?{data:[row('new-model',{hidden:true})]}:{data:[row('first')],nextCursor:'next'};
  }})});
  assert.equal(view.models.length,2);assert.equal(view.models[1].hidden,true);
  assert.deepEqual(view.models[0].efforts,[{id:'high',description:'Think'}]);
  assert.equal(calls[1][1].cursor,'next');assert.ok(calls.every(([m])=>['model/list','account/read'].includes(m)));
  assert.match(view.accountFingerprint,/^[a-f0-9]{64}$/);
});
await test('empty, malformed and repeated-cursor catalogs reject',async()=>{
  assert.throws(()=>normalizeModels([]),/Empty/);assert.throws(()=>normalizeModels([row('../bad')]),/Invalid/);
  await assert.rejects(fetchCatalog({connect:async fn=>fn({request:async()=>({data:[row('loop')],nextCursor:'loop'})})}),/pagination/);
});
await test('model and per-model effort/tier checks permit new IDs and reject unsupported settings',()=>{
  const catalog={models:normalizeModels([row('future-model')])};
  assert.equal(validateCatalogSelection(catalog,'future-model','high','fast'),null);
  assert.match(validateCatalogSelection(catalog,'unknown','high'),/not in the catalog/);
  assert.match(validateCatalogSelection(catalog,'future-model','low'),/effort/);
  assert.match(validateCatalogSelection(catalog,'future-model','high','flex'),/tier/);
});
await test('memory/disk hit, TTL, executable/account identity invalidation and offline stale fallback',async()=>{
  const cacheFile=path.join(root,'cache.json');let stamp=Date.now(),identityKey='version-account-A',fetches=0,offline=false;
  const options={cacheFile,identity:()=>identityKey,now:()=>stamp,ttlMs:1000,fetcher:async()=>{
    fetches++;if(offline)throw Error('offline');return {models:normalizeModels([row('new-model')]),source:'app-server',fetchedAt:new Date(stamp).toISOString(),stale:false,accountFingerprint:'fingerprint'};
  }};
  let store=createCatalogStore(options);assert.equal((await store.get()).cached,false);
  assert.equal((await store.get()).cached,true);assert.equal(fetches,1);
  store=createCatalogStore(options);assert.equal((await store.get()).cached,true);assert.equal(fetches,1);
  identityKey='version-account-B';assert.equal((await store.get()).cached,false);assert.equal(fetches,2);
  stamp+=2000;offline=true;const stale=await store.get();assert.equal(stale.stale,true);assert.equal(stale.models[0].id,'new-model');
  const fresh=createCatalogStore({...options,cacheFile:path.join(root,'missing.json')});const fallback=await fresh.get();
  assert.equal(fallback.source,'fallback');assert.equal(fallback.models.length,4);assert.ok(fallback.models.some(m=>m.efforts.some(e=>e.id==='ultra')));
});
await test('codex_models filters hidden and exposes source/freshness',async()=>{
  const catalog=async()=>({models:normalizeModels([row('visible'),row('hidden',{hidden:true})]),source:'app-server',fetchedAt:new Date().toISOString(),stale:false});
  const tool=catalogTools({defineTool:d=>d,catalog})[0];
  assert.equal((await tool.execute({})).models.length,1);assert.equal((await tool.execute({include_hidden:true})).models.length,2);
  assert.equal((await tool.execute({})).source,'app-server');
});
await test('authenticated service bridge rejects writes, extra keys and non-owner calls',async()=>{
  let handler,disposed=false;
  const ctx={inject:(keys,fn)=>fn({connection:{rpc:{handle:(channel,fn)=>{assert.equal(channel,'/codex-runner');handler=fn;return ()=>{disposed=true;};}}},effect:fn=>{ctx.dispose=fn();}})};
  registerRunnerRpc(ctx,{getCatalog:async()=>FALLBACK_CATALOG,refreshCatalog:async()=>FALLBACK_CATALOG});
  const owner={principal:{kind:'owner'}};
  assert.equal((await handler('getCatalog',{},null,owner)).ok,true);
  assert.equal((await handler('getCatalog',{path:'arbitrary'},null,owner)).ok,false);
  assert.equal((await handler('setPolicy',{},null,owner)).ok,false);
  assert.equal((await handler('getCatalog',{},null,{principal:{kind:'guest'}})).ok,false);
  await ctx.dispose();assert.equal(disposed,true);
});
console.log('CATALOG-OK '+pass);
