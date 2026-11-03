import path from 'node:path';
import readline from 'node:readline';
import fs from 'node:fs';
if(path.basename(process.argv[1]||'')==='app-server') {
  const fallback=JSON.parse(fs.readFileSync(new URL('../lib/model-catalog.fallback.json',import.meta.url),'utf8'));
  for await(const line of readline.createInterface({input:process.stdin})) {
    const request=JSON.parse(line);if(request.id===undefined)continue;
    let result;
    if(request.method==='initialize')result={};
    else if(request.method==='model/list')result={data:fallback.models};
    else if(request.method==='account/read')result={account:{type:'chatgpt',email:'offline@example.invalid'}};
    else throw Error('Offline catalog fixture forbids method '+request.method);
    console.log(JSON.stringify({id:request.id,result}));
  }
  process.exit(0);
}
