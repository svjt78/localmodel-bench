import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {streamChat,GenerationError} from '../src/services/ollamaClient.js';
import {ConversationStore} from '../src/services/conversationStore.js';
import {ContextPolicy,chunks,estimate,chooseCapacity,type ContextProfile} from '../src/services/contextPolicy.js';
import {WsSessionManager} from '../src/wsHandler.js';
import {DiagnosticsLog} from '../src/services/diagnosticsLog.js';
import {PreferencesStore} from '../src/services/preferences.js';
const profile:ContextProfile={key:'test-profile',model:'test',maximum:32768,contexts:[16384,32768],ratio:1,maxBytes:0};
function mock(t:any,fn:typeof fetch){const prior=globalThis.fetch;globalThis.fetch=fn;t.after(()=>globalThis.fetch=prior);}
const wire=(data:any)=>new Response(JSON.stringify(data)+'\n');
async function fixture(t:any){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'context-policy-'));const store=new ConversationStore(dir);store.createConversation({id:'c',title:'Saved',model:'test',workspaceSet:null,internetEnabled:false});t.after(()=>{store.close();return fs.rm(dir,{recursive:true,force:true});});return {store,dir};}
for(const [name,data,reason] of [
 ['truncation',{message:{content:'partial'},done:true,done_reason:'length'},'length'],
 ['empty',{message:{thinking:'private'},done:true},'empty'],
 ['stream error',{error:'internal'},'stream'],
 ['missing completion',{message:{content:'partial'},done:false},'eof']
] as const)test(`reports ${name} without claiming completion`,async(t)=>{
 mock(t,async()=>wire(data));await assert.rejects(streamChat({model:'test',messages:[],signal:new AbortController().signal,onDelta:()=>{}}),(e:any)=>e instanceof GenerationError&&e.reason===reason);
});
test('handles unterminated final JSON and reports thinking without retaining it',async(t)=>{
 mock(t,async()=>new Response(JSON.stringify({message:{thinking:'secret',content:'answer'},done:true,done_reason:'stop',prompt_eval_count:20})));
 let thinking=0;const r=await streamChat({model:'test',messages:[],signal:new AbortController().signal,onDelta:()=>{},onThinking:()=>thinking++});
 assert.equal(thinking,1);assert.equal(r.fullText,'answer');assert.ok(!JSON.stringify(r).includes('secret'));
});
test('capacity reserves answer space and unicode chunks remain intact',()=>{
 assert.equal(chooseCapacity(profile,16000+8192),32768);assert.equal(chooseCapacity(profile,32769),undefined);
 const source='🙂漢字'.repeat(1000);assert.equal(chunks(source,123).join(''),source);assert.ok(chunks(source,123).every(s=>Buffer.byteLength(s)<=123));
 assert.ok(estimate([{role:'user',content:source}],undefined,profile)>Buffer.byteLength(source));
});
test('full document coverage, cache and exact passages preserve originals',async(t)=>{
 const {store}=await fixture(t);let calls=0;
 mock(t,async()=>{calls++;return wire({message:{content:'Summary includes identifiers, caveats and objections.'},done:true,done_reason:'stop'});});
 const policy=new ContextPolicy(store,'test',{...profile,contexts:[16384]},new AbortController().signal,()=>{},'c');
 const text='I12 special evidence\n'+'source text '.repeat(2600);
 const result=await policy.document(text,'portfolio','Explain I12');
 assert.match(result,/covering all/);assert.match(result,/I12 special evidence/);assert.ok(calls>1);
 const before=calls;await policy.document(text,'portfolio','Explain I12');assert.equal(calls,before);
 assert.equal(store.getConversation('c')!.messages.length,0);
});
test('oversized current message and image history are never silently discarded',async(t)=>{
 const {store}=await fixture(t);const policy=new ContextPolicy(store,'test',profile,new AbortController().signal,()=>{},'c');
 await assert.rejects(policy.prepare([{role:'user',content:'x'.repeat(40000)}],8192),/exceed/);
 const messages:any=[{role:'user',content:'old',images:['base64']},...Array.from({length:6},()=>({role:'user',content:'x'.repeat(7000)}))];
 await assert.rejects(policy.prepare(messages,8192),/images/);
});
test('request state and partial text survive restart without editing originals',async(t)=>{
 const {store,dir}=await fixture(t);store.appendMessage('c',{id:'u',role:'user',text:'original',createdAt:1});
 store.setExecution('c',{version:1,status:'running',updatedAt:2,partial:{id:'a',role:'assistant',text:'partial',createdAt:2,incomplete:true}});
 const restarted=new ConversationStore(dir);t.after(()=>restarted.close());
 assert.equal(restarted.getConversation('c')!.turnStatus,'interrupted');assert.equal(restarted.execution('c').partial?.text,'partial');assert.equal(restarted.getConversation('c')!.messages[0].text,'original');
});
class Socket extends EventEmitter {OPEN=1;readyState=1;events:any[]=[];send(raw:string){const e=JSON.parse(raw);this.events.push(e);this.emit('event',e);} }
test('upgrade and retry preserve saved question, with exactly one length retry',async(t)=>{
 const {store,dir}=await fixture(t);store.setExecution('c',{version:0,status:'idle',updatedAt:0});store.appendMessage('c',{id:'u',role:'user',text:'original question',createdAt:1});
 let chats=0;
 mock(t,async(input,init)=>{
  const url=String(input);if(url.endsWith('/api/version'))return wire({version:'test'});
  if(url.endsWith('/api/tags'))return wire({models:[{name:'test',digest:'d',capabilities:['completion']}]});
  if(url.endsWith('/api/show'))return wire({model_info:{'test.context_length':32768}});
  const body=JSON.parse(String(init?.body));chats++;
  if(chats===1)return wire({message:{content:'unfinished'},done:true,done_reason:'length'});
  assert.equal(body.options.num_predict,16384);
  return wire({message:{content:'complete answer'},done:true,done_reason:'stop'});
 });
 // Profile discovery key depends on identity; explicitly seed a verified 32K fixture.
 const {loadProfile}=await import('../src/services/contextPolicy.js');const p=await loadProfile(store,'test',new AbortController().signal);store.saveRecord(p.key,{...p,contexts:[32768]});
 const socket=new Socket();const manager=new WsSessionManager(store,new DiagnosticsLog(),new PreferencesStore(dir));manager.handleConnection(socket as any);
 socket.emit('message',JSON.stringify({type:'upgrade_conversation',conversationId:'c'}));
 const done=new Promise<any>(resolve=>socket.on('event',e=>{if(e.type==='turn_state'&&e.status!=='running')resolve(e);}));
 socket.emit('message',JSON.stringify({type:'retry_response',conversationId:'c'}));
 assert.equal((await done).status,'completed');assert.equal(chats,2);
 const c=store.getConversation('c')!;assert.equal(c.messages.filter(m=>m.role==='user').length,1);assert.equal(c.messages[1].incomplete,true);assert.equal(c.messages.at(-1)?.text,'complete answer');
});

test('retrieval returns only originals belonging to this conversation',async(t)=>{
 const {store}=await fixture(t);const {retrieveAttachment}=await import('../src/services/attachmentRetrieval.js');
 store.createConversation({id:'other',title:'Other',model:'test',workspaceSet:null,internetEnabled:false});
 for(const [id,conversationId,text] of [['a','c','I12 original evidence'],['b','other','private unrelated text']])store.addAttachment({id,conversationId,messageId:null,fileName:'same.txt',sourcePath:'same.txt',mimeType:'text/plain',sizeBytes:text.length,kind:'text',extractedText:text,storedPath:'/tmp/not-read'});
 assert.match(retrieveAttachment(store,'c','read_attachment',{filename:'same.txt',section:1}),/I12 original evidence/);
 assert.doesNotMatch(retrieveAttachment(store,'c','read_attachment',{filename:'same.txt',attachment_id:'b',section:1}),/private unrelated/);
 assert.match(retrieveAttachment(store,'c','search_attachments',{query:'I12'}),/"attachment_id":"a"/);
});

test('Unicode punctuation uses calibrated ASCII estimate but non-ASCII bytes stay conservative',()=>{
 const p={...profile,ratio:.4,maxBytes:100000};const text='A normal English source contains substantial ordinary text and occasional “quotes”. '.repeat(100);
 const raw=estimate([{role:'user',content:text}],undefined);const calibrated=estimate([{role:'user',content:text}],undefined,p);
 assert.ok(calibrated<raw);assert.ok(calibrated>raw*.4);
 const nonAscii='漢字'.repeat(100);assert.equal(estimate([{role:'user',content:nonAscii}],undefined,p),estimate([{role:'user',content:nonAscii}]));
});

test('a length-limited summary retries once and caches only its complete replacement',async(t)=>{
 const {store}=await fixture(t);const outputs:number[]=[];
 mock(t,async(_input,init)=>{const body=JSON.parse(String(init?.body));outputs.push(body.options.num_predict);return outputs.length===1?wire({message:{content:'partial'},done:true,done_reason:'length'}):wire({message:{content:'Complete source summary with uncertainty.'},done:true,done_reason:'stop'});});
 const policy=new ContextPolicy(store,'test',profile,new AbortController().signal,()=>{},'c');
 assert.match(await policy.summarize('Original document text','Section 1'),/Complete/);assert.deepEqual(outputs,[2048,4096]);
 await policy.summarize('Original document text','Section 1');assert.equal(outputs.length,2);
});

test('attachment search ranks a named section above incidental mentions',async(t)=>{
 const {store}=await fixture(t);const {retrieveAttachment}=await import('../src/services/attachmentRetrieval.js');
 const text='Overview mentions I12.\n'+'filler '.repeat(1000)+'\n## I12 Disaster ledger\nThe resolution record is unverified.';
 store.addAttachment({id:'long',conversationId:'c',messageId:null,fileName:'portfolio.md',sourcePath:'portfolio.md',mimeType:'text/markdown',sizeBytes:text.length,kind:'text',extractedText:text,storedPath:'/tmp/not-read'});
 const result=JSON.parse(retrieveAttachment(store,'c','search_attachments',{query:'I12'}));
 assert.equal(result.matches[0].section,2);assert.match(result.matches[0].heading,/## I12/);assert.match(result.matches[0].excerpt,/resolution record/);
});
