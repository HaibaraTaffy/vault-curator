import { requestUrl } from "obsidian";
import type { DSVKSettings, ChatMessage, ChatResult, ChatUsage, StreamedToolCall } from "./types";

export class DeepSeekAPIError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "DeepSeekAPIError";
    this.status = status;
  }
}

function friendlyError(status: number, raw: string): string {
  switch (status) {
    case 401: return "API Key 无效或已失效,请到设置页检查。";
    case 402: return "账户余额不足,请到 platform.deepseek.com 充值。";
    case 403: return "无权限访问,请检查 Key 与模型名。";
    case 404: return "接口不存在,请检查 Base URL。";
    case 429: return "请求过于频繁(限流),请稍后再试。";
    case 500: case 502: case 503: return "DeepSeek 服务端错误,请稍后重试。";
    default: return "请求失败(HTTP " + status + "): " + raw.slice(0, 200);
  }
}

export async function deepseekPing(settings: DSVKSettings): Promise<string[]> {
  if (!settings.apiKey) throw new Error("未配置 API Key,请先在设置页填写。");
  const res = await requestUrl({
    url: settings.baseUrl + "/models",
    method: "GET",
    headers: { Authorization: "Bearer " + settings.apiKey },
    throw: false,
  });
  if (res.status !== 200) {
    const msg = res.json && res.json.error ? String(res.json.error.message || "") : res.text;
    throw new DeepSeekAPIError(res.status, friendlyError(res.status, msg));
  }
  const data = res.json && Array.isArray(res.json.data) ? res.json.data : [];
  return data.map((m: { id?: string }) => m.id || "").filter(Boolean);
}

export async function chatCompletion(
  settings: DSVKSettings,
  messages: ChatMessage[],
  opts?: { temperature?: number; maxTokens?: number; tools?: unknown[] }
): Promise<ChatResult> {
  if (!settings.apiKey) throw new Error("未配置 API Key,请先在设置页填写。");
  const body: Record<string, unknown> = {
    model: settings.model,
    messages,
    temperature: opts && typeof opts.temperature === "number" ? opts.temperature : settings.temperature,
    max_tokens: opts && typeof opts.maxTokens === "number" ? opts.maxTokens : settings.maxTokens,
    stream: false,
  };
  if (opts && opts.tools) body.tools = opts.tools;
  const res = await requestUrl({
    url: settings.baseUrl + "/chat/completions",
    method: "POST",
    headers: { Authorization: "Bearer " + settings.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    throw: false,
  });
  if (res.status !== 200) {
    const msg = res.json && res.json.error ? String(res.json.error.message || "") : res.text;
    throw new DeepSeekAPIError(res.status, friendlyError(res.status, msg));
  }
  const j = res.json;
  const content = j && j.choices && j.choices[0] && j.choices[0].message ? String(j.choices[0].message.content || "") : "";
  let usage: ChatUsage | null = null;
  if (j && j.usage) {
    usage = {
      promptTokens: Number(j.usage.prompt_tokens) || 0,
      completionTokens: Number(j.usage.completion_tokens) || 0,
      totalTokens: Number(j.usage.total_tokens) || 0,
    };
  }
  return { content, usage };
}

/** 从模型输出中提取 JSON(支持裸 JSON / 代码块包裹 / 前后杂文) */
export function extractJson(text: string): unknown | null {
  const t = text.trim();
  try { return JSON.parse(t); } catch { /* continue */ }
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) {
    try { return JSON.parse(m[1].trim()); } catch { /* continue */ }
  }
  for (const start of ["{", "["]) {
    const idx = text.indexOf(start);
    if (idx < 0) continue;
    const parsed = parseBalanced(text, idx);
    if (parsed !== null) {
      try { return JSON.parse(parsed); } catch { /* continue */ }
    }
  }
  return null;
}

function parseBalanced(text: string, startIdx: number): string | null {
  const open = text[startIdx];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = startIdx; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) { esc = false; }
      else if (c === "\\") { esc = true; }
      else if (c === '"') { inStr = false; }
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return text.slice(startIdx, i + 1);
    }
  }
  return null;
}

/** 请求结构化 JSON 输出,解析失败自动重试一次 */
export async function chatJSON<T>(
  settings: DSVKSettings,
  system: string,
  user: string,
  opts?: { retries?: number }
): Promise<{ value: T; usage: ChatUsage | null }> {
  const retries = opts && opts.retries ? opts.retries : 1;
  let usage: ChatUsage | null = null;
  let lastErr = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    const instruction =
      "请严格只输出一个合法 JSON 对象,不要包含任何解释、Markdown 代码块或多余文字。";
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      {
        role: "user",
        content: user + "\n\n" + instruction + (attempt > 0 ? "\n\n上次输出不是合法 JSON,错误:" + lastErr : ""),
      },
    ];
    const res = await chatCompletion(settings, messages);
    if (res.usage) usage = res.usage;
    const parsed = extractJson(res.content);
    if (parsed !== null) return { value: parsed as T, usage };
    lastErr = "无法解析 JSON(输出预览:" + res.content.slice(0, 200) + ")";
  }
  throw new Error("模型输出无法解析为 JSON: " + lastErr);
}

/** 粗略 token 估算(中文约 1 token/1.5 字符,英文约 1 token/4 字符) */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[\u4e00-\u9fff]/.test(ch)) cjk++;
    else if (ch !== "\n") other++;
  }
  return Math.ceil(cjk / 1.5 + other / 4);
}

/** SSE 流式对话:实时回调文本增量,并支持函数调用(tool_calls)累积 */
export async function streamChat(
  settings: DSVKSettings,
  messages: ChatMessage[],
  opts: { onDelta: (text: string) => void; signal?: AbortSignal; tools?: unknown[] }
): Promise<{ fullText: string; toolCalls: StreamedToolCall[]; reasoning: string; usage: ChatUsage | null }> {
  if (!settings.apiKey) throw new Error("未配置 API Key,请先在设置页填写。");
  const body: Record<string, unknown> = {
    model: settings.model,
    messages,
    temperature: settings.temperature,
    max_tokens: settings.maxTokens,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (opts.tools) body.tools = opts.tools;

  const ctrl = new AbortController();
  const TIMEOUT_MS = 180000;
  const onExternalAbort = (): void => { ctrl.abort(); };
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener("abort", onExternalAbort, { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(new DOMException("timeout", "TimeoutError")), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(settings.baseUrl + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + settings.apiKey },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener("abort", onExternalAbort);
    throw e;
  }
  if (!res.ok) {
    let raw = "";
    try { raw = await res.text(); } catch { /* ignore */ }
    let msg = raw;
    try { const j = JSON.parse(raw); if (j.error && j.error.message) msg = j.error.message; } catch { /* ignore */ }
    throw new DeepSeekAPIError(res.status, friendlyError(res.status, msg));
  }
  if (!res.body) throw new Error("响应无数据流");

  const reader = res.body.getReader();
  const dec = new TextDecoder("utf-8");
  let buf = "";
  let fullText = "";
  let reasoning = "";
  let usage: ChatUsage | null = null;
  const tcAcc = new Map<number, { id: string; name: string; args: string }>();

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const data = t.slice(5).trim();
      if (data === "[DONE]") continue;
      let j: any;
      try { j = JSON.parse(data); } catch { continue; }
      const choice = j.choices && j.choices[0];
      if (choice && choice.delta) {
        const d = choice.delta;
        if (typeof d.reasoning_content === "string" && d.reasoning_content) {
          reasoning += d.reasoning_content;
        }
        if (typeof d.content === "string" && d.content) {
          fullText += d.content;
          opts.onDelta(d.content);
        }
        if (Array.isArray(d.tool_calls)) {
          for (const tc of d.tool_calls) {
            const idx = typeof tc.index === "number" ? tc.index : 0;
            const rec = tcAcc.get(idx) || { id: "", name: "", args: "" };
            if (tc.id) rec.id += tc.id;
            if (tc.function) {
              if (tc.function.name) rec.name += tc.function.name;
              if (typeof tc.function.arguments === "string") rec.args += tc.function.arguments;
            }
            tcAcc.set(idx, rec);
          }
        }
      }
      if (j.usage) {
        usage = {
          promptTokens: Number(j.usage.prompt_tokens) || 0,
          completionTokens: Number(j.usage.completion_tokens) || 0,
          totalTokens: Number(j.usage.total_tokens) || 0,
        };
      }
    }
  }

  clearTimeout(timer);
  if (opts.signal) opts.signal.removeEventListener("abort", onExternalAbort);

  const toolCalls = Array.from(tcAcc.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, r]) => ({ id: r.id, name: r.name, arguments: r.args || "{}" }));
  return { fullText, toolCalls, reasoning, usage };
}