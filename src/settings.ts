import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type DSVKPlugin from "./main";
import type { DSVKSettings } from "./types";
import { deepseekPing } from "./deepseek";

export const DEFAULT_SETTINGS: DSVKSettings = {
  apiKey: "",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-flash",
  temperature: 0.3,
  maxTokens: 4096,
  rulesPaths: ["AI-入口.md", "README.md", "知识库/_模板/主题页模板.md"],
  autoMode: false,
  scanIncludeMynote: true,
  scanIncludeInternet: true,
  scanIncludeKnowledge: true,
  writeChangelog: true,
  lastScanTime: 0,
  permissionMode: "auto",
  chatHistory: 40,
  totalPromptTokens: 0,
  totalCompletionTokens: 0,
};

export class DSVKSettingsTab extends PluginSettingTab {
  plugin: DSVKPlugin;

  constructor(app: App, plugin: DSVKPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "VaultCurator · 库策 — 设置" });

    new Setting(containerEl)
      .setName("DeepSeek API Key")
      .setDesc("必填。明文存于 data.json,请勿分享 vault。可到 platform.deepseek.com 获取。")
      .addText((tb) => {
        tb.inputEl.type = "password";
        tb.setPlaceholder("sk-...").setValue(this.plugin.settings.apiKey);
        tb.onChange(async (v) => {
          this.plugin.settings.apiKey = v.trim();
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Base URL")
      .setDesc("默认 https://api.deepseek.com,一般无需修改。")
      .addText((tb) =>
        tb
          .setPlaceholder("https://api.deepseek.com")
          .setValue(this.plugin.settings.baseUrl)
          .onChange(async (v) => {
            this.plugin.settings.baseUrl = v.trim() || "https://api.deepseek.com";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("模型")
      .setDesc("deepseek-v4-flash 快且省(支持工具);deepseek-v4-pro 更强更贵(支持工具);deepseek-reasoner 纯推理(不支持工具)。")
      .addDropdown((dd) =>
        dd
          .addOption("deepseek-v4-flash", "deepseek-v4-flash(快·省)")
          .addOption("deepseek-v4-pro", "deepseek-v4-pro(强·贵)")
          .addOption("deepseek-reasoner", "deepseek-reasoner(纯推理·无工具)")
          .setValue(this.plugin.settings.model)
          .onChange(async (v) => {
            this.plugin.settings.model = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("权限模式")
      .setDesc(
        "auto=AI 自动执行(默认,仍受硬安全约束:不碰 .git/.obsidian/.claudian,不执行 git/shell);proposal=写操作逐条确认;normal=只读问答。写操作能力在 M3b 加入,当前阶段仅只读工具。"
      )
      .addDropdown((dd) =>
        dd
          .addOption("auto", "auto(全自动)")
          .addOption("proposal", "proposal(逐条确认)")
          .addOption("normal", "normal(只读)")
          .setValue(this.plugin.settings.permissionMode)
          .onChange(async (v) => {
            this.plugin.settings.permissionMode = v as DSVKSettings["permissionMode"];
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("对话上下文长度")
      .setDesc("发送给模型的最近消息条数,越大越费 token。")
      .addSlider((sl) =>
        sl
          .setLimits(10, 100, 5)
          .setValue(this.plugin.settings.chatHistory)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.chatHistory = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Temperature")
      .setDesc("0.0–1.0,越低越稳定。整理任务建议 0.2–0.4。")
      .addSlider((sl) =>
        sl
          .setLimits(0, 100, 5)
          .setValue(Math.round(this.plugin.settings.temperature * 100))
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.temperature = v / 100;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("最大输出 tokens")
      .addText((tb) =>
        tb
          .setValue(String(this.plugin.settings.maxTokens))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            if (!isNaN(n) && n > 0) {
              this.plugin.settings.maxTokens = n;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("规则文档(系统提示词来源)")
      .setDesc("每行一个 vault 内 md 路径,回车分隔。改这些文档即改管家行为。")
      .addTextArea((ta) =>
        ta
          .setPlaceholder("AI-入口.md")
          .setValue(this.plugin.settings.rulesPaths.join("\n"))
          .onChange(async (v) => {
            this.plugin.settings.rulesPaths = v.split("\n").map((s) => s.trim()).filter(Boolean);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("自动模式(跳过预览确认)")
      .setDesc("历史选项,已被「权限模式」取代;保留兼容。")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoMode).onChange(async (v) => {
          this.plugin.settings.autoMode = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("自动写变更日志")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.writeChangelog).onChange(async (v) => {
          this.plugin.settings.writeChangelog = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("测试连接")
      .setDesc("调用 GET /models 校验 API Key 与网络。")
      .addButton((btn) =>
        btn.setButtonText("测试 DeepSeek 连接").setCta().onClick(async () => {
          btn.setDisabled(true).setButtonText("测试中…");
          try {
            const models = await deepseekPing(this.plugin.settings);
            new Notice("连接成功,可用模型: " + models.join(", "));
          } catch (e) {
            new Notice("连接失败: " + (e instanceof Error ? e.message : String(e)), 8000);
          } finally {
            btn.setDisabled(false).setButtonText("测试 DeepSeek 连接");
          }
        })
      );
  }
}