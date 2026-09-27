import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import Database from 'better-sqlite3';
import { ConversationStore } from '../src/services/conversationStore.js';
import { ingestAttachment, validateImage } from '../src/services/attachments.js';
import { buildChatHistory } from '../src/services/chatHistory.js';
import { fetchInstalledModels } from '../src/services/modelRegistry.js';
import { streamChat } from '../src/services/ollamaClient.js';
import { WsSessionManager } from '../src/wsHandler.js';
import { PreferencesStore } from '../src/services/preferences.js';
import { DiagnosticsLog } from '../src/services/diagnosticsLog.js';
import type { ModelOption, ConversationMessage } from '@ollama-local/shared';
import type { WebSocket } from 'ws';

const vision: ModelOption = { name:'vision', alias:null, supportsTools:false, supportsVision:true, capabilitiesKnown:true, family:'test', sizeBytes:1 };
const textModel = {...vision, name:'text', supportsVision:false};
const png = await sharp({create:{width:20,height:12,channels:3,background:'#ff0000'}}).png().toBuffer();
const jpg = await sharp({create:{width:20,height:12,channels:3,background:'#0000ff'}}).jpeg().toBuffer();
const user = (attachments: ConversationMessage['attachments'] = []): ConversationMessage => ({id:randomUUID(),role:'user',text:'Describe the image.',createdAt:Date.now(),attachments});
async function fixture(t: any) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'vision-test-'));
  await fs.mkdir(path.join(dir,'attachments'));
  const store = new ConversationStore(dir);
  t.after(async () => {store.close(); await fs.rm(dir,{recursive:true,force:true});});
  store.createConversation({id:'c',title:'Test',model:'vision',workspaceSet:null,internetEnabled:false});
  store.setExecution('c',{version:0,status:'idle',updatedAt:0}); // Existing-conversation compatibility fixture.
  async function add(name='sample.png', buffer=png, pending=false, conversationId='c') {
    const source = path.join(dir,randomUUID()); await fs.writeFile(source,buffer);
    const ingested = await ingestAttachment(dir,source,name);
    return store.addAttachment({id:randomUUID(),conversationId,messageId:null,sourcePath:name,...ingested,pending});
  }
  return {dir,store,add};
}
function mockFetch(t: any, fn: typeof fetch) {const original=globalThis.fetch;globalThis.fetch=fn;t.after(()=>{globalThis.fetch=original;});}
const json=(data: unknown)=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});

test('JPG and PNG decode; corrupt, mislabeled, oversized and unsupported images fail',async()=>{
  assert.equal(await validateImage(png,'sample.PNG'),'image/png');
  assert.equal(await validateImage(jpg,'sample.JPG'),'image/jpeg');
  await assert.rejects(validateImage(png,'sample.jpg'),/cannot be decoded/);
  await assert.rejects(validateImage(png.subarray(0,40),'sample.png'),/cannot be decoded/);
  await assert.rejects(validateImage(Buffer.alloc(10_000_001),'sample.png'),/10MB/);
  await assert.rejects(validateImage(png,'sample.gif'),/not supported/);
});

test('discovers native capabilities and falls back to show without guessing',async(t)=>{
  const calls:string[]=[];
  mockFetch(t,async(input,init)=>{
    calls.push(String(input));
    if(String(input).endsWith('/api/tags'))return json({models:[{name:'native',capabilities:['vision','tools']},{name:'fallback'},{name:'unknown'},{name:'text',capabilities:['completion']}]});
    const name=JSON.parse(String(init?.body)).model;
    return name==='fallback'?json({capabilities:['vision']}):new Response('',{status:500});
  });
  const models=await fetchInstalledModels();
  assert.deepEqual(models.map(m=>[m.name,m.supportsVision,m.capabilitiesKnown]),[['native',true,true],['fallback',true,true],['unknown',false,false],['text',false,true]]);
  assert.equal(calls.filter(c=>c.endsWith('/api/show')).length,2);
});

test('conversation images are sent once with original bytes and remain after reload',async(t)=>{
  const {store,add}=await fixture(t); const a=await add();
  const first=user(); const history=await buildChatHistory(store,store.getConversation('c')!,first,vision);
  assert.deepEqual(history.at(-1)?.images,[png.toString('base64')]);
  assert.match(history[0].content,/Never invent/);
  store.appendUserMessage('c',first,[]);
  const next=await buildChatHistory(store,store.getConversation('c')!,user(),vision);
  assert.equal(next.flatMap(m=>m.images??[]).length,1);
  assert.equal(next.at(-1)?.images?.[0],png.toString('base64'));
  assert.equal(store.getConversation('c')!.attachments[0].id,a.id);
  assert.ok(!JSON.stringify(store.getConversation('c')).includes(png.toString('base64')));
});

test('message images reattach to their original user message after reopening',async(t)=>{
  const {dir,store,add}=await fixture(t); const a=await add('sample.jpg',jpg,true);
  const first=user(store.getPendingAttachments('c',[a.id,a.id]));
  store.appendUserMessage('c',first,[a.id]);
  const reopened=new ConversationStore(dir);
  try {
    const conversation=reopened.getConversation('c')!;
    assert.equal(conversation.attachments.length,0);
    assert.equal(conversation.pendingMessageAttachments?.length,0);
    assert.equal(conversation.messages[0].attachments?.[0].id,a.id);
    const history=await buildChatHistory(reopened,conversation,user(),vision);
    assert.deepEqual(history.find(m=>m.role==='user')?.images,[jpg.toString('base64')]);
    assert.equal(history.at(-1)?.images,undefined);
  } finally {reopened.close();}
});

test('pending files are not conversation context; deletion removes their association',async(t)=>{
  const {store,add}=await fixture(t); const a=await add('sample.png',png,true);
  const c=store.getConversation('c')!;
  assert.equal(c.attachments.length,0);assert.equal(c.pendingMessageAttachments?.length,1);
  assert.equal((await buildChatHistory(store,c,user(),textModel)).flatMap(m=>m.images??[]).length,0);
  store.deleteAttachment(a.id);
  assert.equal(store.getConversation('c')!.pendingMessageAttachments?.length,0);
  assert.throws(()=>store.getPendingAttachments('c',[a.id]),/no longer available/);
});

test('cross-conversation attachment IDs and already consumed IDs are rejected',async(t)=>{
  const {store,add}=await fixture(t);
  store.createConversation({id:'other',title:'Other',model:'vision',workspaceSet:null,internetEnabled:false});
  const a=await add('sample.png',png,true,'other');
  assert.throws(()=>store.appendUserMessage('c',user(),[a.id]),/no longer available/);
  assert.equal(store.getConversation('c')!.messages.length,0);
  store.appendUserMessage('other',user([a]),[a.id]);
  assert.throws(()=>store.getPendingAttachments('other',[a.id]),/no longer available/);
});

test('no image request can use a non-vision or unknown model, including history',async(t)=>{
  const {store,add}=await fixture(t);const a=await add('sample.png',png,true);
  store.appendUserMessage('c',user([a]),[a.id]);
  await assert.rejects(buildChatHistory(store,store.getConversation('c')!,user(),textModel),/vision-capable/);
  await assert.rejects(buildChatHistory(store,store.getConversation('c')!,user(),undefined),/could not be confirmed/);
});

test('missing stored images fail explicitly before inference',async(t)=>{
  const {store,add}=await fixture(t);const a=await add();
  await fs.unlink(store.getAttachmentRow(a.id)!.stored_path);
  await assert.rejects(buildChatHistory(store,store.getConversation('c')!,user(),vision),/missing or unreadable/);
});

test('text attachments remain usable without vision and persist in message history',async(t)=>{
  const {store,add}=await fixture(t);const a=await add('notes.txt',Buffer.from('A meaningful document.'),true);
  const first=user([a]);store.appendUserMessage('c',first,[a.id]);
  const h=await buildChatHistory(store,store.getConversation('c')!,user(),textModel);
  assert.match(h.find(m=>m.role==='user')!.content,/A meaningful document/);
  assert.ok(h.every(m=>!m.images));
});

test('existing databases gain pending column without losing attachments',async(t)=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'vision-migration-'));
  const db=new Database(path.join(dir,'conversations.sqlite'));
  db.exec('CREATE TABLE attachments (id TEXT PRIMARY KEY, conversation_id TEXT, message_id TEXT, file_name TEXT, source_path TEXT, mime_type TEXT, size_bytes INTEGER, kind TEXT, extracted_text TEXT, stored_path TEXT, created_at INTEGER)');
  db.exec("INSERT INTO attachments VALUES ('old','c',NULL,'old.png','old.png','image/png',1,'image',NULL,'/missing',1)");db.close();
  const store=new ConversationStore(dir);
  t.after(async()=>{store.close();await fs.rm(dir,{recursive:true,force:true});});
  assert.equal(store.getAttachmentRow('old')!.pending,0);
});

test('streamChat serializes images with the correct user message',async(t)=>{
  mockFetch(t,async(_input,init)=>{
    const body=JSON.parse(String(init?.body));assert.deepEqual(body.messages[0].images,[png.toString('base64')]);
    return new Response(JSON.stringify({message:{content:'A red rectangle.'},done:true})+'\n');
  });
  const result=await streamChat({model:'vision',messages:[{role:'user',content:'Explain.',images:[png.toString('base64')]}],signal:new AbortController().signal,onDelta:()=>{}});
  assert.equal(result.fullText,'A red rectangle.');
});

class FakeSocket extends EventEmitter {
  OPEN=1; readyState=1; events:any[]=[];
  send(raw:string){const event=JSON.parse(raw);this.events.push(event);this.emit('event',event);}
  command(value:unknown){this.emit('message',Buffer.from(JSON.stringify(value)));}
  done(){return new Promise<any>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Turn timed out')),5000);
    const listener=(event:any)=>{if(event.type==='turn_state'&&['completed','failed','interrupted'].includes(event.status)){clearTimeout(timer);this.off('event',listener);resolve(event);}};
    this.on('event',listener);
  });}
}

test('backend blocks unsupported vision before persisting or calling chat',async(t)=>{
  const {store,add,dir}=await fixture(t);await add();store.setConversationModel('c','text');
  let chatCalls=0;
  mockFetch(t,async(input)=>{if(String(input).endsWith('/api/chat'))chatCalls++;return json({models:[{name:'text',capabilities:['completion']}]});});
  const socket=new FakeSocket();new WsSessionManager(store,new DiagnosticsLog(),new PreferencesStore(dir)).handleConnection(socket as unknown as WebSocket);
  const done=socket.done();socket.command({type:'send_message',conversationId:'c',text:'Explain'});
  assert.equal((await done).status,'failed');assert.equal(chatCalls,0);assert.equal(store.getConversation('c')!.messages.length,0);
});

test('images survive tool iterations and a simultaneous turn is rejected',async(t)=>{
  const {store,add,dir}=await fixture(t);await add();let calls=0;
  mockFetch(t,async(input,init)=>{
    if(String(input).endsWith('/api/tags'))return json({models:[{name:'vision',capabilities:['vision','tools']}]});
    const body=JSON.parse(String(init?.body));assert.equal(body.messages.flatMap((m:any)=>m.images??[]).length,1);calls++;
    return new Response(JSON.stringify({message:calls===1?{content:'',tool_calls:[{function:{name:'unknown',arguments:{}}}]}:{content:'A red rectangle.'},done:true})+'\n');
  });
  const socket=new FakeSocket();new WsSessionManager(store,new DiagnosticsLog(),new PreferencesStore(dir)).handleConnection(socket as unknown as WebSocket);
  const done=socket.done();socket.command({type:'send_message',conversationId:'c',text:'Explain'});socket.command({type:'send_message',conversationId:'c',text:'Duplicate'});
  assert.equal((await done).status,'completed');assert.equal(calls,2);
  assert.equal(store.getConversation('c')!.messages.filter(m=>m.role==='user').length,1);
  assert.ok(socket.events.some(e=>e.type==='diagnostic'&&/already running/.test(e.message)));
});

// Synthetic documents contain no user data.
function pdfFixture(): Buffer {
  const text='BT /F1 12 Tf 40 100 Td (Document regression fixture) Tj ET';
  const objects=[
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
  ];
  let data='%PDF-1.4\n';const offsets=[0];
  for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(data));data+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
  const start=Buffer.byteLength(data);
  data+=`xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for(const offset of offsets.slice(1))data+=`${String(offset).padStart(10,'0')} 00000 n \n`;
  data+=`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(data);
}

test('PDF and DOCX extraction still supplies text without requiring a vision model',async(t)=>{
  const {store,add}=await fixture(t);
  const docx=Buffer.from('UEsDBBQAAAAIAAt+NV26d6ScywAAAFMBAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbJWQvVLDQAyEX+XmWiYnQ0HB2E4BtEDBC2jOsn3D/c1JCeHtkRNIQUcp7Wq/HfX7U4rmSI1DyYO9dZ3dj/37VyU2qmQe7CpSHwDYr5SQXamUVZlLSyg6tgUq+g9cCO667h58yUJZdrJl2LF/ohkPUczzSdcXSqPI1jxejBtrsFhrDB5FdTjm6Q9l90Nwenn28Boq36jBwti/av0WJjJv2OQFk8bBZ2kTTMUfkiLcZvwXr8xz8HS939JqK56YQ15SdFclYci/PeD8tvEbUEsDBBQAAAAIAAt+NV1fM5VSlQAAAAcBAAALAAAAX3JlbHMvLnJlbHONzzsOwjAMBuCrRD5AnTIwoKZdWLoiLhAlblPRPOSE1+3JwEARA6N///osd8PDr+JGnJcYFLSNhKHvTrTqUoPslpRFbYSswJWSDojZOPI6NzFRqJspsteljjxj0uaiZ8KdlHvkTwO2phitAh5tC+L8TPSPHadpMXSM5uoplB8nvhpV1jxTUXCPbNG+46aygH2Hmxf7F1BLAwQUAAAACAALfjVdKoPOKosAAADCAAAAEQAAAHdvcmQvZG9jdW1lbnQueG1sRY5LDoMwDESvgnIAnHbRRcRn04tQMBCJ2JETPr19MVXVzRtZY8+4ao+wFBtK8ky1uZXWtE21u4H7NSDl4rQpub02c87RAaR+xtClkiPS6Y0socvnKBPsLEMU7jElT1NY4G7tA0LnyWjki4e3alSIIjfPX43gJHrHVIz+yKtgBbqglIvx4jcE/g82H1BLAQIUAxQAAAAIAAt+NV26d6ScywAAAFMBAAATAAAAAAAAAAAAAACAAQAAAABbQ29udGVudF9UeXBlc10ueG1sUEsBAhQDFAAAAAgAC341XV8zlVKVAAAABwEAAAsAAAAAAAAAAAAAAIAB/AAAAF9yZWxzLy5yZWxzUEsBAhQDFAAAAAgAC341XSqDziqLAAAAwgAAABEAAAAAAAAAAAAAAIABugEAAHdvcmQvZG9jdW1lbnQueG1sUEsFBgAAAAADAAMAuQAAAHQCAAAAAA==','base64');
  const pdf=await add('fixture.pdf',pdfFixture());
  const word=await add('fixture.docx',docx);
  assert.equal(pdf.kind,'text');assert.equal(word.kind,'text');
  assert.match(pdf.extractedText!,/Document regression fixture/);
  assert.match(word.extractedText!,/Document regression fixture/);
  const history=await buildChatHistory(store,store.getConversation('c')!,user(),textModel);
  assert.equal(history.at(-1)!.content.split('Document regression fixture').length-1,2);
  assert.ok(history.every(m=>!m.images));
});

test('image runtime failures do not echo payloads into diagnostics',async(t)=>{
  const sensitive=png.toString('base64');
  mockFetch(t,async()=>new Response(`request contained images: ${sensitive}`,{status:400}));
  await assert.rejects(streamChat({model:'vision',messages:[{role:'user',content:'Explain',images:[sensitive]}],signal:new AbortController().signal,onDelta:()=>{}}),(error:Error)=>{
    assert.match(error.message,/Image request failed with status 400/);
    assert.ok(!error.message.includes(sensitive));return true;
  });
});

test('failed image validation leaves draft attachment unconsumed and user history unchanged',async(t)=>{
  const {store,add,dir}=await fixture(t);const a=await add('sample.png',png,true);
  await fs.writeFile(store.getAttachmentRow(a.id)!.stored_path,Buffer.from('corrupt'));
  let chatCalls=0;
  mockFetch(t,async(input)=>{if(String(input).endsWith('/api/chat'))chatCalls++;return json({models:[{name:'vision',capabilities:['vision']}]});});
  const socket=new FakeSocket();new WsSessionManager(store,new DiagnosticsLog(),new PreferencesStore(dir)).handleConnection(socket as unknown as WebSocket);
  const done=socket.done();socket.command({type:'send_message',conversationId:'c',text:'Explain',messageAttachmentIds:[a.id]});
  assert.equal((await done).status,'failed');assert.equal(chatCalls,0);
  assert.equal(store.getConversation('c')!.messages.length,0);
  assert.equal(store.getConversation('c')!.pendingMessageAttachments?.[0].id,a.id);
});
