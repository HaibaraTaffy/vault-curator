import { App, Modal, Notice, Plugin, TFile } from "obsidian";
import { DEFAULT_SETTINGS, DSVKSettingsTab } from "./settings";
import type { DSVKSettings } from "./types";
import { buildSystemPrompt } from "./rules";
import { scanVault, renderReport } from "./scanner";
import { deepseekPing } from "./deepseek";
import { buildOrganizeInput, formatCostEstimate, runOrganize } from "./organize";
import { StewardView, VIEW_TYPE_STEWARD } from "./chatView";
import { listHistory, rollback, HistoryEntry } from "./writer";

export default class DSVKPlugin extends Plugin {
  settings!: DSVKSettings;
  private stewardView: StewardView | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_STEWARD, (leaf) => {
      const view = new StewardView(leaf, this);
      this.stewardView = view;
      return view;
    });
    this.addSettingTab(new DSVKSettingsTab(this.app, this));

    this.addRibbonIcon("bot", "打开 VaultCurator", () => {
      void this.activateSteward();
    });

    this.addCommand({
      id: "open-steward",
      name: "打开 VaultCurator 对话面板",
      callback: () => {
        void this.activateSteward();
      },
    });

    this.addCommand({
      id: "scan-report",
      name: "扫描 vault 生成报告(只读)",
      callback: () => {
        void this.runScanReport();
      },
    });

    this.addCommand({
      id: "organize-report",
      name: "一键整理:AI 增量整理建议(只读,消耗 API)",
      callback: () => {
        void this.runOrganize();
      },
    });

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, view) => {
        const selection = editor.getSelection();
        if (!selection || !selection.trim()) return;
        const file = view.file;
        menu.addItem((item) => {
          item
            .setTitle("用选中文本问 VaultCurator")
            .setIcon("bot")
            .onClick(() => {
              void this.askSelection(file, selection);
            });
        });
      })
    );

    this.addCommand({
      id: "history-rollback",
      name: "历史与回滚:查看并恢复 AI 的改动",
      callback: () => {
        new HistoryModal(this.app, this).open();
      },
    });

    this.addCommand({
      id: "test-connection",
      name: "测试 DeepSeek 连接",
      callback: () => {
        void this.runTestConnection();
      },
    });

    this.addCommand({
      id: "show-rules-status",
      name: "查看规则文档加载状态",
      callback: () => {
        void this.showRulesStatus();
      },
    });
  }

  async activateSteward(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_STEWARD)[0];
    if (!leaf) {
      const right = workspace.getRightLeaf(false);
      if (!right) return;
      await right.setViewState({ type: VIEW_TYPE_STEWARD, active: true });
      leaf = right;
    }
    await workspace.revealLeaf(leaf);
  }

  async askSelection(file: TFile | null, text: string): Promise<void> {
    await this.activateSteward();
    const view = this.stewardView;
    if (view) view.attachSelection(file ? file.path : "", text);
  }

  async runScanReport(): Promise<void> {
    const stats = await scanVault(this.app, this.settings.lastScanTime);
    this.settings.lastScanTime = stats.scannedAt;
    await this.saveSettings();
    const report = renderReport(stats);
    new TextReportModal(this.app, "Vault 扫描报告(只读)", report).open();
    const hlTotal = stats.highlights.reduce((a, h) => a + h.count, 0);
    new Notice(
      "扫描完成:md " + stats.totalMd + " 个,新增/更新 " + stats.newOrUpdated.length + " 个,高亮疑问 " + hlTotal + " 处"
    );
  }

  async runOrganize(): Promise<void> {
    if (!this.settings.apiKey) {
      new Notice("请先在设置页填写 DeepSeek API Key");
      return;
    }
    try {
      const input = await buildOrganizeInput(this.app, this.settings);
      const est = formatCostEstimate(input.inputTokens, this.settings.maxTokens, this.settings.model);
      const ok = await confirmDialog(
        this.app,
        "一键整理(只读)",
        "预计输入 " + input.inputTokens.toLocaleString() + " tokens\n" + est + "\n\n调用 DeepSeek 生成增量整理建议?\n本操作只读,不修改任何文件。"
      );
      if (!ok) return;
      const res = await runOrganize(this.app, this.settings, { user: input.user });
      this.settings.lastScanTime = input.scanned.scannedAt;
      await this.saveSettings();
      new TextReportModal(this.app, "一键整理建议(只读)", res.report + "\n\n" + res.usageText).open();
    } catch (e) {
      new Notice("一键整理失败: " + (e instanceof Error ? e.message : String(e)), 8000);
    }
  }

  async runTestConnection(): Promise<void> {
    try {
      const models = await deepseekPing(this.settings);
      new Notice("DeepSeek 连接成功,可用模型: " + models.join(", "));
    } catch (e) {
      new Notice("连接失败: " + (e instanceof Error ? e.message : String(e)), 8000);
    }
  }

  async showRulesStatus(): Promise<void> {
    const r = await buildSystemPrompt(this.app, this.settings);
    const lines = [
      "已加载规则文档:",
      ...(r.loaded.length ? r.loaded.map((x) => "- " + x) : ["- (无)"]),
      "",
      "未找到/跳过:",
      ...(r.skipped.length ? r.skipped.map((x) => "- " + x) : ["- (无)"]),
    ];
    new TextReportModal(this.app, "规则文档加载状态", lines.join("\n")).open();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    // 旧版本设置迁移:旧模型名 → 新模型名
    if (this.settings.model === "deepseek-chat") {
      this.settings.model = "deepseek-v4-flash";
      await this.saveSettings();
    }
    // 旧版本设置迁移:写入范围字段缺失 → 保留原硬编码目录,行为不变
    if (!this.settings.writeScope) {
      this.settings.writeScope = "roots-only";
      this.settings.allowedWriteRoots = ["知识库/", "mynote/", "Internet_source/", "AI-Workspace/", "pasted_picture/"];
      await this.saveSettings();
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  onunload(): void {
    // 清理工作(如需要)
  }
}

class TextReportModal extends Modal {
  title: string;
  text: string;

  constructor(app: App, title: string, text: string) {
    super(app);
    this.title = title;
    this.text = text;
    this.titleEl.setText(title);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("dsvk-modal");
    const pre = contentEl.createEl("pre", { text: this.text });
    pre.style.maxHeight = "60vh";
    pre.style.overflow = "auto";
    pre.style.whiteSpace = "pre-wrap";
    pre.style.fontSize = "12px";

    const btnRow = contentEl.createDiv();
    btnRow.style.marginTop = "8px";
    const copyBtn = btnRow.createEl("button", { text: "复制报告" });
    copyBtn.addEventListener("click", () => {
      void copyText(this.text);
    });
    const closeBtn = btnRow.createEl("button", { text: "关闭" });
    closeBtn.style.marginLeft = "8px";
    closeBtn.addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class ConfirmDialog extends Modal {
  message: string;
  done = false;
  resolveFn!: (v: boolean) => void;

  constructor(app: App, title: string, message: string) {
    super(app);
    this.message = message;
    this.titleEl.setText(title);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    const p = contentEl.createEl("p", { text: this.message });
    p.style.whiteSpace = "pre-wrap";
    const row = contentEl.createDiv();
    row.style.marginTop = "8px";
    const okBtn = row.createEl("button", { text: "执行" });
    okBtn.style.marginRight = "8px";
    okBtn.addEventListener("click", () => this.finish(true));
    const cancelBtn = row.createEl("button", { text: "取消" });
    cancelBtn.addEventListener("click", () => this.finish(false));
  }

  finish(v: boolean): void {
    if (this.done) return;
    this.done = true;
    this.resolveFn(v);
    this.close();
  }

  onClose(): void {
    if (!this.done) {
      this.done = true;
      this.resolveFn(false);
    }
    this.contentEl.empty();
  }
}

function confirmDialog(app: App, title: string, message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const d = new ConfirmDialog(app, title, message);
    d.resolveFn = resolve;
    d.open();
  });
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    new Notice("报告已复制到剪贴板");
  } catch (e) {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    new Notice("报告已复制到剪贴板(降级方式)");
  }
}

function actionLabel(e: HistoryEntry): string {
  switch (e.action) {
    case "create": return "新建";
    case "update": return "更新";
    case "move": return "移动";
    case "delete": return "删除";
    case "rollback": return "回滚";
  }
}

class HistoryModal extends Modal {
  plugin: DSVKPlugin;

  constructor(app: App, plugin: DSVKPlugin) {
    super(app);
    this.plugin = plugin;
    this.titleEl.setText("历史与回滚(AI 改动,不依赖 git)");
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    const entries = await listHistory(this.plugin.app);
    if (!entries.length) {
      contentEl.createEl("p", { text: "暂无历史记录——AI 还没执行过写操作。" });
      return;
    }
    contentEl.createEl("p", { cls: "dsvk-history-hint", text: "每条回滚都会先备份当前状态并留痕,可放心操作。" });
    const list = contentEl.createDiv();
    list.style.maxHeight = "50vh";
    list.style.overflow = "auto";
    for (const e of entries.slice(0, 200)) {
      const row = list.createDiv({ cls: "dsvk-history-row" });
      const timeText = new Date(e.time).toLocaleString();
      const label = timeText + "  [" + actionLabel(e) + "] " + e.path + (e.newPath ? " → " + e.newPath : "");
      row.createSpan({ text: label });
      const btns = row.createDiv({ cls: "dsvk-history-btns" });
      if ((e.action === "update" || e.action === "delete") && e.backup) {
        const diffBtn = btns.createEl("button", { text: "Diff" });
        diffBtn.addEventListener("click", () => {
          void this.showDiff(e);
        });
      }
      const rollBtn = btns.createEl("button", { text: "回滚", cls: "mod-cta" });
      rollBtn.addEventListener("click", () => {
        void this.doRollback(e, rollBtn);
      });
    }
  }

  async showDiff(e: HistoryEntry): Promise<void> {
    let before = "";
    try {
      if (e.backup && (await this.plugin.app.vault.adapter.exists(e.backup))) {
        before = await this.plugin.app.vault.adapter.read(e.backup);
      }
    } catch (err) { /* ignore */ }
    let current = "";
    const f = this.plugin.app.vault.getAbstractFileByPath(e.path);
    if (f instanceof TFile) {
      try { current = await this.plugin.app.vault.cachedRead(f); } catch (err) { /* ignore */ }
    }
    new DiffModal(this.app, e.path + "  ·  改前(备份) vs 当前", before, current).open();
  }

  async doRollback(e: HistoryEntry, btn: HTMLButtonElement): Promise<void> {
    const ok = await confirmDialog(
      this.app,
      "确认回滚",
      "回滚:[" + actionLabel(e) + "] " + e.path + (e.newPath ? " → " + e.newPath : "") +
        "\n\n回滚会先把当前状态备份到 AI-Workspace/archive/,并写入变更日志。"
    );
    if (!ok) return;
    btn.disabled = true;
    const result = await rollback(this.plugin.app, e);
    new Notice(result, 6000);
    await this.onOpen();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class DiffModal extends Modal {
  path: string;
  before: string;
  current: string;

  constructor(app: App, path: string, before: string, current: string) {
    super(app);
    this.path = path;
    this.before = before;
    this.current = current;
    this.titleEl.setText(path);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    const preB = contentEl.createEl("pre", { text: this.before || "(无备份内容)" });
    preB.style.whiteSpace = "pre-wrap";
    preB.style.fontSize = "12px";
    preB.style.maxHeight = "30vh";
    preB.style.overflow = "auto";
    preB.style.background = "var(--background-secondary)";
    preB.style.borderRadius = "6px";
    preB.style.padding = "8px";
    const sep = contentEl.createEl("p", { text: "↓ 回滚将恢复为上面这份 ↓" });
    sep.style.fontSize = "11px";
    sep.style.color = "var(--text-faint)";
    const preC = contentEl.createEl("pre", { text: "当前内容:\n" + (this.current || "(文件不存在)") });
    preC.style.whiteSpace = "pre-wrap";
    preC.style.fontSize = "12px";
    preC.style.maxHeight = "30vh";
    preC.style.overflow = "auto";
  }

  onClose(): void {
    this.contentEl.empty();
  }
}