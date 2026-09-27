import type {ConversationStore} from './conversationStore.js';
import type {ToolDefinition} from './ollamaClient.js';
import {chunks} from './contextPolicy.js';
export const ATTACHMENT_TOOLS:ToolDefinition[]=[{type:'function',function:{name:'read_attachment',description:'Read original text from a saved attachment. Use filename and section number (1-based). Returns up to 6000 UTF-8 bytes. Originals are authoritative; summaries may omit details.',parameters:{type:'object',properties:{filename:{type:'string'},attachment_id:{type:'string'},section:{type:'integer',minimum:1}},required:['filename','section']}}},{type:'function',function:{name:'search_attachments',description:'Search all original attached text for an exact phrase. Returns matching sections to read with read_attachment.',parameters:{type:'object',properties:{query:{type:'string'}},required:['query']}}}];
export function retrieveAttachment(store:ConversationStore,id:string,name:string,args:Record<string,unknown>):string {
 const c=store.getConversation(id);if(!c)throw new Error('Conversation not found');
 const files=[...c.attachments,...c.messages.flatMap(m=>m.attachments??[])].filter(a=>a.kind==='text');
 if(name==='read_attachment'){
  const matches=files.filter(f=>args.attachment_id?f.id===args.attachment_id:f.fileName===args.filename);
  if(matches.length>1)return JSON.stringify({error:'Ambiguous filename. Supply attachment_id.',matches:matches.map(f=>({filename:f.fileName,attachment_id:f.id}))});
  const file=matches[0];const n=Number(args.section);
  if(!file||!Number.isInteger(n)||n<1)return 'Unknown attachment or invalid section.';
  const parts=chunks(file.extractedText??'',6000);
  if(n>parts.length)return `Section does not exist. Available: 1–${parts.length}.`;
  return `[Original ${file.fileName} section ${n}/${parts.length}]\n${parts[n-1]}`;
 }
 const query=typeof args.query==='string'?args.query.trim().toLowerCase():'';
 if(query.length<2)return 'Provide a search phrase of at least two characters.';
 const matches=files.flatMap(f=>chunks(f.extractedText??'',6000).flatMap((text,i)=>{
  const at=text.toLowerCase().indexOf(query);if(at<0)return [];
  const heading=text.split('\n').find(line=>/^(#{1,6} |\*\*)/.test(line)&&line.toLowerCase().includes(query));
  return [{filename:f.fileName,attachment_id:f.id,section:i+1,heading:heading?.slice(0,180),excerpt:text.slice(Math.max(0,at-60),at+240),score:heading ? (/^#{1,6} /.test(heading)?3:heading.replace(/^\*\*/, '').toLowerCase().startsWith(query)?2:1):0}];
 })).sort((a,b)=>b.score-a.score||a.section-b.section);
 return JSON.stringify({matches:matches.slice(0,12),totalMatches:matches.length,notice:matches.length>12?'Refine the phrase to find other matches.':undefined});
}
