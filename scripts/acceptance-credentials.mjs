// Explicit live acceptance only. Existing credentials are read once, used by
// native provider origin checks, and never copied to the temporary profile.
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const require=createRequire(path.join(process.env.DSH_ACCEPT_HOST_PREFIX,'package.json'));
const {CredentialProvider}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-credentials')));
const {parseCredentialsDocument}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-credentials-local')));
export default class AcceptanceCredentials extends CredentialProvider {
  constructor(ctx){
    super(ctx);const file=process.env.DSH_ACCEPT_CREDENTIAL_SOURCE;
    if(!path.isAbsolute(file||''))throw Error('An explicit credential source path is required for live acceptance');
    const data=parseCredentialsDocument(fs.readFileSync(file,'utf8'),file);
    this.refs=new Map([...data.refs].filter(([key])=>key==='DEEPSEEK_API_KEY'));
    this.records=new Map([...data.records].filter(([key])=>key.startsWith('deepseek-account-platform/')));
  }
  async resolve(ref){const value=this.refs.get(ref);return value?{value,source:'acceptance-memory'}:undefined;}
  async describe(ref){return {configured:this.refs.has(ref),source:'acceptance-memory',writable:false};}
  async set(){throw Error('Acceptance does not save credentials');}
  async unset(){throw Error('Acceptance does not modify credentials');}
  async readRecord(key){return structuredClone(this.records.get(key));}
  async describeRecord(key){const value=this.records.get(key);return {configured:!!value,kind:value?.kind,writable:true};}
  async listRecords(){return [...this.records].map(([key,value])=>({key,kind:value.kind}));}
  async modifyRecord(key,mutate){const value=await mutate(await this.readRecord(key));if(value)this.records.set(key,structuredClone(value));else this.records.delete(key);return value;}
  async deleteRecord(key){this.records.delete(key);}
}
