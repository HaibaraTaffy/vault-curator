import { App, TFile } from "obsidian";

export interface FileIssue { path: string; issues: string[] }
export interface HighlightHit { path: string; count: number; samples: string[] }
export interface BrokenLink { path: string; link: string }
export interface VaultStats {
  scannedAt: number;
  totalFiles: number;
  totalMd: number;
  topLevel: { name: string; fileCount: number; mdCount: number }[];
  newOrUpdated: { path: string; hasLastUpdated: boolean; lastUpdated?: string }[];
  highlights: HighlightHit[];
  orphans: string[];
  brokenLinks: BrokenLink[];
  frontmatterIssues: FileIssue[];
  approxTokens: number;
}

const EXCLUDE_DIRS = new Set([".obsidian", ".claudian", ".git", ".trash"]);

export function isExcluded(p: string): boolean {
  return p.split("/").some((s) => EXCLUDE_DIRS.has(s));
}

export function parseFrontmatter(content: string): { fields: Record<string, string>; hasFrontmatter: boolean } {
  const norm = content.replace(/\r\n/g, "\n");
  if (!norm.startsWith("---\n")) return { fields: {}, hasFrontmatter: false };
  const end = norm.indexOf("\n---\n", 4);
  if (end < 0) return { fields: {}, hasFrontmatter: false };
  const block = norm.slice(4, end);
  const fields: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const m = /^([\w\u4e00-\u9fa5-]+):\s*(.*)$/.exec(line);
    if (m) fields[m[1].trim()] = m[2].trim();
  }
  return { fields, hasFrontmatter: true };
}

function extractWikiLinks(content: string): string[] {
  const out: string[] = [];
  const re = /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const target = m[1].trim();
    if (target) out.push(target);
  }
  return out;
}

function countHighlights(content: string): { count: number; samples: string[] } {
  const re = /==([^=\n]+)==/g;
  const samples: string[] = [];
  let total = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    // 反引号代码跨度内的 ==...== 是说明文字,不算高亮
    const before = m.index > 0 ? content[m.index - 1] : "";
    const after = m.index + m[0].length < content.length ? content[m.index + m[0].length] : "";
    if (before === "`" || after === "`") continue;
    total++;
    if (samples.length < 5) samples.push(m[1].trim().slice(0, 60));
  }
  return { count: total, samples };
}

export async function scanVault(app: App, lastScanTime: number, dataDir?: string): Promise<VaultStats> {
  const files = app.vault.getFiles();
  const mdFiles = files.filter((f) => f.extension === "md" && !isExcluded(f.path));
  const stats: VaultStats = {
    scannedAt: Date.now(),
    totalFiles: files.filter((f) => !isExcluded(f.path)).length,
    totalMd: mdFiles.length,
    topLevel: [],
    newOrUpdated: [],
    highlights: [],
    orphans: [],
    brokenLinks: [],
    frontmatterIssues: [],
    approxTokens: 0,
  };

  const byPath = new Map<string, TFile>();
  for (const f of mdFiles) byPath.set(f.path, f);

  const top = new Map<string, { fileCount: number; mdCount: number }>();
  for (const f of files) {
    if (isExcluded(f.path)) continue;
    const first = f.path.split("/")[0];
    const rec = top.get(first) || { fileCount: 0, mdCount: 0 };
    rec.fileCount++;
    if (f.extension === "md") rec.mdCount++;
    top.set(first, rec);
  }
  stats.topLevel = Array.from(top.entries())
    .map(([name, r]) => ({ name, fileCount: r.fileCount, mdCount: r.mdCount }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const linkTargets = new Set<string>();
  for (const f of mdFiles) {
    let content = "";
    try { content = await app.vault.cachedRead(f); } catch { continue; }
    for (const l of extractWikiLinks(content)) {
      const base = l.split("/").pop() || l;
      linkTargets.add(l);
      linkTargets.add(l + ".md");
      linkTargets.add(base);
      linkTargets.add(base + ".md");
    }
  }

  let approxChars = 0;
  for (const f of mdFiles) {
    let content = "";
    try { content = await app.vault.cachedRead(f); } catch { continue; }
    approxChars += content.length;

    const fm = parseFrontmatter(content);

    if (f.stat.mtime > lastScanTime) {
      stats.newOrUpdated.push({
        path: f.path,
        hasLastUpdated: !!fm.fields.last_updated,
        lastUpdated: fm.fields.last_updated,
      });
    }

    const h = countHighlights(content);
    if (h.count > 0) stats.highlights.push({ path: f.path, count: h.count, samples: h.samples });

    for (const l of extractWikiLinks(content)) {
      const base = l.split("/").pop() || l;
      const candidates = [l, l + ".md", base, base + ".md"];
      const ok = candidates.some((c) => byPath.has(c));
      if (!ok) {
        stats.brokenLinks.push({ path: f.path, link: l });
      }
    }

    const dataDirPrefix = (dataDir || "AI-Workspace") + "/";
    if (f.name !== "README.md" && !f.path.includes("/_模板/") && !f.path.startsWith(dataDirPrefix)) {
      const issues: string[] = [];
      if (!fm.hasFrontmatter) issues.push("缺少 frontmatter(规范要求 title/last_updated/sources)");
      else {
        if (!fm.fields.title) issues.push("缺少 title");
        if (!fm.fields.last_updated) issues.push("缺少 last_updated");
        if (!fm.fields.sources) issues.push("缺少 sources(可为空列表 [])");
      }
      if (issues.length) stats.frontmatterIssues.push({ path: f.path, issues });
    }
  }

  for (const f of mdFiles) {
    const basename = f.basename;
    if (basename === "README" || f.path.startsWith("知识库/_模板/")) continue;
    const inTarget = linkTargets.has(f.path) || linkTargets.has(basename) || linkTargets.has(f.path.replace(/\.md$/, ""));
    if (!inTarget) stats.orphans.push(f.path);
  }

  stats.approxTokens = Math.ceil(approxChars / 1.7);
  return stats;
}

export function renderReport(stats: VaultStats): string {
  const lines: string[] = [];
  lines.push("# Vault 扫描报告", "");
  lines.push("- 扫描时间:" + new Date(stats.scannedAt).toLocaleString());
  lines.push("- 文件总数:" + stats.totalFiles + " / Markdown:" + stats.totalMd);
  lines.push("- 全库全文约 " + stats.approxTokens.toLocaleString() + " tokens(粗估)");
  lines.push("");
  lines.push("## 顶层目录");
  lines.push("| 目录 | 文件数 | md 数 |");
  lines.push("|---|---|---|");
  for (const t of stats.topLevel) lines.push("| " + t.name + " | " + t.fileCount + " | " + t.mdCount + " |");
  lines.push("");
  lines.push("## 新增/更新(自上次扫描)");
  if (!stats.newOrUpdated.length) lines.push("- 无");
  else for (const n of stats.newOrUpdated) lines.push("- " + n.path + (n.hasLastUpdated ? "(last_updated: " + n.lastUpdated + ")" : "(缺 last_updated)"));
  lines.push("");
  lines.push("## 高亮疑问(==…==)");
  if (!stats.highlights.length) lines.push("- 无");
  else for (const h of stats.highlights) lines.push("- " + h.path + ":" + h.count + " 处" + (h.samples.length ? " 例:" + h.samples.join(" / ") : ""));
  lines.push("");
  lines.push("## 孤立笔记(无入链,排除 README/模板)");
  if (!stats.orphans.length) lines.push("- 无");
  else for (const o of stats.orphans) lines.push("- " + o);
  lines.push("");
  lines.push("## 失效双链");
  if (!stats.brokenLinks.length) lines.push("- 无");
  else for (const b of stats.brokenLinks.slice(0, 50)) lines.push("- " + b.path + " → [[" + b.link + "]]");
  lines.push("");
  lines.push("## Frontmatter 规范问题(知识库/ 主题页)");
  if (!stats.frontmatterIssues.length) lines.push("- 无");
  else for (const f of stats.frontmatterIssues) lines.push("- " + f.path + ": " + f.issues.join("; "));
  lines.push("");
  return lines.join("\n");
}