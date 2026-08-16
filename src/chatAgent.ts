import { App } from "obsidian";
import type { DSVKSettings, ChatMessage, ChatUsage } from "./types";
import { buildSystemPrompt } from "./rules";
import { streamChat } from "./deepseek";
import { toolsForRequest, executeTool } from "./tools";
import type { WriteProposal } from "./writer";

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  totalPromptTokens: number;
  totalCompletionTokens: number;
}

export interface ToolLogEntry {
  name: string;
  args: string;
  result: string;
  /** 该工具在最终正文中的插入位置(字符偏移);旧数据可能缺失 */
  pos?: number;
}

export interface TurnCallbacks {
  onStatus: (text: string) => void;
  onDelta: (text: string) => void;
  onTool?: (log: ToolLogEntry) => void;
  signal?: AbortSignal;
}

const MAX_LOOP = 6;

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch (e) {
    return {};
  }
}

/** 发送前剥离展示用元数据,避免重复计入上下文 */
function stripDisplayFields(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    const c = { ...m } as ChatMessage & { tool_log?: unknown; reasoning?: unknown };
    delete c.tool_log;
    delete c.reasoning;
    return c;
  });
}

export async function runAgentTurn(
  app: App,
  settings: DSVKSettings,
  session: Session,
  userText: string,
  cb: TurnCallbacks,
  ctx?: string | null
): Promise<{ text: string; usage: ChatUsage | null; reasoning: string; toolLog: ToolLogEntry[]; pendingProposals: WriteProposal[] }> {
  session.messages.push({ role: "user", content: userText });

  const rules = await buildSystemPrompt(app, settings);
  const persona = [
    "你是「VaultCurator」,一个 DeepSeek 驱动的知识库管家,只在这个 Obsidian 知识库内工作。",
    "你可以调用工具查看仓库(扫描/读笔记/搜索/列目录/规则状态),也可以执行写操作(新建/更新/移动/删除笔记,自动写变更日志)。",
    "回答用中文,简洁、可溯源;整理建议遵守规则文档;绝不执行 git 或 shell 操作,绝不修改 .git/.obsidian(本插件自身除外)/.claudian。",
    "写操作只允许在 知识库/、mynote/、Internet_source/、AI-Workspace/、pasted_picture/ 下进行。",
    "当用户要求创建/更新/移动/删除/扫描/搜索/读取笔记时,你必须实际调用对应工具完成操作,绝不能只口头说明打算怎么做。",
    "回答尽量简短:先给结论,需要时再补充。",
    "完成任务后只需用 1-2 句话汇报结果,例如「已创建 知识库/03-…/RAG.md」或「已更新 xxx、移动 xxx」。",
    "不要复述操作步骤,不要长篇展开「整理说明/原理」;用户需要细节或解释时会继续追问。",
    "引用文件路径时用纯文本路径或 wiki 链接 [[路径]],不要用反引号包裹文件路径。",
    "引用某篇笔记的内容或给出结论时,在相应句末用 [[笔记路径]] 标注来源;确实无法溯源的结论要说明「来源待核」。",
  ].join("\n");
  const system = rules.system + "\n\n" + persona;

  const historyBase = stripDisplayFields(session.messages.slice(-settings.chatHistory));
  if (historyBase.length && ctx) {
    historyBase[historyBase.length - 1] = { ...historyBase[historyBase.length - 1], content: ctx + "\n\n" + userText };
  }

  const toolLog: ToolLogEntry[] = [];
  const pendingProposals: WriteProposal[] = [];
  let reasoning = "";
  let finalText = "";
  let usage: ChatUsage | null = null;

  let loopExhausted = false;
  const useTools = settings.model !== "deepseek-reasoner";
  if (!useTools) {
    const messages: ChatMessage[] = [{ role: "system", content: system }, ...historyBase];
    const res = await streamChat(settings, messages, { onDelta: cb.onDelta, signal: cb.signal });
    reasoning = res.reasoning;
    finalText = res.fullText;
    usage = res.usage;
  } else {
    const messages: ChatMessage[] = [{ role: "system", content: system }, ...historyBase];
    let cumulativeText = "";
    for (let round = 0; round < MAX_LOOP; round++) {
      const res = await streamChat(settings, messages, {
        onDelta: cb.onDelta,
        signal: cb.signal,
        tools: toolsForRequest(),
      });
      if (res.usage) usage = res.usage;
      cumulativeText += res.fullText || "";
      const toolCalls = res.toolCalls;
      if (!toolCalls || !toolCalls.length) {
        finalText = cumulativeText;
        break;
      }
      if (round === MAX_LOOP - 1) loopExhausted = true;
      console.log("[VaultCurator] round " + round + " tools: " + toolCalls.map((t) => t.name).join(",") + " textLen: " + (res.fullText || "").length);
      messages.push({
        role: "assistant",
        content: res.fullText || null,
        tool_calls: toolCalls.map((tc) => ({ id: tc.id, type: "function" as const, function: { name: tc.name, arguments: tc.arguments } })),
      });
      for (const tc of toolCalls) {
        let result: string;
        try {
          cb.onStatus("🔧 " + tc.name + "…");
          const r = await executeTool(tc.name, parseArgs(tc.arguments), app, settings);
          result = r.text;
          if (r.proposal) pendingProposals.push(r.proposal);
        } catch (e) {
          result = "工具执行失败:" + (e instanceof Error ? e.message : String(e));
        }
        cb.onStatus("✓ " + tc.name + " 完成");
        const entry: ToolLogEntry = { name: tc.name, args: tc.arguments, result: result.slice(0, 400), pos: cumulativeText.length };
        toolLog.push(entry);
        if (cb.onTool) cb.onTool(entry);
        messages.push({ role: "tool", tool_call_id: tc.id, content: result.slice(0, 8000) });
      }
    }
  }

  if (!finalText.trim()) {
    finalText = loopExhausted
      ? "⚠️ 本轮工具调用次数已达上限,未生成最终回复。已执行的工具见上方记录;写操作结果可在 AI-Workspace/change-log/ 查看。"
      : "⚠️ 本轮未生成文字回复(可能是模型输出异常)。已执行的工具见上方记录;写操作结果可在 AI-Workspace/change-log/ 查看。";
  }
  const assistantMsg: ChatMessage = { role: "assistant", content: finalText };
  if (reasoning) assistantMsg.reasoning = reasoning.slice(0, 4000);
  if (toolLog.length) {
    assistantMsg.tool_log = toolLog.slice(0, 12).map((t) => ({
      name: t.name,
      args: t.args.slice(0, 200),
      result: t.result.slice(0, 300),
      pos: t.pos,
    }));
  }
  session.messages.push(assistantMsg);
  session.updatedAt = Date.now();
  return { text: finalText, usage, reasoning, toolLog, pendingProposals };
}