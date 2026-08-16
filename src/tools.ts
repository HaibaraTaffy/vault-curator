import { App, TFile, TFolder } from "obsidian";
import type { DSVKSettings } from "./types";
import { scanVault, renderReport, isExcluded } from "./scanner";
import { buildSystemPrompt } from "./rules";
import { WriteProposal, performWrite, describeProposal, normalizeNotePath, WriteScope } from "./writer";

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export const TOOL_DEFS: ToolDef[] = [
  {
    name: "scan_vault",
    description:
      "扫描整个 vault 生成只读报告:顶层目录统计、新增/更新文件、高亮疑问(==…==)、孤立笔记、失效双链、frontmatter 规范问题。无参数。",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "read_note",
    description: "读取 vault 内一篇 Markdown 笔记的完整内容(最多 12000 字符)。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "笔记的 vault 相对路径,如 知识库/03-大语言模型与生成式AI/README.md" },
      },
      required: ["path"],
    },
  },
  {
    name: "search_notes",
    description: "按关键词搜索笔记的文件名与内容,返回匹配文件与上下文片段。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词" },
        max_results: { type: "number", description: "最多返回条数,默认 10,上限 20" },
      },
      required: ["query"],
    },
  },
  {
    name: "list_files",
    description: "列出 vault 的目录树(默认根目录,最多 3 层、200 行),可用于确认路径。",
    parameters: {
      type: "object",
      properties: {
        dir: { type: "string", description: "起始目录的 vault 相对路径,留空表示根目录" },
      },
      required: [],
    },
  },
  {
    name: "rules_status",
    description: "查看当前加载的规则文档(系统提示词来源)及其加载状态。无参数。",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "create_note",
    description:
      "新建一篇 Markdown 笔记(带内容)。路径必须位于 知识库/、mynote/、Internet_source/、AI-Workspace/、pasted_picture/ 下。auto 模式直接执行,proposal 模式等待用户确认。自动写变更日志。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "目标路径,如 知识库/03-大语言模型与生成式AI/RAG.md" },
        content: { type: "string", description: "完整笔记内容(Markdown)" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "update_note",
    description:
      "更新一篇现有笔记:mode=replace 整体替换内容(默认),mode=append 在末尾追加。改动前自动备份到 AI-Workspace/archive/,并写变更日志。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "笔记路径" },
        content: { type: "string", description: "新内容(整体替换)或要追加的内容" },
        mode: { type: "string", enum: ["replace", "append"], description: "replace=整体替换,append=末尾追加,默认 replace" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "move_note",
    description: "移动/重命名一篇笔记(自动更新引用它的双链)。目标必须位于允许目录下且不存在。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "源路径" },
        new_path: { type: "string", description: "目标路径,如 mynote/归档/xxx.md" },
      },
      required: ["path", "new_path"],
    },
  },
  {
    name: "delete_note",
    description: "删除一篇笔记(进系统回收站,可恢复)。删除前自动备份到 AI-Workspace/archive/,并写变更日志。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "要删除的笔记路径" },
      },
      required: ["path"],
    },
  },
];

export function toolsForRequest(): unknown[] {
  return TOOL_DEFS.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/** 从设置构建写入范围 */
function writeScopeOf(settings: DSVKSettings): WriteScope {
  return { wholeVault: settings.writeScope !== "roots-only", allowedRoots: settings.allowedWriteRoots };
}

/** 写操作按权限模式路由 */
function routeWrite(pr: WriteProposal, app: App, settings: DSVKSettings): Promise<{ text: string; proposal?: WriteProposal }> {
  if (settings.permissionMode === "normal") {
    return Promise.resolve({ text: "只读模式(normal):已阻止 " + describeProposal(pr) });
  }
  if (settings.permissionMode === "auto") {
    return performWrite(app, pr, writeScopeOf(settings)).then((text) => ({ text }));
  }
  return Promise.resolve({ text: "[待确认] " + describeProposal(pr) + "(等待用户批准)", proposal: pr });
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  app: App,
  settings: DSVKSettings
): Promise<{ text: string; proposal?: WriteProposal }> {
  switch (name) {
    case "scan_vault": {
      const stats = await scanVault(app, settings.lastScanTime);
      return { text: renderReport(stats) };
    }
    case "read_note": {
      const p = String(args.path || "").trim();
      if (!p) return { text: "参数 path 不能为空。" };
      const candidates = [p, p.replace(/\.md$/, ""), p + ".md"];
      let found: TFile | null = null;
      for (const c of candidates) {
        const f = app.vault.getAbstractFileByPath(c);
        if (f instanceof TFile && f.extension === "md") { found = f; break; }
      }
      if (!found) return { text: "未找到笔记:「" + p + "」。可用 list_files 确认正确路径。" };
      let content = "";
      try { content = await app.vault.cachedRead(found); } catch (e) { return { text: "读取失败:" + String(e) }; }
      return { text: "### " + found.path + "\n\n" + content.slice(0, 12000) + (content.length > 12000 ? "\n...(内容过长已截断)" : "") };
    }
    case "search_notes": {
      const q = String(args.query || "").toLowerCase().trim();
      if (!q) return { text: "参数 query 不能为空。" };
      const max = Math.min(Number(args.max_results) || 10, 20);
      const hits: { path: string; snippet: string }[] = [];
      const files = app.vault.getFiles().filter((f) => f.extension === "md" && !isExcluded(f.path));
      for (const f of files) {
        if (hits.length >= max) break;
        if (f.basename.toLowerCase().includes(q)) {
          hits.push({ path: f.path, snippet: "(文件名匹配)" });
          continue;
        }
        let c = "";
        try { c = await app.vault.cachedRead(f); } catch { continue; }
        const idx = c.toLowerCase().indexOf(q);
        if (idx >= 0) {
          const start = Math.max(0, idx - 60);
          hits.push({ path: f.path, snippet: "…" + c.slice(start, idx + q.length + 80).replace(/\n/g, " ") + "…" });
        }
      }
      if (!hits.length) return { text: "未找到匹配「" + args.query + "」的笔记。" };
      return { text: hits.map((h) => "- " + h.path + "\n  " + h.snippet).join("\n") };
    }
    case "list_files": {
      const dirArg = String(args.dir || "").trim();
      const lines: string[] = [];
      const walk = (folder: TFolder, indent: string, depth: number): void => {
        if (lines.length > 200 || depth > 3) return;
        const children = folder.children.slice().sort((a, b) => a.name.localeCompare(b.name));
        for (const child of children) {
          if (lines.length > 200) return;
          if (child.name.startsWith(".")) continue;
          if (isExcluded(child.path)) continue;
          if (child instanceof TFolder) {
            lines.push(indent + "📁 " + child.name + "/");
            walk(child, indent + "  ", depth + 1);
          } else if (child instanceof TFile && child.extension === "md") {
            lines.push(indent + "📄 " + child.name);
          }
        }
      };
      const startFolder = dirArg ? app.vault.getAbstractFileByPath(dirArg) : app.vault.getRoot();
      if (!(startFolder instanceof TFolder)) return { text: "未找到目录:「" + dirArg + "」。" };
      walk(startFolder, "", 0);
      return { text: lines.join("\n") || "(空目录)" };
    }
    case "rules_status": {
      const r = await buildSystemPrompt(app, settings);
      return {
        text:
          "已加载规则文档:\n" +
          (r.loaded.length ? r.loaded.map((x) => "- " + x).join("\n") : "- (无)") +
          "\n\n未找到/跳过:\n" +
          (r.skipped.length ? r.skipped.map((x) => "- " + x).join("\n") : "- (无)"),
      };
    }
    case "create_note": {
      const path = normalizeNotePath(String(args.path || ""), writeScopeOf(settings));
      if (!path) return { text: "拒绝:路径不在允许范围或非法(" + String(args.path || "") + ")" };
      return routeWrite({ action: "create", path, content: String(args.content ?? "") }, app, settings);
    }
    case "update_note": {
      const path = normalizeNotePath(String(args.path || ""), writeScopeOf(settings));
      if (!path) return { text: "拒绝:路径不在允许范围或非法(" + String(args.path || "") + ")" };
      const mode = args.mode === "append" ? "append" : "replace";
      return routeWrite({ action: "update", path, content: String(args.content ?? ""), mode }, app, settings);
    }
    case "move_note": {
      const path = normalizeNotePath(String(args.path || ""), writeScopeOf(settings));
      if (!path) return { text: "拒绝:源路径非法(" + String(args.path || "") + ")" };
      const target = normalizeNotePath(String(args.new_path || ""), writeScopeOf(settings));
      if (!target) return { text: "拒绝:目标路径非法(" + String(args.new_path || "") + ")" };
      return routeWrite({ action: "move", path, newPath: target }, app, settings);
    }
    case "delete_note": {
      const path = normalizeNotePath(String(args.path || ""), writeScopeOf(settings));
      if (!path) return { text: "拒绝:路径非法(" + String(args.path || "") + ")" };
      return routeWrite({ action: "delete", path }, app, settings);
    }
    default:
      return { text: "未知工具:" + name };
  }
}