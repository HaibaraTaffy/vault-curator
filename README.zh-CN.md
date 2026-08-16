# VaultCurator · 库策

> [English](README.md) · [中文](README.zh-CN.md)

**DeepSeek 驱动的 Obsidian 知识库管家** —— 对话、扫描、搜索、读写笔记,自动备份 + **不依赖 git 的历史回滚**。

一个 **DeepSeek 专属** 的 Obsidian 插件:把整个 vault 变成管家的工作区。直接对话让它干活——
它会调用工具查看/整理仓库,写操作前自动快照、写后留痕,**随时可回滚**。

规则由 vault 内 md 文档驱动:改 `AI-入口.md`、`README.md`、`知识库/_模板/主题页模板.md`,
即改管家行为。

## ✨ 功能

- **对话面板**:流式输出、会话管理(按创建时间编号)、模型一键切换(flash / pro / reasoner)
- **工具调用**:`scan_vault` / `read_note` / `search_notes` / `list_files` / `rules_status`(只读)
  + `create_note` / `update_note` / `move_note` / `delete_note`(写操作)
- **写入范围可配置**:整个仓库或仅指定目录(设置页);改动前快照到 `AI-Workspace/archive/`,记录到 `AI-Workspace/change-log/`
- **历史回滚(不依赖 git)**:命令「历史与回滚」查看每次改动 Diff 并一键回滚
- **权限模式**:`auto`(自动执行)/ `proposal`(逐条确认)/ `normal`(只读)
- **成本统计**:本次/会话/全部累计 token 与费用(按 DeepSeek 最新价估算)
- **引用集成**:编辑器选中文字 → 右键「用选中文本问 VaultCurator」;输入框 `/` 快捷指令

## 🚀 安装

1. 下载 [最新 Release](https://github.com/HaibaraTaffy/vault-curator/releases) 里的 `main.js`、`manifest.json`、`styles.css`
2. 复制到 `<你的vault>/.obsidian/plugins/vault-curator/`
3. 重启 Obsidian → 设置 → 第三方插件 → 启用
4. 在插件设置页填入 DeepSeek API Key → 点「测试连接」

> 也可用 [BRAT](https://github.com/TfTHacker/obsidian42-brat) 安装测试版。

## ⚙️ 配置

| 设置 | 说明 |
|---|---|
| API Key | platform.deepseek.com 获取 |
| 模型 | deepseek-v4-flash(快·省)/ deepseek-v4-pro(强·贵)/ deepseek-reasoner(纯推理) |
| 权限模式 | auto / proposal / normal |
| 规则文档 | 系统提示词来源(vault 内 md 路径,可自定义) |
| 上下文长度 | 发送给模型的最近消息条数 |

## 🧭 命令

- `打开 VaultCurator 对话面板`
- `扫描 vault 生成报告(只读)`
- `一键整理:AI 增量整理建议(只读,消耗 API)`
- `历史与回滚:查看并恢复 AI 的改动`
- `测试 DeepSeek 连接` / `查看规则文档加载状态`

## 🛡️ 安全边界(硬编码,不靠 AI 自觉)

- 只允许写入 `知识库/`、`mynote/`、`Internet_source/`、`AI-Workspace/`、`pasted_picture/`
- 绝不触碰 `.git`、`.obsidian`(本插件自身除外)、`.claudian`;不执行任何 git/shell 命令
- 每次写操作:先快照备份,再写变更日志;删除进系统回收站
- 历史回滚独立于 git,随时恢复任意版本

## 💻 开发

```bash
npm install
npm run dev     # 监听构建(rollup -w)
npm run build   # 类型检查 + rollup 打包
```

## 📦 发布(开源)

打 tag 即触发 GitHub Actions 自动构建并发布 Release:

```bash
git tag 1.0.0
git push origin 1.0.0
```

## 🗺️ 路线

- [x] 对话面板 + 会话管理 + 流式输出
- [x] 只读/写操作工具 + 权限模式
- [x] 备份 + 变更日志 + 历史回滚(不依赖 git)
- [x] 成本统计、引用选中、快捷指令、来源标注
- [ ] 改动面板 diff 增强、会话导出、编辑器内联处理

## 📄 License

[MIT](./LICENSE)