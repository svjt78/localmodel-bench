import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type {
  ClientCommand,
  ControllerEvent,
  ConversationMessage,
  ToolCallRecord,
} from "@ollama-local/shared";
import type { ConversationStore } from "./services/conversationStore.js";
import { streamChat, generateTitle, GenerationError } from "./services/ollamaClient.js";
import { ATTACHMENT_TOOLS,retrieveAttachment } from "./services/attachmentRetrieval.js";
import { ContextPolicy, loadProfile, assertMemory } from "./services/contextPolicy.js";
import { buildChatHistory } from "./services/chatHistory.js";
import { fetchInstalledModels } from "./services/modelRegistry.js";
import { buildNamedWorkspaceRoots, type NamedRoot } from "./services/workspace.js";
import {
  TOOL_DEFINITIONS,
  FETCH_URL_TOOL_DEFINITION,
  TOOL_CALL_BUDGET,
  executeToolCall,
  budgetExceededMessage,
} from "./services/toolLoop.js";
import type { DiagnosticsLog } from "./services/diagnosticsLog.js";
import type { PreferencesStore } from "./services/preferences.js";

// Without this, the model only ever sees the `tools` JSON schema with no
// framing telling it a workspace even exists — vague phrasing like "refer to
// work spaces" then just makes it ask for clarification instead of looking.
function buildWorkspaceSystemMessage(namedRoots: NamedRoot[]): string {
  const names = namedRoots.map((r) => `"${r.name}"`).join(", ");
  const plural = namedRoots.length > 1 ? "s" : "";
  const addressing =
    namedRoots.length > 1
      ? ` These are ${namedRoots.length} separate top-level workspaces, not subfolders of each other. Call ` +
        `list_directory(".") first to see them listed by name, then use "<name>/..." as the path prefix ` +
        `for anything inside a specific one — e.g. list_directory("${namedRoots[1].name}") or ` +
        `read_file("${namedRoots[1].name}/somefile.txt"). A bare path with no "<name>/" prefix (other than ".") ` +
        `will fail.`
      : "";
  return (
    `You have read-only tool access to the attached workspace folder${plural}: ${names}.${addressing} ` +
    `You can call list_directory, read_file, and search_files at any time — you do not need ` +
    `the user's permission to use them, and there is no cost to trying. ` +
    `Any question that could plausibly be about these workspaces (e.g. "what does this talk about", ` +
    `"what are these", "summarize this", or anything referencing "the workspace"/"these files"/"this project") ` +
    `should be answered by FIRST calling list_directory on "." to see what's there, then read_file on anything ` +
    `relevant, and only THEN answering. Do not ask the user to clarify which workspace or file they mean until ` +
    `after you have actually looked — an ambiguous question is a reason to explore, not a reason to stop and ask.`
  );
}

// Told explicitly and separately from the workspace message so the model
// doesn't conflate "read a local file" with "fetch a URL" — and, critically,
// doesn't start inventing URLs to "search" with a tool that can't search.
function buildFetchToolSystemMessage(): string {
  return (
    "You have a fetch_url tool that retrieves the content of one specific web page or PDF, given its exact " +
    "URL — use it whenever the user gives you a URL, or one is already present in this conversation. It is " +
    "NOT a search engine: it cannot discover new URLs, so never invent or guess a URL to try with it."
  );
}

function cleanTitle(raw: string): string {
  let title = raw.trim();
  title = title.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim(); // strip wrapping quotes the model sometimes adds
  title = title.replace(/\s+/g, " "); // collapse stray newlines/whitespace to one line
  title = title.replace(/\.+$/, "").trim(); // drop a trailing period
  if (title.length > 80) title = `${title.slice(0, 80)}…`;
  return title;
}

interface TurnHandle {
  abortController: AbortController;
}

// Hard ceiling on total re-POSTs to Ollama in one turn, independent of the
// 8-tool-call budget — a model that keeps requesting tools past the budget
// still gets a bounded number of chances to give up and answer.
const MAX_LOOP_ITERATIONS = 20;

export class WsSessionManager {
  private readonly sockets = new Set<WebSocket>();
  private readonly activeTurns = new Map<string, TurnHandle>();

  constructor(
    private readonly store: ConversationStore,
    private readonly diagnostics: DiagnosticsLog,
    private readonly preferences: PreferencesStore,
  ) {}

  handleConnection(ws: WebSocket): void {
    this.sockets.add(ws);
    ws.on("close",()=>this.sockets.delete(ws));
    ws.on("message", (raw) => {
      let command: ClientCommand;
      try {
        command = JSON.parse(raw.toString()) as ClientCommand;
      } catch {
        return;
      }
      this.handleCommand(ws, command).catch((err: unknown) => {
        this.send(ws, {
          type: "diagnostic",
          level: "error",
          message: "Unexpected server error",
          detail: err instanceof Error ? err.message : String(err),
        });
      });
    });
  }

  private send(ws: WebSocket, event: ControllerEvent): void {
    const targets = 'conversationId' in event ? this.sockets : new Set([ws]);
    for (const target of targets) if (target.readyState === target.OPEN) target.send(JSON.stringify(event));
  }

  private async handleCommand(ws: WebSocket, command: ClientCommand): Promise<void> {
    switch (command.type) {
      case "new_conversation": {
        const id = randomUUID();
        this.store.createConversation({
          id,
          title: "New conversation",
          model: command.model,
          workspaceSet: command.workspaceSet,
          internetEnabled: Boolean(command.internetEnabled),
        });
        const conversation = this.store.getConversation(id);
        if (conversation) {
          this.send(ws, { type: "conversation_created", conversation });
        }
        return;
      }
      case "send_message":
        await this.runTurn(ws, command.conversationId, command.text, command.messageAttachmentIds ?? []);
        return;
      case "upgrade_conversation": {
        if(this.activeTurns.has(command.conversationId)) throw new Error("Stop the response before upgrading.");
        const c=this.store.getConversation(command.conversationId); if(!c)throw new Error("Conversation not found");
        const prior=this.store.execution(c.id);
        if(prior.version<1){this.store.saveRecord("upgrade:"+c.id,{prior,time:Date.now()});this.store.setExecution(c.id,{...prior,version:1});}
        this.send(ws,{type:"conversation_loaded",conversation:this.store.getConversation(c.id)!});return;
      }
      case "retry_response":
        await this.runTurn(ws,command.conversationId,"retry",[],true);return;
      case "interrupt_turn":
        this.activeTurns.get(command.conversationId)?.abortController.abort();
        return;
      case "switch_model":
        if (this.activeTurns.has(command.conversationId)) return;
        this.store.setConversationModel(command.conversationId, command.model);
        return;
    }
  }

  private async runTurn(
    ws: WebSocket,
    conversationId: string,
    text: string,
    messageAttachmentIds: string[],
    retry = false,
  ): Promise<void> {
    let conversation = this.store.getConversation(conversationId);
    if (!conversation) {
      this.send(ws, { type: "diagnostic", level: "error", message: "Conversation not found" });
      return;
    }

    if (this.activeTurns.has(conversationId)) {
      this.send(ws, { type: "diagnostic", level: "warning", message: "A response is already running in this conversation." });
      return;
    }
    if (typeof text !== "string" || !text.trim() || !Array.isArray(messageAttachmentIds) ||
        !messageAttachmentIds.every((id) => typeof id === "string")) {
      this.send(ws, { type: "turn_state", conversationId, status: "failed", detail: "Invalid message or attachments." });
      return;
    }
    const priorExecution=this.store.execution(conversationId);
    const previousUser=retry ? [...conversation.messages].reverse().find(m=>m.role==='user') : undefined;
    if(retry && !previousUser) throw new Error("No previous question to retry.");
    if(previousUser){text=previousUser.text;conversation={...conversation,messages:conversation.messages.slice(0,conversation.messages.findIndex(m=>m.id===previousUser.id))};}
    const isFirstMessage = conversation.messages.length === 0 && !retry;
    const userMessage: ConversationMessage = previousUser ?? {
      id: randomUUID(), role: "user", text, createdAt: Date.now(),
    };
    const abortController = new AbortController();
    this.activeTurns.set(conversationId, { abortController });
    this.send(ws, { type: "turn_state", conversationId, status: "running" });

    let assistantMessageId = randomUUID();
    let assistantText = "";
    const executedToolCalls: ToolCallRecord[] = [];

    let contextNotice="";
    const progress=(detail:string)=>{
      if(detail.startsWith("Using "))contextNotice=detail;
      this.store.setExecution(conversationId,{version:priorExecution.version,status:"running",detail,updatedAt:Date.now(),partial:assistantText?{id:assistantMessageId,role:"assistant",text:assistantText,createdAt:Date.now(),incomplete:true,streaming:true}:undefined});
      this.send(ws,{type:"turn_state",conversationId,status:"running",detail});
    };
    progress("Preparing response…");
    try {
      const namedRoots: NamedRoot[] = conversation.workspaceSet
        ? buildNamedWorkspaceRoots(conversation.workspaceSet)
        : [];
      const models = await fetchInstalledModels(abortController.signal).catch(() => []);
      const modelOption = models.find((m) => m.name === conversation.model);
      const workspaceToolsEnabled = namedRoots.length > 0 && Boolean(modelOption?.supportsTools);
      const fetchToolEnabled = conversation.internetEnabled && Boolean(modelOption?.supportsTools);
      const tools = [
        ...(workspaceToolsEnabled ? TOOL_DEFINITIONS : []),
        ...(fetchToolEnabled ? [FETCH_URL_TOOL_DEFINITION] : []),
        ...(priorExecution.version>=1 && modelOption?.supportsTools ? ATTACHMENT_TOOLS : []),
      ];

      if(!retry) userMessage.attachments = this.store.getPendingAttachments(conversationId, messageAttachmentIds);
      // Check vision before model preparation, preserving pending attachments on rejection.
      const initialHistory=await buildChatHistory(this.store,conversation,userMessage,modelOption);
      if(!retry) {this.store.appendUserMessage(conversationId,userMessage,messageAttachmentIds);this.send(ws,{type:"message",conversationId,message:userMessage});}
      const profile=priorExecution.version>=1 ? await loadProfile(this.store,conversation.model,abortController.signal) : undefined;
      const policy=profile ? new ContextPolicy(this.store,conversation.model,profile,abortController.signal,progress,conversationId) : undefined;
      const history = policy ? await buildChatHistory(this.store,conversation,userMessage,modelOption,(doc,label)=>policy.document(doc,label,text)) : initialHistory;
      abortController.signal.throwIfAborted();
      // Validate images and capabilities before persisting a user turn or consuming draft files.


      if (workspaceToolsEnabled) {
        history.unshift({ role: "system", content: buildWorkspaceSystemMessage(namedRoots) });
      }

      if (fetchToolEnabled) {
        history.unshift({ role: "system", content: buildFetchToolSystemMessage() });
      }

      const systemPrompt = this.preferences.get().systemPrompt.trim();
      if (systemPrompt) {
        history.unshift({ role: "system", content: systemPrompt });
      }

      let toolCallCount = 0;
      let answered=false;

      for (let iteration = 0; iteration < MAX_LOOP_ITERATIONS; iteration += 1) {
        let result: Awaited<ReturnType<typeof streamChat>> | undefined;
        for(let attempt=0;attempt<(policy?2:1);attempt++) {
          const output=attempt?16384:8192;
          const prepared=policy?await policy.prepare(history,output,tools.length?tools:undefined):{messages:history,capacity:32768,estimated:0};
          const attemptId=randomUUID();const started=Date.now();
          const record=(status:string,extra:object={})=>this.store.saveRecord('attempt:'+attemptId,{conversationId,userMessageId:userMessage.id,retry,status,started,finished:Date.now(),capacity:prepared.capacity,output,...extra});
          let lastPersist=0;
          try {
            if(policy)assertMemory();progress(attempt?'Recovering response with more answer space…':'Answering…');
            result=await streamChat({model:conversation.model,messages:prepared.messages,tools:tools.length?tools:undefined,
              signal:abortController.signal,options:{num_ctx:prepared.capacity,num_predict:output},
              onThinking:()=>{if(Date.now()-lastPersist>1000){progress('Thinking…');lastPersist=Date.now();}},
              onDelta:(delta)=>{assistantText+=delta;this.send(ws,{type:'message_delta',conversationId,messageId:assistantMessageId,delta});
                if(Date.now()-lastPersist>500){progress('Answering…');lastPersist=Date.now();}}
            });
            policy?.reconcile(prepared.messages,tools.length?tools:undefined,result.promptEvalCount);
            record('completed',{usage:result});break;
          } catch(error) {
            record('incomplete',{reason:error instanceof GenerationError?error.reason:'request',partial:assistantText});
            if(error instanceof GenerationError)policy?.reconcile(prepared.messages,tools.length?tools:undefined,error.result?.promptEvalCount);
            if(policy && attempt===0 && error instanceof GenerationError && error.reason==='length'){
              const partial:ConversationMessage={id:assistantMessageId,role:'assistant',text:assistantText,createdAt:Date.now(),incomplete:true,attemptId};
              this.store.appendMessage(conversationId,partial);this.send(ws,{type:'message',conversationId,message:partial});
              assistantMessageId=randomUUID();assistantText='';continue;
            }
            throw error;
          }
        }
        if(!result)throw new Error('Response attempts exhausted. Partial work saved.');

        if (result.toolCalls.length === 0) {
          answered=true; break;
        }

        history.push({ role: "assistant", content: result.fullText, tool_calls: result.toolCalls });

        for (const call of result.toolCalls) {
          const name = call.function.name;
          const args = call.function.arguments ?? {};
          const id = randomUUID();

          if (toolCallCount >= TOOL_CALL_BUDGET) {
            history.push({ role: "tool", content: budgetExceededMessage() });
            continue;
          }
          toolCallCount += 1;

          this.send(ws, {
            type: "tool_call_started",
            conversationId,
            call: { id, name: name as ToolCallRecord["name"], args, workspacePath: namedRoots[0]?.path ?? "" },
          });

          const attachmentTool=name==='read_attachment'||name==='search_attachments';
          const attachmentResult=attachmentTool?retrieveAttachment(this.store,conversationId,name,args):'';
          const executed = attachmentTool ? {record:{id,name:name as ToolCallRecord['name'],args,result:attachmentResult,workspacePath:''},resultText:attachmentResult,pathViolation:false} : await executeToolCall(namedRoots, id, name, args);
          executedToolCalls.push(executed.record);
          this.send(ws, { type: "tool_call_completed", conversationId, call: executed.record });
          history.push({ role: "tool", content: executed.resultText });

          if (executed.pathViolation) {
            this.diagnostics.add({
              level: "warning",
              message: `Tool call rejected: path escapes workspace roots`,
              detail: `${name} ${JSON.stringify(args)}`,
            });
          }
        }
      }

      if(!answered)throw new Error("Tool iteration allowance exhausted without a final answer. Partial work saved.");
      if(!assistantText.trim()) throw new Error("Tool steps ended without a visible answer. Retry explicitly.");
      const assistantMessage: ConversationMessage = {
        id: assistantMessageId,
        role: "assistant",
        text: assistantText,
        toolCalls: executedToolCalls.length > 0 ? executedToolCalls : undefined,
        createdAt: Date.now(),
      };
      this.store.appendMessage(conversationId, assistantMessage);
      this.send(ws, { type: "message", conversationId, message: assistantMessage });
      this.store.setExecution(conversationId,{version:priorExecution.version,status:"completed",detail:contextNotice||undefined,updatedAt:Date.now()});
      this.send(ws, { type: "turn_state", conversationId, status: "completed", detail:contextNotice||undefined });

      if (isFirstMessage && conversation.title === "New conversation") {
        void this.generateAndApplyTitle(ws, conversationId, text, assistantText, conversation.model);
      }
    } catch (err) {
      const aborted = abortController.signal.aborted;

      if (assistantText || executedToolCalls.length > 0) {
        const partialMessage: ConversationMessage = {
          id: assistantMessageId,
          role: "assistant",
          text: assistantText,
          incomplete:true,
          toolCalls: executedToolCalls.length > 0 ? executedToolCalls : undefined,
          createdAt: Date.now(),
        };
        this.store.appendMessage(conversationId, partialMessage);
        this.send(ws, { type: "message", conversationId, message: partialMessage });
      }

      if (!aborted) {
        this.diagnostics.add({
          level: "error",
          message: "Turn failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }

      this.store.setExecution(conversationId,{version:priorExecution.version,status:aborted?"interrupted":"failed",updatedAt:Date.now(),detail:err instanceof Error?err.message:String(err)});
      this.send(ws, {
        type: "turn_state",
        conversationId,
        status: aborted ? "interrupted" : "failed",
        detail: aborted ? undefined : err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.activeTurns.delete(conversationId);
    }
  }

  // Fire-and-forget: runs after the turn has already been reported complete,
  // so it can never delay or affect the visible response. Always uses the
  // fastest installed model (alias "qfast") for the naming call regardless
  // of which model the conversation itself uses, falling back to that
  // model if no fast one is installed.
  private async generateAndApplyTitle(
    ws: WebSocket,
    conversationId: string,
    userText: string,
    assistantText: string,
    conversationModel: string,
  ): Promise<void> {
    try {
      const models = await fetchInstalledModels().catch(() => []);
      const fastModel = models.find((m) => m.alias === "qfast");
      const titlingModel = fastModel?.name ?? conversationModel;

      const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
      const prompt =
        `Write a short, plain-text title (3 to 6 words) summarizing the topic of the exchange below. ` +
        `Do not use quotation marks, markdown, or a trailing period. Reply with ONLY the title, nothing else.\n\n` +
        `User: ${truncate(userText.trim(), 400)}\n` +
        `Assistant: ${truncate(assistantText.trim(), 400)}`;

      let title = "";
      try {
        title = cleanTitle(await generateTitle(titlingModel, prompt));
      } catch {
        title = "";
      }

      if (!title) {
        // Fallback so a conversation is never permanently stuck at the
        // default, even if the titling model/call fails outright.
        const trimmed = userText.trim();
        title = trimmed.length > 50 ? `${trimmed.slice(0, 50)}…` : trimmed;
      }
      if (!title) return;

      // The titling call can take a few seconds — re-check the title
      // hasn't been manually changed in the meantime before overwriting it.
      const current = this.store.getConversation(conversationId);
      if (!current || current.title !== "New conversation") return;

      this.store.renameConversation(conversationId, title);
      this.send(ws, { type: "conversation_renamed", conversationId, title });
    } catch {
      // Best-effort background nicety — never surface a failure here.
    }
  }
}
