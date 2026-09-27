import fs from 'node:fs';
import Database from 'better-sqlite3';
import {streamChat} from '../apps/controller/src/services/ollamaClient.js';
const db=new Database('/private/tmp/context-policy-live/conversations.sqlite');const results=[];
for(const row of db.prepare("SELECT key,body FROM runtime_records WHERE key LIKE 'profile:%'").all() as any[]){
 const profile=JSON.parse(row.body);if(!profile.contexts.length)continue;
 const before=await fetch('http://127.0.0.1:11434/api/ps').then(r=>r.json());if(before.models?.length)throw new Error('Runtime busy');
 const control=new AbortController();let started=false;
 const timer=setTimeout(()=>control.abort(),15000);
 try{await streamChat({model:profile.model,messages:[{role:'user',content:'Write a detailed 2000 word essay on the history of public libraries.'}],options:{num_ctx:profile.contexts[0],num_predict:8192},signal:control.signal,onDelta:()=>{started=true;control.abort();},onThinking:()=>{started=true;control.abort();}});}catch(e){if(!control.signal.aborted)throw e;}finally{clearTimeout(timer);}
 let idle=false;const end=Date.now()+20000;
 while(Date.now()<end){const ps=await fetch('http://127.0.0.1:11434/api/ps').then(r=>r.json());if(!ps.models?.length){idle=true;break;}await new Promise(r=>setTimeout(r,300));}
 const result={model:profile.model,streamStarted:started,cancellationConfirmed:idle};results.push(result);console.log(JSON.stringify(result));
 profile.cancellationVerified=idle&&started;if(!profile.cancellationVerified)profile.contexts=[];
 db.prepare('UPDATE runtime_records SET body=? WHERE key=?').run(JSON.stringify(profile),row.key);
 if(!idle)throw new Error('Cancellation unconfirmed; stopping verification');
}
fs.writeFileSync('/private/tmp/context-policy-live/cancellation.json',JSON.stringify(results,null,2));db.close();
