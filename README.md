<div align="center">

<!-- <img src="images/logo.png" alt="OllamaPilot Logo" width="160" /> -->

# OllamaPilot

### A fully local, offline AI coding assistant for VS Code

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/kchikech.ollamapilot?label=Marketplace&color=007ACC&logo=visual-studio-code)](https://marketplace.visualstudio.com/items?itemName=kchikech.ollamapilot)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/kchikech.ollamapilot?label=Installs&color=007ACC)](https://marketplace.visualstudio.com/items?itemName=kchikech.ollamapilot)
[![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)](https://github.com/kchikech/Ollama_Agent/releases)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.80.0-007ACC.svg)](https://code.visualstudio.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![Offline](https://img.shields.io/badge/works-100%25%20offline-success.svg)](#)

**No cloud. No subscriptions. No telemetry. Just you, your code, and a local AI.**

<br/>

![OllamaPilot Demo](images/demo.gif)

</div>

---

## ✨ What is OllamaPilot?

OllamaPilot is a free, open-source VS Code extension that brings a **Cursor-like AI coding assistant** experience directly into VS Code — running entirely on your machine using [Ollama](https://ollama.com).

- 🔒 **100% private** — your code never leaves your machine
- 🌐 **100% offline** — no internet connection required after setup
- 💸 **100% free** — no API keys, no subscriptions, no usage limits
- ⚡ **Streaming responses** — token-by-token output just like ChatGPT
- 🛠️ **Agentic tools** — the AI can read, write, search, and run commands in your workspace
- 📎 **@file mentions** — attach any workspace file to your message with `@filename`
- 🎨 **Syntax highlighting** — offline code highlighting for 30+ languages (no CDN)
- 📊 **Token estimation** — see context usage before sending, with model-aware limits
- 🧠 **Project memory** — the AI can persist notes about your project across sessions
- 🔀 **Git diff context** — optionally inject uncommitted changes for change-aware assistance
- 🕐 **Chat history** — conversations are saved and restored across VS Code sessions
- 🖥️ **Cursor-like UI** — modern sidebar chat panel that fits right into VS Code

---

## 📋 Table of Contents

- [Prerequisites](#-prerequisites)
- [Installation](#-installation)
- [Getting Started](#-getting-started)
- [Features](#-features)
- [Agent Tools](#-agent-tools)
- [@File Mentions](#-file-mentions)
- [Project Memory](#-project-memory)
- [Git Diff Context](#-git-diff-context)
- [Chat History](#-chat-history)
- [Configuration / Settings](#-configuration--settings)
- [Keyboard Shortcuts](#-keyboard-shortcuts)
- [How It Works](#-how-it-works)
- [Supported Models](#-supported-models)
- [Contributing](#-contributing)
- [Development Setup](#-development-setup)
- [Roadmap](#-roadmap)
- [License](#-license)

---

## 📦 Prerequisites

Before installing the extension you need **Ollama** running on your machine.

### 1. Install Ollama

| Platform | Method |
|---|---|
| **macOS** | `brew install ollama` or download from [ollama.com](https://ollama.com/download) |
| **Linux** | `curl -fsSL https://ollama.com/install.sh \| sh` |
| **Windows** | Download the installer from [ollama.com/download](https://ollama.com/download) |

### 2. Pull a model

```bash
# Recommended: fast and code-aware (4 GB)
ollama pull qwen2.5-coder:7b

# Lightweight option (2 GB)
ollama pull phi3

# Large, high quality (8 GB)
ollama pull llama3.1:8b

# See all available models at https://ollama.com/library
ollama list
```

### 3. Start Ollama

```bash
ollama serve
```

> **Tip:** On macOS and Windows, Ollama starts automatically after installation. On Linux you may need to run `ollama serve` manually or set it up as a systemd service.

---

## 🚀 Installation

### Option A — Install from VS Code Marketplace *(recommended)*

**One-click install:**
[➡ Install OllamaPilot on the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=kchikech.ollamapilot)

Or via Quick Open:
1. Open VS Code
2. Press `Ctrl+P` / `Cmd+P` and type:
   ```
   ext install kchikech.ollamapilot
   ```
3. Press Enter

### Option B — Install from `.vsix` file

1. Download the latest `.vsix` from the [Releases page](https://github.com/kchikech/Ollama_Agent/releases)
2. Open VS Code
3. Press `Ctrl+Shift+P` / `Cmd+Shift+P` → type **"Install from VSIX"**
4. Select the downloaded `.vsix` file
5. Reload VS Code when prompted

### Option C — Install via command line

```bash
code --install-extension ollamapilot-0.1.0.vsix
```

---

## 🏁 Getting Started

1. **Open any folder** in VS Code (`File → Open Folder`)
2. **Start Ollama** if it isn't already running: `ollama serve`
3. **Click the robot icon** `🤖` in the Activity Bar (left sidebar)
4. **Select your model** from the dropdown in the chat header
5. **Type your first message** and press `Enter`

That's it. The agent will start responding immediately.

### First things to try

```
"Explain what this project does"
"List all files in this project"
"Find where the API routes are defined"
"@src/api/user.ts  Refactor fetchUser to handle errors properly"
"What are my uncommitted changes about?"
"Remember: this project uses Prisma, not raw SQL"
"Run npm install"
```

---

## 🌟 Features

### 🗨️ Chat Interface
- Cursor-style **sidebar chat panel** in the VS Code Activity Bar
- **Streaming responses** — see the AI's output token by token
- **Markdown rendering** — formatted text, headers, lists, and more
- **Syntax-highlighted code blocks** — offline highlight.js, 30+ languages, VS Code-themed colours
- **One-click copy** on every code block
- **User and assistant message bubbles** clearly differentiated
- **Timestamps** on every message
- **Retry button** — regenerate any assistant response
- **Stop button** — cancel generation mid-stream
- **New chat button** — start a fresh conversation
- **Welcome screen** with quick-start hints
- **Smart scrolling** — auto-scrolls during generation, pauses when you scroll up with a ↓ button to return

### 🤖 AI Agent
- Multi-turn **agentic tool loop** — the AI can call tools, read results, then continue reasoning
- Supports **14 workspace tools** (see [Agent Tools](#-agent-tools) below)
- **Live command output** — terminal output streams directly into the chat
- **Diff preview** before applying file edits
- **Confirmation dialogs** for all destructive actions (write, delete, run command)
- **Automatic tool-mode fallback** — works with models that don't support native tool calling
- **Project memory tools** — the AI can save and recall notes about your project

### 📎 @File Mentions
- Type `@` in the input to trigger fuzzy file search
- **Autocomplete dropdown** with instant filtering as you type
- **Arrow-key navigation** and Enter / Tab to select
- Selected files appear as **pills** in the context bar — click `×` to remove
- Multiple mentions in a single message — no duplicates with auto-attached files
- Files are read and attached inline before the message is sent (capped at 100 KB per file)

### 📊 Token / Context Estimation
- **Live token counter** in the input footer updates as you type
- **Model-aware context windows** — knows the limits of llama3, qwen2.5-coder, phi3, mistral, and more
- Turns **amber** at 75% usage, **red** at 95%
- Counts prompt text + @mentioned files + auto-attached context

### 📂 Workspace Awareness
- **Active file context** — attach the current file to any message with one click
- **Selection context** — attach selected code automatically
- **Auto-title** — chat sessions are named after your first message
- Context pills show what's attached before sending

### 🕐 Chat History
- Conversations **persist across VS Code restarts**
- **History panel** accessible via the 🕐 button
- Load, browse, and delete past sessions
- Full conversation context is restored (the model remembers prior exchanges)

### ⚙️ Settings
- Configurable **Ollama base URL** (supports remote Ollama instances)
- Per-session **model selection** via the header dropdown
- **Temperature** control
- **Custom system prompt** override
- Optional **git diff context** injection
- All settings accessible via `Settings → Extensions → Ollama Agent`

---

## 🛠️ Agent Tools

The AI can autonomously call the following tools during a conversation:

| Tool | Description | Confirmation Required |
|---|---|---|
| `workspace_summary` | Full project tree, type detection, key files, recently modified | — |
| `read_file` | Read any file in the workspace | — |
| `list_files` | List directory contents | — |
| `search_files` | Search for text across all workspace files | — |
| `create_file` | Create a new file with content | — |
| `edit_file` | Targeted patch edit (old → new string) with VS Code diff preview | ✅ |
| `write_file` | Overwrite a file entirely | ✅ |
| `append_to_file` | Append text to an existing file | — |
| `rename_file` | Rename or move a file | ✅ |
| `delete_file` | Delete a file | ✅ |
| `run_command` | Execute shell commands with live output streaming | ✅ |
| `memory_list` | Recall all saved project notes for this workspace | — |
| `memory_write` | Save a persistent note (fact, decision, convention) about the project | — |
| `memory_delete` | Delete a saved note by id | — |

> **Safety:** All file modifications and command executions require explicit confirmation via a VS Code dialog. Paths are validated to stay within the workspace root. Dangerous command patterns (`rm -rf /`, `mkfs`, etc.) are blocked before the confirmation dialog even appears.

### Example agent workflow

```
User:  "@src/api/user.ts  Refactor fetchUser to handle errors properly"

Agent: → memory_list()                 (recall any prior project notes)
       → read_file("src/api/user.ts")  (read the attached file)
       → edit_file(...)                (show diff → user approves)
       → memory_write("fetchUser now  (save the decision for future sessions)
                       uses Result<T>")
       ← "Done. I updated fetchUser to use try/catch and return a Result type..."
```

---

## 📎 @File Mentions

@mentions let you attach any file from your workspace directly in the chat input — similar to Cursor's `@` feature.

**How to use:**

1. Type `@` anywhere in the message input
2. A fuzzy-search dropdown appears with matching files
3. Type more characters to filter, use `↑` `↓` to navigate
4. Press `Enter`, `Tab`, or click to attach the file
5. The file appears as a **pill** in the context bar
6. Remove it with `×` at any time before sending

**What happens when you send:**

- The file content is read on the extension side (not the webview)
- It is attached as a structured `<mention>` block after your message
- Large files are automatically capped at 100 KB
- If the same file is already auto-attached (via the file toggle), it won't be duplicated

---

## 🧠 Project Memory

Project memory lets the AI save and recall notes about your workspace — **persisted across all sessions**, scoped per workspace folder.

The AI uses three tools to manage memory automatically:

| Tool | What it does |
|---|---|
| `memory_list` | Reads all saved notes at the start of a conversation |
| `memory_write` | Saves a note with optional tag (e.g. `architecture`, `bug`, `decision`) |
| `memory_delete` | Removes a stale or incorrect note by its id |

**Example use cases:**

```
"Remember that we use Prisma ORM, not raw SQL"
→ Agent saves: tag=architecture "this project uses Prisma ORM, not raw SQL"

"What do you know about this project?"
→ Agent calls memory_list() and summarises saved notes

"Forget the note about the old API endpoint"
→ Agent calls memory_delete(id)
```

Notes are stored in VS Code's `workspaceState` — automatically scoped to the current workspace folder, never committed to git, and never shared between workspaces.

---

## 🔀 Git Diff Context

When enabled, OllamaPilot automatically injects a summary of your **uncommitted changes** into every message — giving the AI awareness of what you're currently working on without you having to explain it.

**Enable it:**

```json
// .vscode/settings.json  (or via Settings UI)
{
  "ollamaAgent.injectGitDiff": true
}
```

**What gets injected:**

- `git diff` (unstaged changes) + `git diff --cached` (staged changes)
- A one-line stat summary (e.g. "3 files changed, 42 insertions, 7 deletions")
- Automatically truncated at 8 KB to protect your context window
- Gracefully skipped if the folder is not a git repo or git is unavailable

**Example prompt with git diff:**

```
User: "Why is the login test failing?"

Agent receives:
  Your message +
  <git-diff summary="2 files changed, 15 insertions, 3 deletions">
  diff --git a/src/auth/login.ts ...
  </git-diff>
```

---

## 🕐 Chat History

Every conversation is automatically saved to VS Code's global storage after each assistant response.

| Action | How |
|---|---|
| **Open history** | Click the 🕐 button in the chat header |
| **Load a session** | Click any session in the list |
| **Delete a session** | Hover over a session → click 🗑 |
| **Delete all** | Open history → click "Delete all" |
| **New chat** | Click ＋ in the chat header, or use `Cmd+Shift+O` |

When you load a session, both the **visual chat** and the **conversation context** (the model's memory) are fully restored.

> Sessions are stored in VS Code's global state (not in your filesystem) so they are not committed to git.

---

## ⚙️ Configuration / Settings

Open `Settings` (`Ctrl+,` / `Cmd+,`) and search for **"Ollama"** to see all options.

| Setting | Default | Description |
|---|---|---|
| `ollamaAgent.baseUrl` | `""` | Full Ollama URL, e.g. `http://localhost:11434`. Overrides host + port when set. Useful for remote Ollama instances. |
| `ollamaAgent.host` | `localhost` | Ollama hostname (used only when `baseUrl` is empty) |
| `ollamaAgent.port` | `11434` | Ollama port (used only when `baseUrl` is empty) |
| `ollamaAgent.model` | `llama2` | Default model at startup. Overridable per session via the dropdown. |
| `ollamaAgent.temperature` | `0.7` | Sampling temperature. 0 = deterministic, 1 = balanced, 2 = creative |
| `ollamaAgent.systemPrompt` | `""` | Custom system prompt. Leave empty to use the built-in coding assistant prompt. |
| `ollamaAgent.autoIncludeFile` | `false` | Auto-attach the active file's full content to every message |
| `ollamaAgent.autoIncludeSelection` | `true` | Auto-attach selected code when a selection exists |
| `ollamaAgent.maxContextFiles` | `5` | Maximum number of workspace files to auto-load as context |
| `ollamaAgent.injectGitDiff` | `false` | Inject uncommitted `git diff` into every message for change-aware context |

### Example: Using a remote Ollama instance

```json
// .vscode/settings.json
{
  "ollamaAgent.baseUrl": "http://192.168.1.100:11434",
  "ollamaAgent.model": "qwen2.5-coder:7b"
}
```

### Example: Custom system prompt with git diff

```json
{
  "ollamaAgent.systemPrompt": "You are a senior TypeScript engineer. Always write strict types. Prefer functional patterns.",
  "ollamaAgent.injectGitDiff": true
}
```

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Cmd+Shift+O` / `Ctrl+Shift+O` | Open the OllamaPilot chat panel |
| `Enter` | Send message |
| `Shift+Enter` | New line in the message input |
| `@` | Trigger file mention autocomplete |
| `↑` / `↓` | Navigate the @mention dropdown |
| `Tab` / `Enter` | Select highlighted @mention |
| `Escape` | Dismiss the @mention dropdown |

---

## 🔍 How It Works

```
┌─────────────────────────────────────────────────────────┐
│                    VS Code Extension                     │
│                                                         │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────┐  │
│  │   Webview    │◄──►│   Provider   │◄──►│  Agent   │  │
│  │  (Chat UI)   │    │ (Msg Router) │    │  (Loop)  │  │
│  └──────────────┘    └──────────────┘    └──────────┘  │
│         │                   │                  │        │
│         │                   │            ┌─────▼──────┐│
│         │                   │            │   Tools    ││
│         │                   │            │ read_file  ││
│         │                   │            │ edit_file  ││
│         │                   │            │ memory_*   ││
│         │                   │            └────────────┘│
│         │            ┌──────▼──────┐                   │
│         │            │  Storage    │                   │
│         │            │ globalState │                   │
│         │            │workspaceState                   │
│         │            └─────────────┘                   │
└─────────┼───────────────────────────────────────────────┘
          │
          ▼ HTTP (localhost)
┌─────────────────────┐
│     Ollama Server   │
│  localhost:11434    │
│                     │
│  llama3 / qwen /    │
│  phi / mistral /    │
│  codellama / ...    │
└─────────────────────┘
```

### Architecture

The extension is built in clean TypeScript modules:

```
src/
├── main.ts           Entry point — activate() registers commands and the sidebar provider
├── provider.ts       WebviewViewProvider — routes messages, manages sessions, resolves @mentions
├── agent.ts          Agent loop — multi-turn tool calling, mode switching, history
├── ollamaClient.ts   HTTP client for Ollama API (/api/chat, /api/tags)
├── chatStorage.ts    Session persistence via vscode.ExtensionContext.globalState
├── projectMemory.ts  Workspace-scoped project notes via vscode.ExtensionContext.workspaceState
├── mentions.ts       Workspace file indexer and fuzzy search for @mention autocomplete
├── gitContext.ts     Git diff extraction — staged + unstaged changes, auto-truncated
├── config.ts         Configuration reader (maps VS Code settings → typed OllamaConfig)
├── context.ts        Active file / selection extraction from the editor
├── workspace.ts      Project scanner — file tree, project type, key files, recent files
└── logger.ts         Shared OutputChannel logger

webview/
├── webview.html      Chat panel UI — VS Code theme variables, no frameworks
├── webview.js        Frontend logic — streaming, markdown, @mentions, token counter, history
└── vendor/
    └── highlight.bundle.js   Vendored offline highlight.js (30+ languages, no CDN)

scripts/
└── vendor-hljs.js    Build script — generates the highlight.js browser bundle
```

### Message flow

1. User types a message (optionally with `@file` mentions) and presses Enter
2. Webview sends `{ command: 'sendMessage', text, model, includeFile, includeSelection, mentionedFiles }` to the extension
3. Provider resolves @mentions (reads file content), builds context string, and optionally injects git diff
4. `Agent.run()` sends the full conversation to Ollama via streaming `/api/chat`
5. Each token is forwarded to the webview as `{ type: 'token', text }`
6. When the model emits a tool call, the agent executes it (with confirmation if needed) and loops
7. On `streamEnd`, the provider saves the complete assistant message to the current session

### Tool calling — two modes

| Mode | When used | How |
|---|---|---|
| **Native** | Models that support Ollama tool calling (llama3-groq-tool-use, qwen2.5-coder, etc.) | Tools passed as JSON schema in the API request |
| **Text (fallback)** | All other models (llama2, phi, mistral, etc.) | Tool instructions injected into the system prompt; the model emits `<tool>{"name":...}</tool>` blocks which are parsed client-side |

The switch happens automatically on the first `HTTP 400 — does not support tools` error, with no interruption to the user experience.

---

## 📡 Supported Models

Any model available in Ollama works with this extension. Models known to work well:

| Model | Size | Notes |
|---|---|---|
| `qwen2.5-coder:7b` | ~4 GB | ⭐ Recommended — excellent at coding, native tools, large context |
| `qwen2.5-coder:1.5b` | ~1 GB | Fastest, good for quick tasks |
| `llama3.1:8b` | ~5 GB | General purpose, high quality |
| `phi3:mini` | ~2 GB | Very fast, good for simple tasks |
| `codellama:7b` | ~4 GB | Specialized for code generation |
| `mistral:7b` | ~4 GB | Well-rounded, good reasoning |
| `deepseek-coder:6.7b` | ~4 GB | Strong at code tasks |
| `deepseek-r1:8b` | ~5 GB | Reasoning model, excellent for complex refactors |
| `llama2` | ~4 GB | Classic, text-mode fallback activated automatically |

> **Token limits:** The token counter in the footer automatically adapts to the known context window of your selected model. If your model is not in the built-in list, a safe default of 8 192 tokens is assumed.

Pull any model with:
```bash
ollama pull <model-name>
```

---

## 🤝 Contributing

Contributions are warmly welcome! Whether it's a bug fix, a new feature, better documentation, or a UX improvement — all pull requests are reviewed.

### Ways to contribute

- 🐛 **Report bugs** — open an [Issue](https://github.com/kchikech/Ollama_Agent/issues) with reproduction steps
- 💡 **Suggest features** — open an Issue with the `enhancement` label
- 🔧 **Submit a PR** — see [Development Setup](#-development-setup) below
- 📖 **Improve docs** — typos, clarity, missing info
- 🌍 **Share** — star the repo, mention it to other developers

### Code of Conduct

Be kind, be constructive. We follow the [Contributor Covenant](https://www.contributor-covenant.org/).

---

## 🛠️ Development Setup

### Requirements

- Node.js 18+
- npm 9+
- VS Code 1.80+
- Ollama running locally

### Clone and build

```bash
# 1. Clone the repo
git clone https://github.com/kchikech/Ollama_Agent.git
cd Ollama_Agent

# 2. Install dev dependencies
npm install

# 3. Compile TypeScript + generate vendor bundle
npm run build

# 4. Package as .vsix for testing
npx vsce package
```

> `npm run build` runs two steps: `npm run vendor` (generates `webview/vendor/highlight.bundle.js`) then `tsc`.

### Run in development mode

1. Open the `Ollama_Agent` folder in VS Code
2. Press `F5` — this opens a new **Extension Development Host** window with the extension loaded
3. Make changes → `npm run build` → reload the Extension Development Host (`Ctrl+R`)

### Project structure

| Path | Purpose |
|---|---|
| `src/` | All TypeScript source — compiled to `dist/` |
| `webview/` | Frontend HTML + vanilla JS — inlined into the webview at runtime |
| `webview/vendor/` | Vendored offline highlight.js bundle (generated, gitignored) |
| `scripts/` | Build utilities (vendor-hljs.js) |
| `images/` | Extension icons and demo GIF |
| `dist/` | Compiled output (gitignored) |
| `.vscodeignore` | Files excluded from the `.vsix` package |

### Adding a new agent tool

1. Add the tool definition to `TOOL_DEFINITIONS` in `src/agent.ts`
2. Add the execution case in `Agent.executeTool()`
3. Add an icon to `TOOL_ICONS` in `webview/webview.js`
4. Update `TEXT_MODE_TOOL_INSTRUCTIONS` in `src/agent.ts`
5. Update the system prompt in `DEFAULT_SYSTEM_PROMPT` in `src/agent.ts`
6. Add the tool to this README's [Agent Tools](#-agent-tools) table

### Running diagnostics

Use the built-in diagnostic command to verify your Ollama connection:

```
Ctrl+Shift+P → "Ollama: Run Diagnostics"
```

This tests HTTP connectivity, lists models, and runs a streaming test. Output appears in `Output → Ollama Agent`.

---

## 🗺️ Roadmap

### v0.1.0 — Enhanced Context ✅ *current*
- [x] `@filename` mention in the prompt to attach specific files
- [x] Token count indicator showing context size before sending
- [x] Offline syntax highlighting (highlight.js, 30+ languages)
- [x] `git diff` context injection (opt-in via setting)
- [x] Persistent project memory / notes (per-workspace)

### v0.2.0 — UX Polish
- [ ] Export chat as Markdown
- [ ] Message search within a session
- [ ] Configurable keyboard shortcut
- [ ] Extension icon and Marketplace banner image

### v0.3.0 — Code Intelligence
- [ ] Inline diff application directly in the editor
- [ ] Multi-workspace folder support
- [ ] `@symbol` mention to attach a specific function or class

### v1.0.0 — Stability
- [ ] Comprehensive test suite
- [ ] Memory UI panel (browse/edit notes without the agent)
- [ ] Export / import project memory

> Have a feature idea? [Open an issue](https://github.com/kchikech/Ollama_Agent/issues/new?labels=enhancement) — community feedback drives the roadmap.

---

## ❓ FAQ

**Q: Does it work without internet?**
A: Yes. Once Ollama is installed and a model is pulled, the extension works completely offline. Syntax highlighting also runs fully offline — no CDN requests. No data is ever sent to any external server.

**Q: How do @file mentions work?**
A: Type `@` in the input box, start typing a filename, and select from the dropdown. The file content is read on the extension side and attached to your message as context. Files are capped at 100 KB to protect your context window.

**Q: What is project memory? Is it the same as chat history?**
A: No. Chat history saves the full conversation transcript. Project memory is a separate, persistent notes store that the AI can read and write to using tools — it survives even when you start a new chat. Use it for project conventions, known bugs, architecture decisions, etc.

**Q: My model doesn't support tools — will agent features still work?**
A: Yes. The extension automatically detects when a model doesn't support native tool calling and switches to a text-mode fallback where tool instructions are embedded in the system prompt. You'll see an amber notice in the chat when this happens.

**Q: Can I use a remote Ollama instance?**
A: Yes. Set `ollamaAgent.baseUrl` to the remote URL (e.g. `http://192.168.1.100:11434`). HTTPS is also supported.

**Q: Where are my chats stored?**
A: In VS Code's global extension storage (`globalState`). They are not stored in your filesystem or committed to git. Use the "Delete all" button in the history panel to remove them.

**Q: Where is project memory stored?**
A: In VS Code's workspace-scoped storage (`workspaceState`) — automatically isolated per workspace folder, not in your filesystem, not committed to git.

**Q: The token counter seems off — is it accurate?**
A: It's an approximation using the 4 characters ≈ 1 token heuristic, which is standard for English and code. It won't be exact (exact tokenisation requires the model's tokenizer), but it's close enough to warn you before you hit context limits.

**Q: Can the AI modify my files without asking?**
A: No. Every file write, edit, rename, and delete requires you to click **Apply** / **Write** / **Delete** in a confirmation dialog. Command execution (`run_command`) also requires explicit confirmation.

**Q: The extension shows "Ollama not running". What do I do?**
A: Run `ollama serve` in a terminal. On macOS you can also start it from the menu bar icon.

---

## 🔒 Privacy

This extension is designed with privacy as a first-class concern:

- ✅ All processing happens locally on your machine
- ✅ No analytics, telemetry, or usage tracking of any kind
- ✅ No network requests except to your local Ollama instance
- ✅ Chat history and project memory stored only in VS Code's local extension storage
- ✅ No API keys or accounts required
- ✅ Open source — audit the code yourself

---

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.

---

## 🙏 Acknowledgements

- [Ollama](https://ollama.com) — for making local LLMs accessible to everyone
- [highlight.js](https://highlightjs.org) — for the offline syntax highlighting engine
- [VS Code Extension API](https://code.visualstudio.com/api) — for the powerful webview and workspace APIs
- All contributors and early adopters who helped shape this extension

---

<div align="center">

<!-- **Made with ❤️ by the open-source community** -->

[Report a Bug](https://github.com/kchikech/Ollama_Agent/issues) · [Request a Feature](https://github.com/kchikech/Ollama_Agent/issues) · [Contribute](CONTRIBUTING.md)

⭐ Star this repo if you find it useful!

</div>
