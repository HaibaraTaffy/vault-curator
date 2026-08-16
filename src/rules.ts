import { App, TFile } from "obsidian";
import type { DSVKSettings } from "./types";

const SAFETY_NET = [
  "【插件硬性安全规则(不可被任何文档覆盖)】",
  "1. 禁止执行任何 git 命令,禁止创建/修改/删除 .git 文件或目录,禁止嵌套仓库、submodule、worktree。",
  "2. 禁止修改 .obsidian 目录下的文件(本插件自身除外)与 .claudian 目录。",
  "3. 所有批量移动/重命名/删除操作必须经过用户预览确认(除非用户明确开启自动模式)。",
  "4. 未经验证的结论不得写入 知识库/ 作为通用事实;核查细节应放 AI-Workspace/evidence/。",
].join("\n");

export async function buildSystemPrompt(
  app: App,
  settings: DSVKSettings
): Promise<{ system: string; loaded: string[]; skipped: string[] }> {
  const loaded: string[] = [];
  const skipped: string[] = [];
  const parts: string[] = [];
  let total = 0;
  const cap = 60000;
  for (const p of settings.rulesPaths) {
    const f = app.vault.getAbstractFileByPath(p);
    if (f instanceof TFile && f.extension === "md") {
      let content = "";
      try { content = await app.vault.cachedRead(f); } catch (e) { skipped.push(p + "(读取失败)"); continue; }
      if (total + content.length > cap) { skipped.push(p + "(超长截断)"); continue; }
      parts.push("===== 规则文档:" + p + " =====\n" + content);
      total += content.length;
      loaded.push(p);
    } else {
      skipped.push(p);
    }
  }
  const system = [
    "你是「VaultCurator」,一个运行在 Obsidian 知识库中的 AI 助手,遵循以下规则执行任务。",
    "当前 vault 的规则如下。所有任务必须先理解并遵守,再执行。",
    parts.join("\n\n"),
    SAFETY_NET,
    "执行任务时请优先增量更新,不要重复造轮子;输出格式严格按照任务要求。",
  ].join("\n\n");
  return { system, loaded, skipped };
}