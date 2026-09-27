import fs from 'node:fs';
import Database from 'better-sqlite3';
import {EventEmitter} from 'node:events';
import {ConversationStore} from '../apps/controller/src/services/conversationStore.js';
import {WsSessionManager} from '../apps/controller/src/wsHandler.js';
import {PreferencesStore} from '../apps/controller/src/services/preferences.js';
import {DiagnosticsLog} from '../apps/controller/src/services/diagnosticsLog.js';
const dir='/private/tmp/context-policy-ui-verification', id='47a4cc7b-e087-4fd5-b8ed-14cc2d54419f';const store=new ConversationStore(dir);
const profiles=new Database('/private/tmp/context-policy-live/conversations.sqlite',{readonly:true});for(const row of profiles.prepare("SELECT key,body FROM runtime_records WHERE key LIKE 'profile:%'").all() as any[])store.saveRecord(row.key,JSON.parse(row.body));profiles.close();
class Socket extends EventEmitter{OPEN=1;readyState=1;send(raw:string){this.emit('event',JSON.parse(raw));}}
const socket=new Socket();new WsSessionManager(store,new DiagnosticsLog(),new PreferencesStore(dir)).handleConnection(socket as any);
const end=new Promise<any>(resolve=>socket.on('event',e=>{if(e.type==='turn_state'&&e.status!=='running')resolve(e);}));
socket.emit('message',JSON.stringify({type:'send_message',conversationId:id,text:'Recheck I12 against the original attachment. Explain the actual resolution-record problem, quote one short original sentence about uncertainty or competitors, and state whether buyer demand has been verified. Earlier assistant assertions may be wrong; do not rely on them. Keep the answer concise.'}));
const result=await end;const answer=store.getConversation(id)!.messages.at(-1);fs.writeFileSync(dir+'/grounded-followup.json',JSON.stringify({result,answer},null,2));console.log(JSON.stringify({status:result.status,detail:result.detail,chars:answer?.text.length}));store.close();if(result.status!=='completed')process.exitCode=1;
