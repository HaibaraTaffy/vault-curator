import { App } from "obsidian";
import type { DSVKSettings, ChatMessage, ChatUsage } from "./types";
import { buildSystemPrompt } from "./rules";
import { streamChat, chatCompletion } from "./deepseek";
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
  /** 对话摘要(压缩旧消息后产生),注入上下文作为背景 */
  summary?: string;
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
    "你是运行在 Obsidian 知识库中的 AI 助手,拥有查看、搜索和修改笔记的工具。",
    "如何使用工具、如何整理仓库,遵循 vault 规则文档(如已配置);没有规则时,按用户的明确指示行事,不要擅自发明工作流。",
    "回答用用户使用的语言,简洁、先给结论;引用笔记内容或给出结论时,在句末用 [[路径]] 标注来源;无法溯源的说明「来源待核」。",
    "当用户要求创建/更新/移动/删除/扫描/搜索/读取笔记时,必须实际调用对应工具完成,不能只口头说明打算怎么做。",
    "完成任务后用 1-2 句话汇报结果,不要复述操作步骤或长篇解释。",
    "引用文件路径时用纯文本路径或 [[路径]],不要用反引号包裹。",
    "绝不执行 git 或 shell 操作,绝不修改 .git/.obsidian(本插件自身除外)/.claudian。",
  ].join("\n");
  const system = rules.system + "\n\n" + persona;

  const historyBase = stripDisplayFields(session.messages.slice(-settings.chatHistory));
  if (session.summary) {
    historyBase.unshift({ role: "system", content: "【对话摘要(此前历史,供背景参考)】\n" + session.summary.slice(0, 1500) });
  }
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
      ? "⚠️ 本轮工具调用次数已达上限,未生成最终回复。已执行的工具见上方记录;写操作结果见变更日志(数据目录 change-log/)。"
      : "⚠️ 本轮未生成文字回复(可能是模型输出异常)。已执行的工具见上方记录;写操作结果见变更日志(数据目录 change-log/)。";
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

/** 压缩会话:把旧消息(保留最近 keepRecent 条)用 DeepSeek 摘要替代;失败则保持原样 */
export async function compressSession(
  app: App,
  settings: DSVKSettings,
  session: Session,
  opts?: { keepRecent?: number }
): Promise<{ removed: number; summary: string; savedChars: number }> {
  const keep = opts && opts.keepRecent ? opts.keepRecent : settings.keepRecent;
  const split = session.messages.length - keep;
  if (split <= 3) return { removed: 0, summary: session.summary || "", savedChars: 0 };

  const oldMsgs = session.messages.slice(0, split);
  const newMsgs = session.messages.slice(split);
  const text = oldMsgs
    .filter((m) => (m.content || "").trim())
    .map((m) => (m.role === "user" ? "用户: " : "助手: ") + String(m.content || "").slice(0, 2000))
    .join("\n\n");
  const oldSummary = session.summary || "";
  const promptText = (oldSummary ? "【已有摘要】\n" + oldSummary + "\n\n【新增对话】\n" : "【对话】\n") + text;

  const sys =
    "你是对话压缩器。把给定的对话内容压缩成 200-400 字的结构化中文要点,保留:用户的意图与请求、已执行的关键操作及结果(尤其是文件路径)、结论与答复要点、未完成的待办。只输出摘要,不要复述原文。";
  try {
    const res = await chatCompletion(settings, [
      { role: "system", content: sys },
      { role: "user", content: promptText },
    ], { maxTokens: 800, temperature: 0.2 });
    const summary = (res.content || "").trim().slice(0, 2000);
    if (summary) {
      session.summary = summary;
      session.messages = newMsgs;
      return { removed: oldMsgs.length, summary, savedChars: text.length };
    }
  } catch (e) {
    // 压缩失败:保持原样
  }
  return { removed: 0, summary: session.summary || "", savedChars: 0 };
}