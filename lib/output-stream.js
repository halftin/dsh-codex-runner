import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {atomicJson,readJson} from './run-store.js';

const INLINE_BYTES=32768;
function regular(file){if(fs.existsSync(file)){const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())throw Error('Invalid output file');return stat.size;}return 0;}
function readAt(file,offset,length){const buffer=Buffer.alloc(length),fd=fs.openSync(file,'r');try {return buffer.subarray(0,fs.readSync(fd,buffer,0,length,offset));}finally{fs.closeSync(fd);}}
function position(index,sequence){return Number(readAt(index,(sequence-1)*8,8).readBigUInt64LE());}

/** One driver owns the append-only log. The index commits only complete lines. */
export class OutputWriter {
  constructor({dir,runId,backend}) {
    this.dir=dir;this.runId=runId;this.backend=backend;this.file=path.join(dir,'output.jsonl');this.index=path.join(dir,'output.idx');
    fs.mkdirSync(dir,{recursive:true});
    const size=regular(this.index);if(size%8)throw Error('Incomplete output index');
    this.sequence=size/8;this.bytes=regular(this.file);
    if(this.sequence){const last=readAt(this.file,position(this.index,this.sequence),INLINE_BYTES+8192).toString('utf8').split('\n')[0];const row=JSON.parse(last);
      if(row.runId!==runId||row.sequence!==this.sequence||position(this.index,this.sequence)+Buffer.byteLength(last)+1!==this.bytes)throw Error('Output tail does not match committed index');}
    else if(this.bytes)throw Error('Output log has no committed index');
    atomicJson(path.join(dir,'output-state.json'),{version:1,runId,backend,status:'collecting'});
  }
  append(method,params,identity={}) {
    if(this.failed)return;
    try {
      const sequence=this.sequence+1,raw=JSON.stringify(params),size=Buffer.byteLength(raw);
      const row={version:1,runId:this.runId,sequence,backend:this.backend,method,receivedAt:new Date().toISOString(),
        threadId:params?.threadId||params?.thread_id||identity.threadId||null,
        turnId:params?.turnId||params?.turn_id||params?.turn?.id||identity.turnId||null,itemId:params?.itemId||params?.item?.id||null};
      if(size<=INLINE_BYTES)row.params=params;
      else {
        const resource='output-'+sequence+'.json';fs.writeFileSync(path.join(this.dir,resource),raw,{flag:'wx',mode:0o600});
        row.payload={resource,bytes:size,sha256:createHash('sha256').update(raw).digest('hex'),complete:true,preview:raw.slice(0,2048),previewTruncated:true};
      }
      const line=JSON.stringify(row)+'\n',offset=Buffer.alloc(8);offset.writeBigUInt64LE(BigInt(this.bytes));
      fs.appendFileSync(this.file,line,{mode:0o600});fs.appendFileSync(this.index,offset,{mode:0o600});
      this.bytes+=Buffer.byteLength(line);this.sequence=sequence;
    } catch(error) {
      this.failed=String(error.message);
      atomicJson(path.join(this.dir,'output-state.json'),{version:1,runId:this.runId,backend:this.backend,status:'unavailable',error:this.failed,lastSequence:this.sequence});
    }
  }
}

export function readOutput(dir,runId,{after=0,limit=100}={}) {
  if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>200)throw Error('Invalid output cursor or limit');
  const index=path.join(dir,'output.idx'),file=path.join(dir,'output.jsonl'),state=readJson(path.join(dir,'output-state.json'));
  if(state&&state.runId!==runId)throw Error('Output run mismatch');
  const size=regular(index),count=Math.floor(size/8);regular(file);
  if(after>count)throw Error('Output cursor is ahead of this run');
  const events=[];let bytes=0;
  for(let sequence=after+1;sequence<=Math.min(count,after+limit);sequence++) {
    const start=position(index,sequence),buffer=readAt(file,start,Math.min(INLINE_BYTES+8192,regular(file)-start));
    const newline=buffer.indexOf(10);if(newline<0)throw Error('Incomplete output record');
    if(events.length&&bytes+newline+1>262144)break;
    const raw=buffer.subarray(0,newline+1),row=JSON.parse(raw.toString('utf8'));
    if(row.runId!==runId||row.sequence!==sequence)throw Error('Output association or sequence gap');
    events.push(row);bytes+=raw.length;
  }
  const next=events.at(-1)?.sequence??after;
  return {status:state?.status==='unavailable'?'unavailable':state?'ok':'unavailable',events,next_cursor:next,has_more:next<count,
    latest_cursor:count,gap:null,truncated:false,diagnostic:state?.error||(!state?'Output collection is unavailable for this historical run':null)};
}

export function readOutputResource(dir,runId,{sequence,offset=0,limit=32768}={}) {
  if(!Number.isSafeInteger(sequence)||sequence<1||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>65536)throw Error('Invalid resource range');
  const row=readOutput(dir,runId,{after:sequence-1,limit:1}).events[0];
  if(!row?.payload||row.payload.resource!=='output-'+sequence+'.json')throw Error('Output resource is unavailable');
  const file=path.join(dir,row.payload.resource),size=regular(file);if(size!==row.payload.bytes||offset>size)throw Error('Output resource changed or invalid offset');
  // Byte slices are returned losslessly; consumers decode after concatenation.
  const data=readAt(file,offset,Math.min(limit,size-offset));
  return {encoding:'base64',data:data.toString('base64'),offset,next_offset:offset+data.length,bytes:size,has_more:offset+data.length<size,sha256:row.payload.sha256};
}
