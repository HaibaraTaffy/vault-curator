import { App, TFile, TFolder } from "obsidian";

export type WriteAction = "create" | "update" | "move" | "delete";

export interface WriteProposal {
  action: WriteAction;
  path: string;
  newPath?: string;
  content?: string;
  mode?: "replace" | "append";
}

/** 历史条目(机器可读,供回滚) */
export interface HistoryEntry {
  id: string;
  time: string;
  action: WriteAction | "rollback";
  path: string;
  newPath?: string;
  backup?: string;
}

const ALLOWED_ROOTS = ["知识库/", "mynote/", "Internet_source/", "AI-Workspace/", "pasted_picture/"];
const FORBIDDEN_SEGMENTS = [".obsidian", ".claudian", ".git", ".trash"];
const HISTORY_FILE = "AI-Workspace/change-log/history.jsonl";

/** 规范化笔记路径:补 .md、去前导斜杠;越界返回 null */
export function normalizeNotePath(p: string): string | null {
  if (!p) return null;
  let path = String(p).trim().replace(/\\/g, "/");
  if (!path.endsWith(".md")) path += ".md";
  if (path.startsWith("/")) path = path.slice(1);
  const segments = path.split("/");
  if (segments.some((seg) => FORBIDDEN_SEGMENTS.includes(seg))) return null;
  if (!ALLOWED_ROOTS.some((root) => path.startsWith(root))) return null;
  return path;
}

export function describeProposal(pr: WriteProposal): string {
  switch (pr.action) {
    case "create": return "新建 " + pr.path;
    case "update": return "更新 " + pr.path + (pr.mode === "append" ? "(末尾追加)" : "(整体替换)");
    case "move": return "移动 " + pr.path + " → " + (pr.newPath || "?");
    case "delete": return "删除 " + pr.path + "(进系统回收站)";
  }
}

async function ensureDir(app: App, dirPath: string): Promise<void> {
  if (!dirPath) return;
  const existing = app.vault.getAbstractFileByPath(dirPath);
  if (existing instanceof TFolder) return;
  await app.vault.createFolder(dirPath);
}

function todayStr(): string {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

function dirnameOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : "";
}

async function writeChangelog(app: App, line: string): Promise<void> {
  try {
    const dir = "AI-Workspace/change-log";
    await ensureDir(app, dir);
    const filePath = dir + "/" + todayStr() + ".md";
    const stamp = new Date().toLocaleTimeString();
    let content = "";
    if (await app.vault.adapter.exists(filePath)) {
      content = await app.vault.adapter.read(filePath);
    }
    content = (content ? content.replace(/\s+$/, "") + "\n" : "") + "- " + stamp + " " + line + "\n";
    await app.vault.adapter.write(filePath, content);
  } catch (e) {
    console.error("写变更日志失败:", e);
  }
}

async function backupFile(app: App, path: string, content: string): Promise<string | null> {
  try {
    const dir = "AI-Workspace/archive/" + todayStr();
    await ensureDir(app, dir);
    const base = path.split("/").pop() || "note";
    const backupPath = dir + "/" + String(Date.now()) + "-" + base;
    await app.vault.adapter.write(backupPath, content);
    return backupPath;
  } catch (e) {
    console.error("备份失败:", e);
    return null;
  }
}

/** 追加一条机器可读历史(JSON Lines) */
async function appendHistory(app: App, entry: HistoryEntry): Promise<void> {
  try {
    await ensureDir(app, "AI-Workspace/change-log");
    const line = JSON.stringify(entry) + "\n";
    if (!(await app.vault.adapter.exists(HISTORY_FILE))) {
      await app.vault.adapter.write(HISTORY_FILE, line);
    } else {
      const existing = await app.vault.adapter.read(HISTORY_FILE);
      await app.vault.adapter.write(HISTORY_FILE, existing.replace(/\s+$/, "") + "\n" + line);
    }
  } catch (e) {
    console.error("写历史失败:", e);
  }
}

function newEntry(action: HistoryEntry["action"], path: string, extra?: Partial<HistoryEntry>): HistoryEntry {
  return {
    id: String(Date.now()) + "-" + Math.floor(Math.random() * 1000),
    time: new Date().toISOString(),
    action,
    path,
    ...extra,
  };
}

/** 执行写操作(快照 + 变更日志 + 历史记录),返回结果文本 */
export async function performWrite(app: App, pr: WriteProposal): Promise<string> {
  const path = normalizeNotePath(pr.path);
  if (!path) return "拒绝:路径不在允许的写入范围(" + pr.path + ")";

  switch (pr.action) {
    case "create": {
      if (app.vault.getAbstractFileByPath(path)) return "拒绝:文件已存在 " + path;
      await ensureDir(app, path.split("/").slice(0, -1).join("/"));
      await app.vault.create(path, pr.content || "");
      await writeChangelog(app, "新建 " + path);
      await appendHistory(app, newEntry("create", path));
      return "已创建 " + path;
    }
    case "update": {
      const f = app.vault.getAbstractFileByPath(path);
      if (!(f instanceof TFile)) return "拒绝:文件不存在 " + path;
      const old = await app.vault.cachedRead(f);
      const backup = await backupFile(app, path, old);
      const next = pr.mode === "append" ? old.replace(/\s+$/, "") + "\n\n" + (pr.content || "") : (pr.content ?? "");
      await app.vault.modify(f, next);
      await writeChangelog(app, "更新 " + path + (pr.mode === "append" ? "(追加)" : ""));
      await appendHistory(app, newEntry("update", path, { backup: backup || undefined }));
      return "已更新 " + path;
    }
    case "move": {
      const f = app.vault.getAbstractFileByPath(path);
      if (!(f instanceof TFile)) return "拒绝:源文件不存在 " + path;
      const target = normalizeNotePath(pr.newPath || "");
      if (!target) return "拒绝:目标路径不在允许范围(" + pr.newPath + ")";
      if (app.vault.getAbstractFileByPath(target)) return "拒绝:目标已存在 " + target;
      await ensureDir(app, target.split("/").slice(0, -1).join("/"));
      await app.fileManager.renameFile(f, target);
      await writeChangelog(app, "移动 " + path + " → " + target);
      await appendHistory(app, newEntry("move", path, { newPath: target }));
      return "已移动 " + path + " → " + target;
    }
    case "delete": {
      const f = app.vault.getAbstractFileByPath(path);
      if (!(f instanceof TFile)) return "拒绝:文件不存在 " + path;
      const old = await app.vault.cachedRead(f);
      const backup = await backupFile(app, path, old);
      await app.vault.trash(f, true);
      await writeChangelog(app, "删除 " + path + "(回收站)");
      await appendHistory(app, newEntry("delete", path, { backup: backup || undefined }));
      return "已删除 " + path + "(可到系统回收站找回)";
    }
  }
}

/** 读取全部历史(最新在前) */
export async function listHistory(app: App): Promise<HistoryEntry[]> {
  try {
    if (!(await app.vault.adapter.exists(HISTORY_FILE))) return [];
    const raw = await app.vault.adapter.read(HISTORY_FILE);
    const entries: HistoryEntry[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        entries.push(JSON.parse(t) as HistoryEntry);
      } catch (e) { /* 跳过坏行 */ }
    }
    return entries.reverse();
  } catch (e) {
    return [];
  }
}

async function recordRollback(app: App, entry: HistoryEntry, result: string): Promise<void> {
  await writeChangelog(app, "回滚[" + entry.id.slice(-6) + "] " + result);
  await appendHistory(app, newEntry("rollback", entry.path, { newPath: entry.newPath, backup: entry.backup }));
}

/** 回滚一条历史:更新=恢复备份,新建=删除,移动=移回,删除=重建 */
export async function rollback(app: App, entry: HistoryEntry): Promise<string> {
  try {
    switch (entry.action) {
      case "create": {
        const f = app.vault.getAbstractFileByPath(entry.path);
        if (f instanceof TFile) {
          await app.vault.trash(f, true);
          await recordRollback(app, entry, "删除(回滚新建) " + entry.path);
          return "已回滚:删除 " + entry.path + "(新建的文件)";
        }
        return "无需回滚:文件已不存在 " + entry.path;
      }
      case "update": {
        const f = app.vault.getAbstractFileByPath(entry.path);
        if (!(f instanceof TFile)) return "文件不存在:" + entry.path;
        if (!entry.backup || !(await app.vault.adapter.exists(entry.backup))) return "备份缺失,无法回滚";
        const oldContent = await app.vault.adapter.read(entry.backup);
        const current = await app.vault.cachedRead(f);
        await backupFile(app, entry.path, current); // 先备份当前,再覆盖
        await app.vault.modify(f, oldContent);
        await recordRollback(app, entry, "更新(回滚) " + entry.path);
        return "已回滚:恢复 " + entry.path + " 到 " + new Date(entry.time).toLocaleString();
      }
      case "move": {
        const target = entry.newPath;
        if (!target) return "缺少目标路径";
        const t = app.vault.getAbstractFileByPath(target);
        if (!(t instanceof TFile)) return "目标文件不存在:" + target;
        if (app.vault.getAbstractFileByPath(entry.path)) return "源路径已存在,无法移回:" + entry.path;
        await app.fileManager.renameFile(t, entry.path);
        await recordRollback(app, entry, "移动(回滚) " + target + " → " + entry.path);
        return "已回滚:移回 " + target + " → " + entry.path;
      }
      case "delete": {
        if (!entry.backup || !(await app.vault.adapter.exists(entry.backup))) return "备份缺失,无法回滚";
        const content = await app.vault.adapter.read(entry.backup);
        if (app.vault.getAbstractFileByPath(entry.path)) return "文件已存在:" + entry.path;
        await ensureDir(app, dirnameOf(entry.path));
        await app.vault.create(entry.path, content);
        await recordRollback(app, entry, "新建(回滚删除) " + entry.path);
        return "已回滚:恢复被删除的 " + entry.path;
      }
      case "rollback":
        return "回滚操作本身不支持再次回滚(如需,可手动处理)";
    }
    return "未知操作";
  } catch (e) {
    return "回滚失败:" + (e instanceof Error ? e.message : String(e));
  }
}
