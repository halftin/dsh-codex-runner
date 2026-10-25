import fs from 'node:fs';
import path from 'node:path';
import { readJson, runDirectory, listRecords } from './run-store.js';

export function readSelection(logs,record) {
  const file=path.join(runDirectory(logs,record),'selection.json');
  try {if(fs.statSync(file).size>65536)throw Error('selection artifact exceeds 64 KiB');}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
  const value=readJson(file);if(!value)throw Error('Invalid selection artifact');return value;
}
export function selectionTools({defineTool,resolveCwd,logsRelative}) {
  return [defineTool({name:'codex_selection',description:'Read bounded model/effort selection audits in this workspace, including recommended versus actual and downgrade reasons.',
    parameters:{label:{type:'string'},model:{type:'string'},effort:{type:'string'},downgrade:{type:'boolean'},since:{type:'string'},until:{type:'string'},limit:{type:'number'}},
    output:{schema:{type:'json'},render:(_a,v)=>[{type:'text',text:v.summary_text}]},isConcurrencySafe:()=>true,presentCall:()=>({card:'generic',title:'Codex selection',kind:'read'}),
    async execute(args={},exec) {
      try {
        const cwd=resolveCwd(exec);if(!cwd)throw Error('Missing workspace');const logs=path.join(cwd,logsRelative);
        const limit=args.limit??50;if(!Number.isInteger(limit)||limit<1||limit>100)throw Error('Invalid limit');
        for(const key of ['since','until'])if(args[key]&&!Number.isFinite(Date.parse(args[key])))throw Error('Invalid time filter');
        const entries=[];
        for(const record of listRecords(logs).slice(0,1000)) {
          if(args.label && record.label!==args.label)continue;
          const time=Date.parse(record.createdAt);if(args.since && time<Date.parse(args.since)||args.until && time>Date.parse(args.until))continue;
          const selection=readSelection(logs,record);
          if(['model','effort','downgrade'].some(key=>args[key]!==undefined && selection?.[key]!==args[key]))continue;
          entries.push({run_id:record.runId,label:record.label,created_at:record.createdAt,selection});
          if(entries.length>=limit)break;
        }
        return {status:'ok',entries,summary_text:JSON.stringify(entries)};
      } catch(error){return {status:'error',summary_text:error.message};}
    },
  })];
}
