import { ItemView, WorkspaceLeaf, MarkdownRenderer, Notice, TFile, setIcon, Modal, Menu } from "obsidian";
import type { App } from "obsidian";
import type DSVKPlugin from "./main";
import type { Session, ToolLogEntry } from "./chatAgent";
import { runAgentTurn } from "./chatAgent";
import type { ChatMessage } from "./types";
import { performWrite, describeProposal } from "./writer";
import { costTextFor } from "./pricing";
import type { WriteProposal } from "./writer";

export const VIEW_TYPE_STEWARD = "dsvk-steward";
const SESSION_DIR = ".obsidian/plugins/vault-curator/sessions";

const QUICK_PROMPTS = [
  { label: "整理当前笔记(按模板)", value: "把当前笔记按主题页模板整理成草稿" },
  { label: "总结选中内容", value: "总结我选中的内容,给出要点" },
  { label: "生成标签与双链建议", value: "为当前笔记生成标签和双链建议" },
  { label: "扫描仓库最新变化", value: "扫描仓库,告诉我最新的变化和待办" },
  { label: "处理全部高亮疑问", value: "帮我处理仓库里的所有 ==高亮== 疑问" },
  { label: "翻译成英文", value: "把我选中的内容翻译成英文" },
];

export class StewardView extends ItemView {
  plugin: DSVKPlugin;
  private sessions: Session[] = [];
  private activeId: string | null = null;
  private abort: AbortController | null = null;
  private busy = false;
  private pendingRef: { kind: "note" | "selection"; path: string; snippet: string } | null = null;

  private elSessionBtns!: HTMLElement;
  private elModelBadge!: HTMLButtonElement;
  private elMessages!: HTMLElement;
  private elInput!: HTMLTextAreaElement;
  private elSendBtn!: HTMLButtonElement;
  private elStopBtn!: HTMLButtonElement;
  private elRefBtn!: HTMLButtonElement;
  private elChipRow!: HTMLElement;
  private elStatus!: HTMLElement;
  private elEmptyState: HTMLElement | null = null;
  private thinkingTimer: number | null = null;
  private lastActivity = 0;
  private readonly WELCOME_PHRASES = [
    "你好,我是 VaultCurator,你的知识库管家——今天想整理点什么?",
    "把笔记交给我,我来帮你打理这个知识库。",
    "欢迎回来!需要我先扫描一下仓库的最新变化吗?",
    "问我任何关于这个仓库的问题,或者让我帮你整理笔记。",
    "准备好了,随时可以开始整理你的知识库。",
    "我可以扫描、搜索、分析你的笔记——直接开口就行。",
  ];

  constructor(leaf: WorkspaceLeaf, plugin: DSVKPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_STEWARD;
  }

  getDisplayText(): string {
    return "VaultCurator";
  }

  getIcon(): string {
    return "bot";
  }

  async onOpen(): Promise<void> {
    this.containerEl.empty();
    this.containerEl.addClass("dsvk-chat");
    this.buildLayout();
    await this.loadSessions();
    if (!this.activeId || !this.sessions.length) {
      await this.newSession();
    } else {
      this.renderSessionList();
      this.renderMessages();
    }
  }

  async onClose(): Promise<void> {
    if (this.abort) this.abort.abort();
    this.stopThinkingWatchdog();
  }

  // ---------- layout:消息区在上,功能栏+输入框+附件在下 ----------
  private buildLayout(): void {
    const el = this.containerEl;

    this.elMessages = el.createDiv({ cls: "dsvk-messages" });

    const inputWrap = el.createDiv({ cls: "dsvk-input-wrap" });

    // 功能栏:会话按钮(1 2 3…)+ 新建/删除(位于输入框上方)
    const bar = inputWrap.createDiv({ cls: "dsvk-header" });
    this.elSessionBtns = bar.createDiv({ cls: "dsvk-session-btns" });
    this.elModelBadge = bar.createEl("button", { cls: "dsvk-model-badge" });
    const updateModelBadge = (): void => {
      const isPro = this.plugin.settings.model === "deepseek-v4-pro";
      const noTools = this.plugin.settings.model === "deepseek-reasoner";
      this.elModelBadge.setText(noTools ? "reasoner·仅问答" : isPro ? "pro·工具" : "flash·工具");
      this.elModelBadge.toggleClass("is-non-tool", noTools);
      this.elModelBadge.title = noTools
        ? "当前:deepseek-reasoner(仅问答,不会操作仓库) — 点击切换到 flash"
        : isPro
          ? "当前:deepseek-v4-pro(强·贵,支持工具) — 点击切换到 flash"
          : "当前:deepseek-v4-flash(快·省,支持工具) — 点击切换到 pro";
    };
    updateModelBadge();
    this.elModelBadge.addEventListener("click", () => {
      if (this.plugin.settings.model === "deepseek-reasoner") {
        this.plugin.settings.model = "deepseek-v4-flash";
      } else if (this.plugin.settings.model === "deepseek-v4-flash") {
        this.plugin.settings.model = "deepseek-v4-pro";
      } else {
        this.plugin.settings.model = "deepseek-v4-flash";
      }
      void this.plugin.saveSettings();
      updateModelBadge();
    });
    const newBtn = bar.createEl("button", { cls: "dsvk-icon-btn", title: "新建会话" });
    setIcon(newBtn, "plus");
    newBtn.addEventListener("click", () => {
      void this.newSession();
    });
    const delBtn = bar.createEl("button", { cls: "dsvk-icon-btn", title: "删除当前会话" });
    setIcon(delBtn, "trash-2");
    delBtn.addEventListener("click", () => {
      void this.deleteActiveSession();
    });

    // 输入框
    const box = inputWrap.createDiv({ cls: "dsvk-input-box" });
    this.elInput = box.createEl("textarea", { placeholder: "问问 DeepSeek…" });
    this.elInput.addEventListener("keydown", (ev: KeyboardEvent) => {
      if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        void this.send();
      }
    });
    this.elInput.addEventListener("input", () => {
      this.updateSendState();
      if (this.elInput.value === "/") this.showQuickPrompts();
    });
    const boxRow = box.createDiv({ cls: "dsvk-input-box-row" });
    this.elRefBtn = boxRow.createEl("button", { cls: "dsvk-icon-btn", title: "引用当前笔记" });
    setIcon(this.elRefBtn, "paperclip");
    this.elRefBtn.addEventListener("click", () => this.attachCurrentNote());
    // 附件 chip 紧跟引用按钮右侧
    this.elChipRow = boxRow.createDiv({ cls: "dsvk-chip-row" });
    boxRow.createDiv({ cls: "dsvk-spacer" });
    this.elStopBtn = boxRow.createEl("button", { cls: "dsvk-icon-btn dsvk-stop-btn", title: "停止" });
    setIcon(this.elStopBtn, "square");
    this.elStopBtn.style.display = "none";
    this.elStopBtn.addEventListener("click", () => {
      if (this.abort) this.abort.abort();
    });
    this.elSendBtn = boxRow.createEl("button", { cls: "dsvk-send-btn", title: "发送" });
    this.elSendBtn.disabled = true;
    setIcon(this.elSendBtn, "send");
    this.elSendBtn.addEventListener("click", () => {
      void this.send();
    });

    this.elStatus = inputWrap.createDiv({ cls: "dsvk-status" });
  }

  private startThinkingWatchdog(): void {
    this.stopThinkingWatchdog();
    this.thinkingTimer = window.setInterval(() => {
      if (!this.busy) return;
      const idle = Date.now() - this.lastActivity;
      if (idle > 15000) {
        this.setStatus("仍在等待模型输出…(已 " + Math.floor(idle / 1000) + "s,可点 ⏹ 停止)");
      }
    }, 3000);
  }

  private stopThinkingWatchdog(): void {
    if (this.thinkingTimer !== null) {
      window.clearInterval(this.thinkingTimer);
      this.thinkingTimer = null;
    }
  }

  private updateSendState(): void {
    this.elSendBtn.disabled = this.busy || this.elInput.value.trim().length === 0;
  }

  // ---------- sessions ----------
  private adapter() {
    return this.plugin.app.vault.adapter;
  }

  private activeSession(): Session | null {
    return this.sessions.find((s) => s.id === this.activeId) || null;
  }

  private async loadSessions(): Promise<void> {
    try {
      if (!(await this.adapter().exists(SESSION_DIR))) {
        await this.adapter().mkdir(SESSION_DIR);
      }
      const listed = await this.adapter().list(SESSION_DIR);
      const loaded: Session[] = [];
      for (const f of listed.files.filter((x) => x.endsWith(".json"))) {
        try {
          const s = JSON.parse(await this.adapter().read(f)) as Session;
          if (s && s.id && Array.isArray(s.messages)) {
            s.totalPromptTokens = s.totalPromptTokens || 0;
            s.totalCompletionTokens = s.totalCompletionTokens || 0;
            loaded.push(s);
          }
        } catch { /* 跳过损坏会话 */ }
      }
      loaded.sort((a, b) => a.createdAt - b.createdAt);
      this.sessions = loaded;
      if (!this.activeId && loaded.length) this.activeId = loaded[0].id;
    } catch (e) {
      new Notice("加载会话失败:" + String(e));
    }
  }

  private async saveSession(s: Session): Promise<void> {
    try {
      await this.adapter().write(SESSION_DIR + "/" + s.id + ".json", JSON.stringify(s, null, 2));
    } catch (e) {
      new Notice("保存会话失败:" + String(e));
    }
  }

  private async newSession(): Promise<void> {
    const s: Session = {
      id: "s" + Date.now(),
      title: "新会话 " + new Date().toLocaleString(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
    };
    this.sessions.push(s);
    this.activeId = s.id;
    await this.saveSession(s);
    this.renderSessionList();
    this.renderMessages();
  }

  private async deleteActiveSession(): Promise<void> {
    if (!this.activeId) return;
    const id = this.activeId;
    try {
      await this.adapter().remove(SESSION_DIR + "/" + id + ".json");
    } catch (e) {
      new Notice("删除会话失败:" + String(e));
    }
    this.sessions = this.sessions.filter((s) => s.id !== id);
    this.activeId = this.sessions.length ? this.sessions[0].id : null;
    if (!this.activeId) await this.newSession();
    this.renderSessionList();
    this.renderMessages();
  }

  private renderSessionList(): void {
    this.elSessionBtns.empty();
    this.sessions.forEach((s, i) => {
      const btn = this.elSessionBtns.createEl("button", {
        cls: "dsvk-session-btn" + (s.id === this.activeId ? " is-active" : ""),
        title: s.title,
      });
      btn.setText(String(i + 1));
      btn.addEventListener("click", () => {
        if (this.busy) return;
        this.activeId = s.id;
        this.renderSessionList();
        this.renderMessages();
      });
    });
  }

  // ---------- messages ----------
  private renderEmptyState(): void {
    const wrap = this.elMessages.createDiv({ cls: "dsvk-empty" });
    const phrase = this.WELCOME_PHRASES[Math.floor(Math.random() * this.WELCOME_PHRASES.length)];
    wrap.createDiv({ cls: "dsvk-empty-text", text: phrase });
    this.elEmptyState = wrap;
  }

  private clearEmptyState(): void {
    if (this.elEmptyState) {
      this.elEmptyState.remove();
      this.elEmptyState = null;
    }
  }

  private renderMessages(): void {
    this.elMessages.empty();
    this.elEmptyState = null;
    const s = this.activeSession();
    if (!s) return;
    if (!s.messages.length) {
      this.renderEmptyState();
      return;
    }
    for (const m of s.messages) {
      if (m.role === "user" && m.content) this.appendUserBubble(m.content);
      else if (m.role === "assistant" && (m.content || (m.tool_log && m.tool_log.length) || m.reasoning)) {
        this.appendAssistantBubble(m);
      }
    }
    this.elMessages.scrollTop = this.elMessages.scrollHeight;
  }

  private appendUserBubble(text: string): void {
    const row = this.elMessages.createDiv({ cls: "dsvk-msg user" });
    const bubble = row.createDiv({ cls: "dsvk-user-bubble" });
    bubble.setText(text);
    this.elMessages.scrollTop = this.elMessages.scrollHeight;
  }

  private appendAssistantBubble(m: ChatMessage): void {
    const row = this.elMessages.createDiv({ cls: "dsvk-msg assistant" });
    this.renderAssistantRow(row, m.tool_log || [], m.content || "");
    this.elMessages.scrollTop = this.elMessages.scrollHeight;
  }

  /** 渲染一条 AI 消息:工具调用与正文按 pos 交错(旧数据无 pos 时工具在上) */
  private renderAssistantRow(row: HTMLElement, toolLog: ToolLogEntry[], md: string): void {
    const mark = row.createDiv({ cls: "dsvk-ai-mark" });
    setIcon(mark, "bot");
    const col = row.createDiv({ cls: "dsvk-ai-col" });
    const hasPos = toolLog.length > 0 && toolLog.every((t) => typeof t.pos === "number");
    if (hasPos) {
      const logs = [...toolLog].sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0));
      let cursor = 0;
      let renderedText = false;
      for (const l of logs) {
        const p = Math.min(Math.max(l.pos ?? 0, 0), md.length);
        if (p > cursor) {
          this.renderTextSegment(col, md.slice(cursor, p));
          renderedText = true;
        }
        this.renderWorkLine(col, l);
        cursor = p;
      }
      if (cursor < md.length) {
        this.renderTextSegment(col, md.slice(cursor));
      } else if (!renderedText) {
        this.renderTextSegment(col, md);
      }
    } else {
      for (const t of toolLog) {
        this.renderWorkLine(col, t);
      }
      this.renderTextSegment(col, md);
    }
    const copyBtn = col.createEl("button", { cls: "dsvk-copy-btn", title: "复制回复" });
    setIcon(copyBtn, "copy");
    copyBtn.addEventListener("click", () => {
      void copyToClipboard(md);
    });
  }

  private renderTextSegment(col: HTMLElement, text: string): void {
    const body = col.createDiv({ cls: "dsvk-ai-body" });
    this.renderAssistantBody(body, text);
  }

  /** 渲染后把笔记路径(裸路径 / 行内代码里的路径)替换成可点 <a>;代码块与已有链接不动 */
  private enhanceTextLinks(root: HTMLElement): void {
    // 第一遍:行内代码(code,不含 pre)里若正好是笔记路径 → 整段换成可点链接
    root.querySelectorAll("code").forEach((code) => {
      if (code.closest("pre") || code.closest("a")) return;
      const t = (code.textContent || "").trim();
      if (!t) return;
      const f = resolveNote(this.app, t);
      if (!f) return;
      const a = document.createElement("a");
      a.className = "dsvk-file-link";
      a.textContent = t;
      a.setAttribute("data-path", f.path);
      a.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        void openNoteFile(this.app, f.path);
      });
      code.replaceWith(a);
    });

    // 第二遍:文本节点里的裸 .md 路径 → 可点链接
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    let n: Node | null;
    while ((n = walker.nextNode()) !== null) nodes.push(n as Text);
    const re = /([\u4e00-\u9fa5\w/._-]+\.md)/g;
    for (const node of nodes) {
      const text = node.nodeValue;
      if (!text) continue;
      const parent = node.parentElement;
      if (parent && parent.closest("a, code, pre")) continue;
      let m: RegExpExecArray | null;
      let last = 0;
      let changed = false;
      const frag = document.createDocumentFragment();
      while ((m = re.exec(text)) !== null) {
        const p = m[1];
        const f = resolveNote(this.app, p);
        if (!f) continue;
        if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        const a = document.createElement("a");
        a.className = "dsvk-file-link";
        a.textContent = p;
        a.setAttribute("data-path", f.path);
        a.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          void openNoteFile(this.app, f.path);
        });
        frag.appendChild(a);
        last = m.index + m[0].length;
        changed = true;
      }
      if (changed) {
        if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
        if (node.parentNode) node.parentNode.replaceChild(frag, node);
      }
    }
  }

  /** 标准富文本渲染(参考 obsidian-copilot 等主流插件):MarkdownRenderer.render + 点击委托兜底 + 未渲染自动回退 */
  private renderAssistantBody(body: HTMLElement, md: string): void {
    if (!md.trim()) {
      body.setText("_(空回复)_");
      return;
    }
    void MarkdownRenderer.render(this.plugin.app, md, body, "", this);
    this.enhanceTextLinks(body);
    // 点击委托:任何链接(a[data-href]/a[href])只要指向 vault 文件就打开笔记
    body.addEventListener("click", (ev) => {
      const a = (ev.target as HTMLElement).closest("a");
      if (!a) return;
      const path = a.getAttribute("data-href") || a.getAttribute("href");
      if (!path || /^(https?:|mailto:|#)/.test(path)) return;
      ev.preventDefault();
      ev.stopPropagation();
      let decoded = path;
      try { decoded = decodeURIComponent(path); } catch (e) { /* keep raw */ }
      void openNoteFile(this.plugin.app, decoded.replace(/^#/, ""));
    });
    // 若渲染器没生效(仍是字面 markdown 结构),回退到纯文本+链接,保证可点
    window.setTimeout(() => {
      if (!body.isConnected) return;
      const txt = body.textContent || "";
      const rawMarkdown =
        /(^|\n)#{1,6}\s/.test(txt) || // 未渲染的标题
        /\[\[[^\]]+\]\]/.test(txt) || // 未渲染的 wiki 链接
        /\*\*[^*\n]+\*\*/.test(txt) || // 未渲染的加粗
        /\]\(<[^>]+>\)/.test(txt); // 未渲染的 markdown 链接
      if (rawMarkdown) {
        body.empty();
        this.renderPlainWithLinks(body, md);
      }
    }, 50);
  }

  /** 纯文本渲染(不依赖 Obsidian markdown 渲染),同时把 [[…]] / .md 路径 / [label](<path>) 构建成可点链接 */
  private renderPlainWithLinks(container: HTMLElement, text: string): void {
    const lines = text.split("\n");
    for (const line of lines) {
      const lineEl = container.createDiv({ cls: "dsvk-plain-line" });
      this.appendTextWithLinks(lineEl, line);
    }
  }

  private appendTextWithLinks(el: HTMLElement, text: string): void {
    const regex = /\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]|\[([^\]]+)\]\(<([^>]+)>\)|([\u4e00-\u9fa5\w/._-]+\.md)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      if (m.index > last) el.appendText(text.slice(last, m.index));
      const wikiTarget = m[1];
      const wikiAlias = m[2];
      const mdLinkLabel = m[3];
      const mdLinkDest = m[4];
      const plainPath = m[5];
      let path: string | null = null;
      let label = "";
      if (wikiTarget) {
        path = wikiTarget.trim().replace(/\.md$/, "");
        label = wikiAlias ? wikiAlias.trim() : basenameOf(path);
      } else if (mdLinkDest) {
        path = mdLinkDest.trim().replace(/\.md$/, "");
        label = mdLinkLabel || path;
      } else if (plainPath && resolveNote(this.app, plainPath)) {
        path = plainPath.replace(/\.md$/, "");
        label = plainPath;
      }
      if (path && resolveNote(this.app, path)) {
        const a = el.createEl("a", { cls: "dsvk-file-link", text: label });
        a.setAttribute("data-path", path);
        a.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          void openNoteFile(this.app, path as string);
        });
      } else {
        el.appendText(m[0]);
      }
      last = m.index + m[0].length;
    }
    if (last < text.length) el.appendText(text.slice(last));
  }

  private renderWorkLine(container: HTMLElement, t: ToolLogEntry): void {
    const line = container.createDiv({ cls: "dsvk-work" });
    line.setText("→ " + t.name + fmtArgs(t.args));
    line.title = "参数:" + (t.args || "-") + "\n结果:" + (t.result || "-");
    let openPath: string | null = null;
    try {
      const o = JSON.parse(t.args || "{}") as Record<string, unknown>;
      openPath = typeof o.path === "string" ? o.path : typeof o.new_path === "string" ? o.new_path : null;
    } catch (e) { /* ignore */ }
    if (openPath && resolveNote(this.plugin.app, openPath)) {
      line.addClass("dsvk-work-link");
      line.addEventListener("click", () => {
        void openNoteFile(this.plugin.app, openPath as string);
      });
    }
  }

  private appendStreamPlaceholder(): { row: HTMLElement; col: HTMLElement } {
    const row = this.elMessages.createDiv({ cls: "dsvk-msg assistant" });
    const mark = row.createDiv({ cls: "dsvk-ai-mark" });
    setIcon(mark, "bot");
    const col = row.createDiv({ cls: "dsvk-ai-col" });
    this.elMessages.scrollTop = this.elMessages.scrollHeight;
    return { row, col };
  }

  private appendWorkLine(area: HTMLElement, log: ToolLogEntry): void {
    this.renderWorkLine(area, log);
    this.elMessages.scrollTop = this.elMessages.scrollHeight;
  }

  private finishStream(col: HTMLElement, md: string): void {
    col.querySelectorAll(".dsvk-streaming-indicator").forEach((el) => el.remove());
    col.querySelectorAll("pre.dsvk-stream").forEach((pre) => {
      const body = document.createElement("div");
      body.className = "dsvk-ai-body";
      if (pre.parentNode) pre.parentNode.insertBefore(body, pre);
      this.renderAssistantBody(body, pre.textContent || "");
      pre.remove();
    });
    const copyBtn = col.createEl("button", { cls: "dsvk-copy-btn", title: "复制回复" });
    setIcon(copyBtn, "copy");
    copyBtn.addEventListener("click", () => {
      void copyToClipboard(md);
    });
    this.elMessages.scrollTop = this.elMessages.scrollHeight;
  }

  // ---------- 引用当前笔记(隐形附件) ----------
  private attachCurrentNote(): void {
    const f = this.plugin.app.workspace.getActiveFile();
    if (!(f instanceof TFile) || f.extension !== "md") {
      new Notice("当前没有打开的 Markdown 笔记");
      return;
    }
    void this.plugin.app.vault
      .cachedRead(f)
      .then((c) => {
        this.pendingRef = {
          kind: "note",
          path: f.path,
          snippet: c.slice(0, 4000) + (c.length > 4000 ? "\n...(截断)" : ""),
        };
        this.renderChip();
      })
      .catch(() => {
        new Notice("读取笔记失败");
      });
  }

  /** 引用编辑器选中文本 */
  attachSelection(path: string, text: string): void {
    this.pendingRef = { kind: "selection", path, snippet: text.slice(0, 4000) };
    this.renderChip();
    this.elInput.focus();
  }

  private showQuickPrompts(): void {
    const menu = new Menu();
    for (const q of QUICK_PROMPTS) {
      menu.addItem((item) =>
        item.setTitle(q.label).onClick(() => {
          this.elInput.value = q.value;
          this.elInput.focus();
          this.updateSendState();
        })
      );
    }
    const rect = this.elInput.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.top - 8 });
  }

  private renderChip(): void {
    this.elChipRow.empty();
    if (!this.pendingRef) return;
    const chip = this.elChipRow.createDiv({ cls: "dsvk-chip" });
    const label = this.pendingRef.kind === "selection"
      ? "✂️ 选中文本" + (this.pendingRef.path ? " · " + this.pendingRef.path : "")
      : "📎 " + this.pendingRef.path;
    chip.createSpan({ text: label });
    const x = chip.createEl("span", { cls: "dsvk-chip-x", title: "取消引用" });
    x.setText("✕");
    x.addEventListener("click", () => {
      this.pendingRef = null;
      this.renderChip();
    });
  }

  // ---------- input / send ----------
  private setStatus(text: string): void {
    this.elStatus.setText(text);
  }

  private setBusyUI(busy: boolean): void {
    this.busy = busy;
    this.updateSendState();
    this.elRefBtn.disabled = busy;
    this.elModelBadge.disabled = busy;
    for (const b of Array.from(this.elSessionBtns.children)) {
      (b as HTMLButtonElement).disabled = busy;
    }
    this.elStopBtn.style.display = busy ? "" : "none";
    this.elSendBtn.style.display = busy ? "none" : "";
    if (!busy) this.setStatus("");
  }

  private async send(): Promise<void> {
    const text = this.elInput.value.trim();
    if (!text) return;
    if (this.busy) return;
    if (!this.plugin.settings.apiKey) {
      new Notice("请先在插件设置页填写 DeepSeek API Key");
      return;
    }
    const session = this.activeSession();
    if (!session) return;

    const ctx = this.pendingRef
      ? this.pendingRef.kind === "selection"
        ? "【引用文本】用户选中了" + (this.pendingRef.path ? "笔记 " + this.pendingRef.path + " 中的" : "") + "以下文字:\n\n" + this.pendingRef.snippet
        : "【引用笔记】用户引用了笔记:" + this.pendingRef.path + "\n\n" + this.pendingRef.snippet
      : null;
    this.pendingRef = null;
    this.renderChip();

    this.elInput.value = "";
    this.updateSendState();
    this.clearEmptyState();
    this.appendUserBubble(text);
    const ph = this.appendStreamPlaceholder();
    this.setBusyUI(true);
    this.setStatus(this.plugin.settings.model === "deepseek-reasoner" ? "reasoner 模式:仅问答,不会调用工具/修改仓库…" : "思考中…");
    this.abort = new AbortController();
    this.lastActivity = Date.now();
    this.startThinkingWatchdog();

    const spinner = ph.col.createDiv({ cls: "dsvk-streaming-indicator" });
    spinner.createSpan({ cls: "dsvk-spinner" });
    spinner.createSpan({ text: "处理中…" });
    let curPre: HTMLElement | null = null;
    let curText = "";
    let streamed = "";
    try {
      const res = await runAgentTurn(this.plugin.app, this.plugin.settings, session, text, {
        onStatus: (t) => {
          this.lastActivity = Date.now();
          this.setStatus(t);
        },
        onDelta: (d) => {
          this.lastActivity = Date.now();
          spinner.remove();
          streamed += d;
          curText += d;
          if (!curPre) {
            curPre = ph.col.createEl("pre", { cls: "dsvk-stream" });
          }
          curPre.textContent = curText;
          this.elMessages.scrollTop = this.elMessages.scrollHeight;
        },
        onTool: (log) => {
          curPre = null;
          curText = "";
          this.renderWorkLine(ph.col, log);
          this.elMessages.scrollTop = this.elMessages.scrollHeight;
        },
        signal: this.abort.signal,
      }, ctx);
      this.finishStream(ph.col, res.text);
      if (res.usage) {
        session.totalPromptTokens += res.usage.promptTokens;
        session.totalCompletionTokens += res.usage.completionTokens;
        this.plugin.settings.totalPromptTokens += res.usage.promptTokens;
        this.plugin.settings.totalCompletionTokens += res.usage.completionTokens;
        await this.plugin.saveSettings();
      }
      const sessP = session.totalPromptTokens + session.totalCompletionTokens;
      const globP = this.plugin.settings.totalPromptTokens + this.plugin.settings.totalCompletionTokens;
      this.setStatus(
        (res.usage ? "本次 " + res.usage.totalTokens + " tokens " + costTextFor(res.usage.promptTokens, res.usage.completionTokens, this.plugin.settings.model) + " · " : "") +
        "会话累计 " + sessP + " tokens " + costTextFor(session.totalPromptTokens, session.totalCompletionTokens, this.plugin.settings.model) + " · " +
        "全部累计 " + globP + " tokens " + costTextFor(this.plugin.settings.totalPromptTokens, this.plugin.settings.totalCompletionTokens, this.plugin.settings.model)
      );
      if (res.pendingProposals && res.pendingProposals.length) {
        this.showProposalConfirm(res.pendingProposals);
        this.setStatus("AI 提出了 " + res.pendingProposals.length + " 项写操作,等待确认");
      }
      if (session.messages.length <= 2) {
        session.title = text.slice(0, 30);
        this.renderSessionList();
      }
      await this.saveSession(session);
    } catch (e) {
      const err = e as Error;
      if (err && err.name === "TimeoutError") {
        this.setStatus("请求超时,已中止(网络慢或模型无响应)");
        this.finishStream(ph.col, streamed || "⚠️ 请求超时,已中止");
      } else if (err && err.name === "AbortError") {
        this.setStatus("已停止");
        this.finishStream(ph.col, streamed || "_(已停止)_");
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        this.setStatus("错误:" + msg);
        this.finishStream(ph.col, streamed || "⚠️ 请求失败:" + msg);
      }
      await this.saveSession(session);
    } finally {
      this.setBusyUI(false);
      this.abort = null;
    }
  }
  private showProposalConfirm(proposals: WriteProposal[]): void {
    new ProposalConfirmModal(this.app, this.plugin, proposals).open();
  }
}

class ProposalConfirmModal extends Modal {
  plugin: DSVKPlugin;
  proposals: WriteProposal[];

  constructor(app: App, plugin: DSVKPlugin, proposals: WriteProposal[]) {
    super(app);
    this.plugin = plugin;
    this.proposals = proposals;
    this.titleEl.setText("AI 提出 " + proposals.length + " 项写操作,等待确认");
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    const checks: HTMLInputElement[] = [];
    for (const pr of this.proposals) {
      const row = contentEl.createDiv({ cls: "dsvk-proposal-row" });
      const cb = row.createEl("input", { type: "checkbox" });
      cb.checked = true;
      checks.push(cb);
      row.createSpan({ text: describeProposal(pr) });
      if (pr.action === "create" || pr.action === "update") {
        const det = row.createEl("details", { cls: "dsvk-proposal-preview" });
        det.createEl("summary", { text: "预览内容" });
        const pre = det.createEl("pre", { text: (pr.content || "").slice(0, 800) });
        pre.style.whiteSpace = "pre-wrap";
      }
    }
    const btnRow = contentEl.createDiv({ cls: "dsvk-proposal-btns" });
    const okBtn = btnRow.createEl("button", { text: "执行选中(" + this.proposals.length + ")", cls: "mod-cta" });
    okBtn.addEventListener("click", () => {
      const selected = this.proposals.filter((_, i) => checks[i].checked);
      void this.execute(selected);
    });
    const cancelBtn = btnRow.createEl("button", { text: "全部拒绝" });
    cancelBtn.addEventListener("click", () => this.close());
  }

  async execute(selected: WriteProposal[]): Promise<void> {
    const results: string[] = [];
    for (const pr of selected) {
      try {
        results.push(
          describeProposal(pr) + " → " +
          (await performWrite(this.plugin.app, pr, { wholeVault: this.plugin.settings.writeScope !== "roots-only", allowedRoots: this.plugin.settings.allowedWriteRoots }))
        );
      } catch (e) {
        results.push(describeProposal(pr) + " → 失败:" + (e instanceof Error ? e.message : String(e)));
      }
    }
    this.close();
    new Notice("已执行 " + results.length + " 项写操作,详见控制台");
    console.log("VaultCurator 写操作结果:\n" + results.join("\n"));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function fmtArgs(args: string): string {
  if (!args || args === "{}") return "";
  try {
    const v = JSON.parse(args);
    if (v && typeof v === "object") {
      const parts = Object.entries(v).map(([k, val]) => k + "=" + String(val).slice(0, 40));
      return parts.length ? " " + parts.join(" ") : "";
    }
  } catch { /* ignore */ }
  return " " + args.slice(0, 60);
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    new Notice("已复制");
  } catch (e) {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    new Notice("已复制");
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function basenameOf(p: string): string {
  const seg = p.split("/").pop();
  return seg || p;
}

/** 确定性链接化:[[目标|别名]] 与存在的 .md 路径 → 带 data-path 的 <a>(不依赖 Obsidian wiki 链接渲染) */
function linkifyFilePaths(app: App, md: string): string {
  let out = md;
  // [[目标|别名]] → [label](<path>)
  out = out.replace(/\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]/g, (m, target: string, alias: string) => {
    const t = target.trim().replace(/\.md$/, "");
    const label = (alias ? alias.trim() : basenameOf(t)).replace(/[\[\]()<>]/g, "");
    return "[" + label + "](<" + t + ">)";
  });
  // 存在的纯文本 .md 路径 → [path](<path>)
  out = out.replace(/(?<![\">\[\(])([\u4e00-\u9fa5\w/._-]+\.md)(?![\]\">])/g, (m, p: string) => {
    if (!resolveNote(app, p)) return m;
    const t = p.replace(/\.md$/, "");
    return "[" + p + "](<" + t + ">)";
  });
  return out;
}

function resolveNote(app: App, p: string): TFile | null {
  for (const c of [p, p.replace(/\.md$/, ""), p + ".md"]) {
    const f = app.vault.getAbstractFileByPath(c);
    if (f instanceof TFile) return f;
  }
  try {
    return app.metadataCache.getFirstLinkpathDest(p, "") || null;
  } catch (e) {
    return null;
  }
}

async function openNoteFile(app: App, path: string): Promise<void> {
  const f = resolveNote(app, path);
  if (f) {
    await app.workspace.getLeaf(false).openFile(f);
  } else {
    new Notice("未找到文件:" + path);
  }
}

function costText(prompt: number, completion: number): string {
  const cny = (prompt / 1e6) * 2 + (completion / 1e6) * 8;
  return "≈¥" + (cny >= 0.01 ? cny.toFixed(2) : cny.toFixed(4));
}