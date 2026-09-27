import fs from 'node:fs';
import { ConversationStore } from '../apps/controller/src/services/conversationStore.js';
import { loadProfile,hash,availableMemory,CONTEXT_TIERS } from '../apps/controller/src/services/contextPolicy.js';
import { streamChat } from '../apps/controller/src/services/ollamaClient.js';
const dir=process.argv[2]??'/private/tmp/context-policy-live';fs.mkdirSync(dir,{recursive:true});
const store=new ConversationStore(dir);
const selected=process.argv.slice(3);
const report:any[]=[];
for(const model of selected){
 const signal=AbortSignal.timeout(3600000);const profile=await loadProfile(store,model,signal);
 const contexts:number[]=[];let ratio=0,maxBytes=0;
 for(const tier of CONTEXT_TIERS.filter(t=>t<=profile.maximum)){
  const resident=await fetch('http://127.0.0.1:11434/api/ps').then(r=>r.json());
  if(resident.models?.length)throw new Error('Runtime has resident work; calibration will not unload it.');
  const unit='Record: cedar evidence 17; amber objection 29; unresolved policy cost 43.\n';
  const content='FIRST_MARKER=cedar872\n'+unit.repeat(Math.floor(tier*2.1/unit.length))+'\nLAST_MARKER=amber619';
  const messages:any=[{role:'system',content:'Reply only with the FIRST_MARKER and LAST_MARKER values. No explanation.'},{role:'user',content}];
  const control=new AbortController();let minimum=availableMemory();const started=Date.now();
  const timer=setInterval(()=>{minimum=Math.min(minimum,availableMemory());if(minimum<4*1024**3)control.abort(new Error('Memory headroom below 4 GiB'));},1000);
  const sample:any={model,tier,started};
  try{
   const result=await streamChat({model,messages,signal:AbortSignal.any([signal,control.signal]),options:{num_ctx:tier,num_predict:2048},onDelta:()=>{}});
   if(!result.fullText.includes('cedar872')||!result.fullText.includes('amber619'))throw new Error('Boundary markers not recovered');
   if(!result.promptEvalCount||result.promptEvalCount+2048>tier)throw new Error('Actual token usage does not fit with response reserve');
   const bytes=Buffer.byteLength(JSON.stringify({messages}));ratio=Math.max(ratio,result.promptEvalCount/bytes*1.5);maxBytes=Math.max(maxBytes,bytes);contexts.push(tier);
   sample.usage={input:result.promptEvalCount,output:result.evalCount};sample.passed=true;
  }catch(e){sample.error=String(e);sample.passed=false;}
  finally{clearInterval(timer);sample.seconds=(Date.now()-started)/1000;sample.minimumGiB=minimum/1024**3;report.push(sample);console.log(JSON.stringify(sample));fs.writeFileSync(dir+'/calibration.json',JSON.stringify(report,null,2));}
  store.saveRecord(profile.key,{...profile,contexts,ratio:Math.min(1,ratio||1),maxBytes,createdAt:Date.now(),samples:report.filter(x=>x.model===model)});
  fs.writeFileSync(dir+'/profiles.json',JSON.stringify(selected.map(name=>{const p=report.filter(x=>x.model===name);return {model:name,samples:p};}),null,2));
  if(!sample.passed)break;
 }
}
store.close();
