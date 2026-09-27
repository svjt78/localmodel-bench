import fs from 'node:fs';
import Database from 'better-sqlite3';
import {EventEmitter} from 'node:events';
import {ConversationStore} from '../apps/controller/src/services/conversationStore.js';
import {WsSessionManager} from '../apps/controller/src/wsHandler.js';
import {PreferencesStore} from '../apps/controller/src/services/preferences.js';
import {DiagnosticsLog} from '../apps/controller/src/services/diagnosticsLog.js';
const dir='/private/tmp/context-policy-ui-verification';fs.mkdirSync(dir,{recursive:true});
const source=new Database('/Users/suvojitdutta/Library/Application Support/Ollama Local Workspace/conversations.sqlite',{readonly:true});
if(!fs.existsSync(dir+'/conversations.sqlite'))await source.backup(dir+'/conversations.sqlite');source.close();
const store=new ConversationStore(dir);
const calibration=new Database('/private/tmp/context-policy-live/conversations.sqlite',{readonly:true});
for(const r of calibration.prepare("SELECT key,body FROM runtime_records WHERE key LIKE 'profile:%'").all() as any[])store.saveRecord(r.key,JSON.parse(r.body));calibration.close();
const id='47a4cc7b-e087-4fd5-b8ed-14cc2d54419f';const original=JSON.stringify(store.getConversation(id)!.messages);
class Socket extends EventEmitter{OPEN=1;readyState=1;send(raw:string){const e=JSON.parse(raw);this.emit('event',e);}}
const socket=new Socket(), manager=new WsSessionManager(store,new DiagnosticsLog(),new PreferencesStore(dir));manager.handleConnection(socket as any);
function command(cmd:object){socket.emit('message',JSON.stringify(cmd));}
async function turn(cmd:object,label:string){
 const start=Date.now();let last='';
 const progress=(e:any)=>{if(e.type==='turn_state'&&e.detail!==last){last=e.detail;console.log(JSON.stringify({label,state:e.status,detail:e.detail,seconds:(Date.now()-start)/1000}));}};socket.on('event',progress);
 const finished=new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Scenario deadline exceeded')),1800000);const handler=(e:any)=>{if(e.type==='turn_state'&&e.conversationId===id&&e.status!=='running'){clearTimeout(timer);socket.off('event',handler);resolve(e);}};socket.on('event',handler);});
 command(cmd);const state=await finished;socket.off('event',progress);
 const c=store.getConversation(id)!;const answer=[...c.messages].reverse().find(m=>m.role==='assistant');
 const report={label,status:state.status,detail:state.detail,answerChars:answer?.text.length,incomplete:answer?.incomplete??false,seconds:(Date.now()-start)/1000};
 fs.writeFileSync(dir+'/'+label+'.json',JSON.stringify({report,answer},null,2));console.log(JSON.stringify(report));
 if(state.status!=='completed'||!answer?.text.trim()||answer.incomplete)throw new Error('Live scenario failed: '+label);
}
command({type:'upgrade_conversation',conversationId:id});
await turn({type:'retry_response',conversationId:id},'portfolio-recovery');
await turn({type:'send_message',conversationId:id,text:'For I12, distinguish the proposed mechanism from the evidence that somebody would pay for it. Give a complete concise answer.'},'portfolio-followup');
// Force summaries for the same full document using a verified smaller tier.
for(const r of new Database(dir+'/conversations.sqlite',{readonly:true}).prepare("SELECT key,body FROM runtime_records WHERE key LIKE 'profile:%'").all() as any[]){const p=JSON.parse(r.body);if(p.model==='gpt-oss:20b')store.saveRecord(r.key,{...p,contexts:[32768]});}
await turn({type:'send_message',conversationId:id,text:'Give a brief overview of the entire portfolio, then describe I12 and its strongest unresolved objection. Use the original document where needed.'},'portfolio-forced-summary');
const count=JSON.parse(original).length;const unchanged=JSON.stringify(store.getConversation(id)!.messages.slice(0,count))===original;
fs.writeFileSync(dir+'/preservation.json',JSON.stringify({originalMessagesUnchanged:unchanged}));if(!unchanged)throw new Error('Original messages changed');store.close();
