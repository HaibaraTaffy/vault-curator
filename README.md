# VaultCurator

> [English](README.md) · [中文](README.zh-CN.md)

**DeepSeek-powered steward for your Obsidian knowledge base** — chat, scan, search, read & write notes, with auto-backup and **git-free history rollback**.

A DeepSeek-only Obsidian plugin that turns your vault into the steward's workspace. Just chat with it and let it work:
it calls tools to inspect and organize your vault; every write is snapshotted before it happens and logged after,
and can be **rolled back anytime** — no git required.

Rules are driven by markdown docs inside your vault: edit `AI-入口.md`, `README.md`, `知识库/_模板/主题页模板.md`
and the steward's behavior changes accordingly.

## ✨ Features

- **Chat panel**: streaming output, session management (numbered by creation time), one-click model switch (flash / pro / reasoner)
- **Tool calling**: `scan_vault` / `read_note` / `search_notes` / `list_files` / `rules_status` (read-only)
  + `create_note` / `update_note` / `move_note` / `delete_note` (write)
- **Write safety net**: snapshot to `AI-Workspace/archive/` before every change, record to `AI-Workspace/change-log/`
- **History rollback (no git)**: command "History & Rollback" shows diffs of every change and restores any version
- **Permission modes**: `auto` (execute immediately) / `proposal` (confirm each) / `normal` (read-only)
- **Cost stats**: per-turn / per-session / total token & cost estimates (latest DeepSeek pricing)
- **Editor integration**: right-click selected text → "Ask VaultCurator"; type `/` in the input for quick prompts

## 🚀 Install

1. Download `main.js`, `manifest.json`, `styles.css` from the [latest release](https://github.com/HaibaraTaffy/vault-curator/releases)
2. Copy them to `<your-vault>/.obsidian/plugins/vault-curator/`
3. Restart Obsidian → Settings → Community plugins → Enable
4. Enter your DeepSeek API key in the plugin settings → click "Test connection"

> You can also install development builds with [BRAT](https://github.com/TfTHacker/obsidian42-brat).

## ⚙️ Configuration

| Setting | Description |
|---|---|
| API Key | Get one at platform.deepseek.com |
| Model | deepseek-v4-flash (fast, cheap) / deepseek-v4-pro (stronger) / deepseek-reasoner (reasoning only) |
| Permission mode | auto / proposal / normal |
| Rules docs | Sources of the system prompt (vault md paths, customizable) |
| Context length | Recent messages sent to the model |

## 🧭 Commands

- `Open VaultCurator chat panel`
- `Scan vault for report (read-only)`
- `One-click organize: AI incremental suggestions (read-only, uses API)`
- `History & Rollback: review and restore AI changes`
- `Test DeepSeek connection` / `Show rules loading status`

## 🛡️ Safety boundaries (hard-coded, not left to the model)

- Writes are only allowed under `知识库/`, `mynote/`, `Internet_source/`, `AI-Workspace/`, `pasted_picture/`
- Never touches `.git`, `.obsidian` (except its own files), `.claudian`; never runs git/shell commands
- Every write: snapshot first, then changelog; deletes go to the system trash
- Rollback is independent of git — restore any version at any time

## 💻 Development

```bash
npm install
npm run dev     # watch mode (rollup -w)
npm run build   # type-check + rollup bundle
```

## 📦 Release

Push a tag to trigger the GitHub Actions release build:

```bash
git tag 1.0.0
git push origin 1.0.0
```

## 🗺️ Roadmap

- [x] Chat panel, sessions, streaming
- [x] Read/write tools + permission modes
- [x] Backup, changelog, git-free history rollback
- [x] Cost stats, selection context, quick prompts, citations
- [ ] Enhanced diff panel, session export, in-editor inline actions

## 📄 License

[MIT](./LICENSE)