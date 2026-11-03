import { stopOwnedTree } from './owned-process.js';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { resolveCodexExe, codexEnvironment } from './executable.js';

export const DEFER_SERVER_RESPONSE = Symbol('defer-server-response');

/** One owned stdio connection. No network listener or third-party transport dependency. */
export class AppServerClient extends EventEmitter {
  constructor({ executable, args = ['app-server', '--listen', 'stdio://'], cwd, env = process.env, settings = {},
    timeoutMs = 15000, maxFrameBytes = 8 * 1024 * 1024, onRequest } = {}) {
    super();
    this.timeoutMs=timeoutMs;this.maxFrameBytes=maxFrameBytes;this.onRequest=onRequest;
    this.pending=new Map();this.sequence=0;this.buffer='';this.closed=false;this.stderrTail='';
    this.connectionId=randomUUID();this.serverRequests=new Map();
    env = codexEnvironment(settings, env);
    executable = executable ? resolveCodexExe({codexExecutable:executable}, {env}) : resolveCodexExe(settings, {env});
    if(!executable)throw Error('Codex native executable not found');
    this.childStartedAt=new Date().toISOString();
    this.child=spawn(executable,args,{cwd,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
    this.child.stdout.setEncoding('utf8');this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data',data=>this.consume(data));
    this.child.stderr.on('data',data=>{this.stderrTail=(this.stderrTail+data).slice(-4096);});
    this.child.stdin.on('error',error=>this.fail(error));
    this.child.on('error',error=>this.fail(error));
    this.exited=new Promise(resolve=>this.child.once('close',(code,signal)=>{
      this.fail(Error('App Server exited: '+code+'/'+signal));resolve({code,signal});
    }));
  }
  fail(error) {
    if(this.closed)return;
    this.closed=true;
    for(const request of this.serverRequests.values())request.abort.abort(error);
    this.serverRequests.clear();
    for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}
    this.pending.clear();this.emit('fault',error);
  }
  send(message) {
    if(this.closed)throw Error('App Server connection closed');
    const text=JSON.stringify(message)+'\n';
    if(Buffer.byteLength(text)>this.maxFrameBytes || this.child.stdin.writableLength>this.maxFrameBytes)throw Error('App Server outbound buffer limit');
    this.child.stdin.write(text);
  }
  deferRequest(message) {
    const id=message.id;
    if (!(typeof id==='string'&&id.length>0&&id.length<=512 || Number.isSafeInteger(id))) throw Error('Invalid server request ID');
    const key=typeof id+':'+id;
    if(this.serverRequests.has(key))throw Error('Duplicate live server request ID');
    const request={id,params:message.params,abort:new AbortController(),state:'pending'};
    this.serverRequests.set(key,request);
    const respond=async(value,error=false)=>{
      if(this.closed||request.abort.signal.aborted||this.serverRequests.get(key)!==request||request.state!=='pending')throw Error('Server request is no longer pending');
      const frame=JSON.stringify({id,...(error?{error:value}:{result:value})})+'\n';
      if(Buffer.byteLength(frame)>this.maxFrameBytes||this.child.stdin.writableLength>this.maxFrameBytes)throw Error('App Server outbound buffer limit');
      request.state='submitting';
      try {
        await new Promise((resolve,reject)=>this.child.stdin.write(frame,writeError=>writeError?reject(writeError):resolve()));
        request.state='submitted';
        return {delivery:'written_to_connection',connectionId:this.connectionId};
      } finally {if(this.serverRequests.get(key)===request)this.serverRequests.delete(key);}
    };
    return {id,connectionId:this.connectionId,signal:request.abort.signal,respond,
      reject:error=>respond({code:Number.isInteger(error.code)?error.code:-32601,message:String(error.message||error).slice(0,300)},true),
      invalidate:reason=>{if(this.serverRequests.get(key)===request)this.serverRequests.delete(key);request.abort.abort(Error(reason));}};
  }
  request(method,params={},timeoutMs=this.timeoutMs) {
    if(this.closed)return Promise.reject(Error('App Server connection closed'));
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>2147483647)return Promise.reject(Error('Invalid RPC timeout'));
    if(this.pending.size>=64)return Promise.reject(Error('Too many outstanding RPC requests'));
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('RPC timeout: '+method));},timeoutMs);
      this.pending.set(id,{resolve,reject,timer});
      try{this.send({id,method,params});}catch(error){clearTimeout(timer);this.pending.delete(id);reject(error);}
    });
  }
  async initialize() {
    const result=await this.request('initialize',{clientInfo:{name:'dsh_codex_runner',title:'DSH Codex Runner',version:'0.4.0-rc.2'},capabilities:{experimentalApi:true}});
    this.send({method:'initialized',params:{}});return result;
  }
  consume(data) {
    if(this.closed)return;
    this.buffer+=data;
    let index;
    while((index=this.buffer.indexOf('\n'))>=0){
      const line=this.buffer.slice(0,index);this.buffer=this.buffer.slice(index+1);
      if(Buffer.byteLength(line)>this.maxFrameBytes){this.fail(Error('App Server frame limit'));void this.close();return;}
      if(!line.trim())continue;
      let message;
      try{message=JSON.parse(line);if(!message||typeof message!=='object'||Array.isArray(message))throw Error('Invalid object');}
      catch{this.fail(Error('Malformed App Server message'));void this.close();return;}
      if(message.id!==undefined&&message.method){
        let request;
        try {request=this.deferRequest(message);}catch(error){this.fail(error);void this.close();return;}
        Promise.resolve().then(()=>{
          if(!this.onRequest)throw Error('Interactive server requests are disabled');
          return this.onRequest(message.method,message.params,request);
        }).then(result=>{if(result!==DEFER_SERVER_RESPONSE&&!this.closed&&!request.signal.aborted)return request.respond(result);},error=>{
          if(!this.closed&&!request.signal.aborted)return request.reject(error);
        }).catch(error=>this.fail(error));
      }else if(message.id!==undefined){
        const p=this.pending.get(message.id);if(!p)continue;
        clearTimeout(p.timer);this.pending.delete(message.id);
        if(message.error){const error=Error(String(message.error.message||'RPC failed'));error.code=message.error.code;p.reject(error);}
        else if(Object.hasOwn(message,'result'))p.resolve(message.result);
        else p.reject(Error('RPC response missing result'));
      }else if(typeof message.method==='string'){
        if(message.method==='serverRequest/resolved') {
          const id=message.params?.requestId,key=typeof id+':'+id,request=this.serverRequests.get(key);
          if(request&&request.params?.threadId===message.params?.threadId){this.serverRequests.delete(key);request.abort.abort(Error('Server request resolved'));}
        }
        try{this.emit('notification',message.method,message.params||{});}
        catch(error){this.fail(error);void this.close();return;}
      }
    }
    if(Buffer.byteLength(this.buffer)>this.maxFrameBytes){this.fail(Error('App Server frame limit'));void this.close();}
  }
  async close() {
    if(this.closing)return this.closing;
    this.closing=(async()=>{
      this.fail(Error('App Server client closed'));
      this.child.stdin.end();
      let timer;
      const exited=await Promise.race([this.exited.then(()=>true),new Promise(r=>{timer=setTimeout(()=>r(false),1000);})]);
      clearTimeout(timer);
      if(!exited&&this.child.pid&&this.child.exitCode===null){
        this.terminationEvidence=stopOwnedTree(this.child,this.childStartedAt);
        let limit;await Promise.race([this.exited,new Promise(r=>{limit=setTimeout(r,3000);})]);clearTimeout(limit);
      }
    })();return this.closing;
  }
}

export async function withAppServer(fn,options={}) {
  const client=new AppServerClient(options);
  try{await client.initialize();return await fn(client);}finally{await client.close();}
}
