import { App, TFile } from "obsidian";
import type { DSVKSettings } from "./types";
import { buildSystemPrompt } from "./rules";
import { scanVault, VaultStats } from "./scanner";
import { chatJSON, estimateTokens } from "./deepseek";
import { pricePerM } from "./pricing";

export interface OrganizeOutput {
  summary?: string;
  newTopics?: { path?: string; title?: string; reason?: string; source?: string }[];
  updates?: { path?: string; content?: string; reason?: string }[];
  linkSuggestions?: { from?: string; to?: string; reason?: string }[];
  highlightActions?: { location?: string; answer?: string; confidence?: string; source?: string; nextStep?: string }[];
  nextActions?: string[];
  risks?: string[];
}

export function formatCostEstimate(inputTokens: number, outputTokens: number, model: string): string {
  const p = pricePerM(model);
  const inCost = (inputTokens / 1e6) * p.input;
  const outCost = (outputTokens / 1e6) * p.output;
  return (
    "预估费用 ≈ ¥" + (inCost + outCost).toFixed(3) +
    " (输入 " + inCost.toFixed(4) + " + 输出 " + outCost.toFixed(4) +
    ";按 " + model + " 空闲时段估算,高峰时段约 2 倍)"
  );
}

const OUTPUT_SCHEMA = `## 输出要求
严格输出一个 JSON 对象,不要包含解释、Markdown 代码块或多余文字。结构如下:
{
  "summary": "一句话总结本次整理要点",
  "newTopics": [{"path": "知识库/xx/yy.md", "title": "主题名", "reason": "为什么建", "source": "材料来源(来自哪些 mynote/Internet_source 文件)"}],
  "updates": [{"path": "要更新的主题页路径", "content": "建议补充/修改的具体内容", "reason": "原因"}],
  "linkSuggestions": [{"from": "源笔记", "to": "目标笔记", "reason": "为什么建双链"}],
  "highlightActions": [{"location": "高亮所在文件与上下文", "answer": "尽量给出可靠回答;无法可靠回答则写'待查证'", "confidence": "high|medium|low", "source": "依据来源(必须真实,不可虚构)", "nextStep": "写入解疑答惑|写入知识扩展清单|转入AI-Workspace/controversial"}],
  "nextActions": ["后续可执行的具体动作"],
  "risks": ["本次建议可能存在的风险或需人工复核的点"]
}
规则:不虚构来源;无材料支撑的不建议新建主题;所有建议应增量、具体、可执行。
对可回答的高亮疑问必须给出具体、可核查的回答与真实来源;只有确实无法可靠回答时才标记 confidence=low 并建议转入 AI-Workspace/controversial。`;

export async function buildOrganizeInput(
  app: App,
  settings: DSVKSettings
): Promise<{ user: string; inputTokens: number; scanned: VaultStats }> {
  const stats = await scanVault(app, settings.lastScanTime);
  const parts: string[] = [];

  parts.push("## 扫描结果");
  parts.push("- 新增/更新文件:" + (stats.newOrUpdated.length ? stats.newOrUpdated.map((n) => n.path).join("; ") : "无"));
  parts.push("- 高亮疑问:" + (stats.highlights.length ? stats.highlights.map((h) => h.path + " ×" + h.count + (h.samples.length ? " 例:「" + h.samples.join("」/「") + "」" : "")).join("; ") : "无"));
  parts.push("- 孤立笔记:" + (stats.orphans.length ? stats.orphans.join("; ") : "无"));
  parts.push("- 失效双链:" + (stats.brokenLinks.length ? stats.brokenLinks.map((b) => b.path + "→[[" + b.link + "]]").join("; ") : "无"));
  parts.push("- frontmatter 问题:" + (stats.frontmatterIssues.length ? stats.frontmatterIssues.map((f) => f.path).join("; ") : "无"));

  const topicIndex: string[] = [];
  for (const f of app.vault.getFiles()) {
    if (f.extension === "md" && f.path.startsWith("知识库/") && f.name === "README.md") {
      let c = "";
      try { c = (await app.vault.cachedRead(f)).slice(0, 2000); } catch { continue; }
      topicIndex.push("### " + f.path + "\n" + c);
    }
  }
  if (topicIndex.length) {
    parts.push("## 现有主题索引(README)");
    parts.push(topicIndex.join("\n\n"));
  }

  const contentParts: string[] = [];
  let budget = 40000;
  for (const n of stats.newOrUpdated) {
    if (budget <= 0) break;
    const f = app.vault.getAbstractFileByPath(n.path);
    if (!(f instanceof TFile) || f.extension !== "md") continue;
    let c = "";
    try { c = await app.vault.cachedRead(f); } catch { continue; }
    const snippet = c.slice(0, 6000);
    contentParts.push("### " + n.path + "\n" + snippet);
    budget -= snippet.length;
  }
  if (contentParts.length) {
    parts.push("## 新增/更新笔记内容(截断预览)");
    parts.push(contentParts.join("\n\n"));
  }

  parts.push(OUTPUT_SCHEMA);
  const user = parts.join("\n\n");
  return { user, inputTokens: estimateTokens(user), scanned: stats };
}

export async function runOrganize(app: App, settings: DSVKSettings, input: { user: string }): Promise<{ report: string; usageText: string }> {
  const rules = await buildSystemPrompt(app, settings);
  const user = input.user;
  const system = rules.system + "\n\n【任务说明】按 AI-入口.md 的「每次整理流程」执行:扫描新增/更新 → 优先增量更新现有主题页并补充 Wiki 链接 → 核查结论 → 给出关系与待办建议。";
  const res = await chatJSON<OrganizeOutput>(settings, system, user, { retries: 1 });
  const out = res.value as OrganizeOutput;
  const report = renderOrganizeReport(out);
  const usageText = res.usage
    ? "本次消耗 " + res.usage.totalTokens + " tokens(输入 " + res.usage.promptTokens + " / 输出 " + res.usage.completionTokens + ")。"
    : "";
  return { report, usageText };
}

function cell(s: string | undefined, max = 120): string {
  if (!s) return "-";
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, max);
}

function renderOrganizeReport(out: OrganizeOutput): string {
  const L: string[] = [];
  L.push("# 一键整理建议(AI 生成 · 仅建议未执行)", "");

  L.push("## 总结");
  L.push(cell(out.summary, 500) === "-" ? "-" : out.summary || "-");
  L.push("");

  L.push("## 建议新建主题");
  const nts = out.newTopics || [];
  if (!nts.length) L.push("- 无");
  else {
    L.push("| 路径 | 标题 | 原因 | 材料来源 |");
    L.push("|---|---|---|---|");
    for (const t of nts) L.push("| " + cell(t.path) + " | " + cell(t.title) + " | " + cell(t.reason) + " | " + cell(t.source) + " |");
  }
  L.push("");

  L.push("## 建议更新主题页");
  const ups = out.updates || [];
  if (!ups.length) L.push("- 无");
  else for (const u of ups) L.push("- **" + cell(u.path, 100) + "**: " + cell(u.content, 300) + (u.reason ? "(原因:" + cell(u.reason, 100) + ")" : ""));
  L.push("");

  L.push("## 建议双链");
  const links = out.linkSuggestions || [];
  if (!links.length) L.push("- 无");
  else for (const lk of links) L.push("- [[" + cell(lk.from, 80) + "]] ↔ [[" + cell(lk.to, 80) + "]] — " + cell(lk.reason, 150));
  L.push("");

  L.push("## 高亮疑问处理建议");
  const hls = out.highlightActions || [];
  if (!hls.length) L.push("- 无");
  else {
    L.push("| 位置 | 建议回答 | 置信度 | 来源 | 下一步 |");
    L.push("|---|---|---|---|---|");
    for (const h of hls) L.push("| " + cell(h.location) + " | " + cell(h.answer) + " | " + cell(h.confidence, 10) + " | " + cell(h.source) + " | " + cell(h.nextStep) + " |");
  }
  L.push("");

  L.push("## 后续动作");
  const acts = out.nextActions || [];
  if (!acts.length) L.push("- 无");
  else for (const a of acts) L.push("- " + cell(a, 300));
  L.push("");

  L.push("## 风险 / 需人工复核");
  const risks = out.risks || [];
  if (!risks.length) L.push("- 无");
  else for (const r of risks) L.push("- " + cell(r, 300));
  L.push("");

  L.push("> 本报告为只读建议,未修改任何文件。执行需进入后续版本(预览确认)。");
  return L.join("\n");
}