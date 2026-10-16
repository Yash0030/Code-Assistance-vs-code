import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { spawn, ChildProcess } from 'child_process';

import { streamChatRequest, OllamaMessage, OllamaToolCall, StreamResult, ToolsNotSupportedError } from './ollamaClient';
import { getConfig } from './config';
import { logInfo, logError } from './logger';
import { buildWorkspaceSummary, SKIP_DIRS } from './workspace';
import { ProjectMemory } from './projectMemory';

// ── Limits ────────────────────────────────────────────────────────────────────

/** Max model <-> tool round trips for a single user message. */
const MAX_TURNS = 30;
/** Tool output kept in conversation history (UI preview is separate). */
const MAX_TOOL_RESULT_CHARS = 15_000;
/**
 * Rough budget for the conversation history sent to the model.
 * NOTE: Ollama's default context window is small (2048-4096 tokens). Raise `num_ctx`
 * in ollamaClient.ts (e.g. 16384+) or the model will silently forget the tools/system prompt.
 */
const MAX_HISTORY_CHARS = 60_000;
const READ_MAX_BYTES = 5 * 1024 * 1024;
const READ_MAX_CHARS = 60_000;
const SEARCH_MAX_RESULTS = 60;
const SEARCH_MAX_FILES = 5_000;
const SEARCH_MAX_FILE_BYTES = 1024 * 1024;
const FIND_MAX_RESULTS = 200;
const COMMAND_RESULT_LIMIT = 12_000;
const COMMAND_DEFAULT_TIMEOUT_S = 60;
const COMMAND_MAX_TIMEOUT_S = 600;

// ── Tool definitions ──────────────────────────────────────────────────────────

type Prop = { type: string; description: string };

function tool(
    name: string,
    description: string,
    properties: Record<string, Prop> = {},
    required: string[] = []
) {
    return {
        type: 'function',
        function: {
            name,
            description,
            parameters: { type: 'object', properties, required },
        },
    };
}

const PATH_HELP =
    'Absolute path anywhere on this computer (e.g. C:\\Users\\me\\Desktop\\x.txt or /home/me/x.txt), ' +
    '"~/..." for the home folder, "Desktop/...", "Documents/...", "Downloads/..." for those user folders, ' +
    'or a path relative to the workspace root.';

export const TOOL_DEFINITIONS = [
    tool(
        'system_info',
        'Get the OS, shell, home/Desktop/Documents/Downloads paths, workspace root and today\'s date. Call this when you need to build an absolute path.'
    ),
    tool(
        'workspace_summary',
        'Get a full summary of the workspace: file tree, project type, key files (package.json, README), and recently modified files. Call this first to understand the project.'
    ),
    tool(
        'read_file',
        'Read a text file (anywhere on the computer). Optionally read only a line range for large files.',
        {
            path: { type: 'string', description: PATH_HELP },
            start_line: { type: 'number', description: 'First line to read (1-based, optional)' },
            end_line: { type: 'number', description: 'Last line to read (inclusive, optional)' },
        },
        ['path']
    ),
    tool(
        'list_files',
        'List files and directories at a path (anywhere on the computer).',
        { path: { type: 'string', description: `Directory. ${PATH_HELP} Default: workspace root.` } }
    ),
    tool(
        'find_files',
        'Find files by name/glob pattern (e.g. "*.ts", "**/package.json", "src/**/*.test.js").',
        {
            pattern: { type: 'string', description: 'Glob pattern' },
            path: { type: 'string', description: 'Directory to search in (default: workspace root)' },
        },
        ['pattern']
    ),
    tool(
        'search_files',
        'Search file contents for text (or a regex). Returns matching file:line: text.',
        {
            query: { type: 'string', description: 'Text or regex to search for' },
            path: { type: 'string', description: 'Directory to search in (default: workspace root)' },
            is_regex: { type: 'boolean', description: 'Treat query as a regular expression (default false)' },
            include: { type: 'string', description: 'Only search files matching this glob, e.g. "*.ts"' },
        },
        ['query']
    ),
    tool(
        'create_file',
        'Create a new file with the given content (parent folders are created automatically). Fails if the file already exists. Works anywhere on the computer.',
        {
            path: { type: 'string', description: PATH_HELP },
            content: { type: 'string', description: 'File content' },
        },
        ['path', 'content']
    ),
    tool(
        'create_folder',
        'Create a folder (and any missing parents) anywhere on the computer, e.g. "Desktop/hbd" or "C:\\Projects\\app".',
        { path: { type: 'string', description: PATH_HELP } },
        ['path']
    ),
    tool(
        'edit_file',
        'Make a targeted edit to an existing file by replacing old_string with new_string. read_file first to get the exact current text. old_string must match exactly (whitespace included) and be unique unless replace_all is true. Shows a diff for approval.',
        {
            path: { type: 'string', description: PATH_HELP },
            old_string: { type: 'string', description: 'Exact text to replace' },
            new_string: { type: 'string', description: 'Replacement text' },
            replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' },
        },
        ['path', 'old_string', 'new_string']
    ),
    tool(
        'write_file',
        'Write a complete file (creates it, or overwrites if it exists). Prefer edit_file for small changes.',
        {
            path: { type: 'string', description: PATH_HELP },
            content: { type: 'string', description: 'Full file content' },
        },
        ['path', 'content']
    ),
    tool(
        'append_to_file',
        'Append text to the end of an existing file.',
        {
            path: { type: 'string', description: PATH_HELP },
            content: { type: 'string', description: 'Text to append' },
        },
        ['path', 'content']
    ),
    tool(
        'rename_file',
        'Rename or move a file or folder.',
        {
            old_path: { type: 'string', description: 'Current path' },
            new_path: { type: 'string', description: 'New path' },
        },
        ['old_path', 'new_path']
    ),
    tool(
        'copy_file',
        'Copy a file or folder (recursively).',
        {
            source: { type: 'string', description: 'Source path' },
            destination: { type: 'string', description: 'Destination path' },
        },
        ['source', 'destination']
    ),
    tool(
        'delete_file',
        'Delete a file or a folder (recursively). Requires confirmation. Use with care.',
        { path: { type: 'string', description: PATH_HELP } },
        ['path']
    ),
    tool(
        'run_command',
        'Run a shell command (cmd on Windows, sh on Linux/macOS). Output streams live to the chat. Requires confirmation. Use for git, npm, pip, builds, tests, etc.',
        {
            command: { type: 'string', description: 'Shell command to execute' },
            cwd: { type: 'string', description: 'Working directory (default: workspace root)' },
            timeout_seconds: { type: 'number', description: `Timeout in seconds (default ${COMMAND_DEFAULT_TIMEOUT_S}, max ${COMMAND_MAX_TIMEOUT_S})` },
        },
        ['command']
    ),
    tool(
        'get_diagnostics',
        'Get current VS Code errors and warnings (from the language servers). Use after editing code to verify it compiles cleanly.',
        { path: { type: 'string', description: 'Only this file (optional)' } }
    ),
    tool('memory_list', 'List all saved project memory notes for this workspace.'),
    tool(
        'memory_write',
        'Save a note to persistent project memory (facts, decisions, known issues, conventions).',
        {
            content: { type: 'string', description: 'Note content (max 4000 chars)' },
            tag: { type: 'string', description: 'Optional tag, e.g. "architecture", "bug", "todo", "decision"' },
        },
        ['content']
    ),
    tool(
        'memory_delete',
        'Delete a saved project memory note by id (get the id from memory_list).',
        { id: { type: 'string', description: 'Note id' } },
        ['id']
    ),
];

const DEFAULT_SYSTEM_PROMPT = `You are an expert autonomous AI coding assistant running inside VS Code, similar to GitHub Copilot agent mode and Claude Code.
You can read, create, edit, copy, move and delete files and folders ANYWHERE on the user's computer (not only inside the workspace), and run shell commands.

Tools:
  system_info        — OS, shell, home/Desktop/Documents/Downloads paths
  workspace_summary  — project structure overview
  read_file / list_files / find_files / search_files — explore files and code
  create_file / create_folder / write_file / append_to_file — create and write
  edit_file          — targeted edits (preferred for changing existing code)
  rename_file / copy_file / delete_file — manage files and folders
  run_command        — run shell commands (git, npm, pip, tests, builds)
  get_diagnostics    — current compiler/linter errors in VS Code
  memory_list / memory_write / memory_delete — persistent project notes

How to work:
- You have real tools. When the user asks for something to be done, DO it with the tools instead of describing how. Never claim you cannot access the user's files or Desktop; use an absolute path or Desktop/..., Documents/..., ~/... .
- The editor itself asks the user for approval on risky actions, so do not ask for permission in chat — just call the tool.
- Explore before changing: use workspace_summary, find_files, search_files and read_file. Never guess file contents.
- For existing files read_file first, then use edit_file with an exact, unique old_string. Use write_file only for new files or full rewrites.
- After changing code, verify: call get_diagnostics, and run the build/tests with run_command when sensible. Fix what you broke.
- If a tool returns an error, read it, adjust and retry with a different approach. Do not repeat the same failing call.
- Work step by step; after each tool result continue until the task is fully done, then give a short summary of what you changed.
- Only report success for things that a tool result confirmed.
- Be concise. Put code in markdown fenced code blocks.`;

// ── Text-mode tool calling (fallback for models without native tool support) ──

const TEXT_MODE_TOOL_INSTRUCTIONS = `

═══ TOOL USAGE ═══
You can call tools by outputting a tool call block in EXACTLY this format — nothing before or after it on those lines:

<tool>{"name": "TOOL_NAME", "arguments": {JSON_ARGS}}</tool>

IMPORTANT:
- Output ONLY the <tool>...</tool> block when calling a tool.
- After receiving a [TOOL RESULT: ...] block, continue the task (call another tool or give the final answer).
- Call one tool at a time and wait for its result.

Tools and their argument schemas:
  system_info         — {}
  workspace_summary   — {}
  read_file           — {"path": "...", "start_line": 1, "end_line": 100}   (lines optional)
  list_files          — {"path": "dir (optional)"}
  find_files          — {"pattern": "**/*.ts", "path": "optional dir"}
  search_files        — {"query": "text", "path": "optional dir", "is_regex": false, "include": "*.ts"}
  create_file         — {"path": "path", "content": "full content"}
  create_folder       — {"path": "Desktop/my-folder"}
  edit_file           — {"path": "path", "old_string": "exact text", "new_string": "replacement", "replace_all": false}
  write_file          — {"path": "path", "content": "full content"}
  append_to_file      — {"path": "path", "content": "text"}
  rename_file         — {"old_path": "current", "new_path": "new"}
  copy_file           — {"source": "src", "destination": "dst"}
  delete_file         — {"path": "path"}
  run_command         — {"command": "shell command", "cwd": "optional dir", "timeout_seconds": 60}
  get_diagnostics     — {"path": "optional file"}
  memory_list         — {}
  memory_write        — {"content": "note text", "tag": "optional tag"}
  memory_delete       — {"id": "note id"}
═══════════════════`;

const TOOL_NAMES = new Set(
    TOOL_DEFINITIONS.map((t) => t.function.name)
);

function asArgs(value: unknown): Record<string, unknown> | undefined {
    if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch { return undefined; }
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, unknown>;
    }
    return undefined;
}

function toToolCall(parsed: unknown): OllamaToolCall | undefined {
    if (!parsed || typeof parsed !== 'object') { return undefined; }
    const p = parsed as Record<string, unknown>;
    const name = p.name;
    if (typeof name !== 'string' || !TOOL_NAMES.has(name)) { return undefined; }
    const args = asArgs(p.arguments ?? p.parameters ?? p.args ?? {});
    if (!args) { return undefined; }
    return { function: { name, arguments: args } } as OllamaToolCall;
}

/** Parse <tool>...</tool> blocks from text-mode model output. */
function parseTextToolCalls(text: string): OllamaToolCall[] {
    const calls: OllamaToolCall[] = [];
    const pattern = /<tool>([\s\S]*?)<\/tool>/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
        try {
            const call = toToolCall(JSON.parse(match[1].trim()));
            if (call) { calls.push(call); }
        } catch { /* skip malformed block */ }
    }
    return calls;
}

/** Find top-level balanced {...} spans (string/escape aware). */
function findJsonSpans(text: string): Array<{ start: number; end: number }> {
    const spans: Array<{ start: number; end: number }> = [];
    let i = 0;
    while (i < text.length) {
        if (text[i] !== '{') { i++; continue; }
        let depth = 0;
        let inStr = false;
        let esc = false;
        let j = i;
        for (; j < text.length; j++) {
            const c = text[j];
            if (inStr) {
                if (esc) { esc = false; }
                else if (c === '\\') { esc = true; }
                else if (c === '"') { inStr = false; }
                continue;
            }
            if (c === '"') { inStr = true; }
            else if (c === '{') { depth++; }
            else if (c === '}') {
                depth--;
                if (depth === 0) { break; }
            }
        }
        if (depth === 0 && j < text.length) {
            spans.push({ start: i, end: j + 1 });
            i = j + 1;
        } else {
            i++; // unbalanced — keep scanning from the next char
        }
    }
    return spans;
}

/**
 * Some models print a tool call as plain JSON instead of using native tool_calls.
 * Handles nested braces in arguments and both "arguments" and "parameters" keys.
 */
function parseJsonToolCall(text: string): { calls: OllamaToolCall[]; remaining: string } {
    const calls: OllamaToolCall[] = [];
    let remaining = text;
    const accepted: Array<{ start: number; end: number }> = [];

    for (const span of findJsonSpans(text)) {
        try {
            const call = toToolCall(JSON.parse(text.slice(span.start, span.end)));
            if (call) { calls.push(call); accepted.push(span); }
        } catch { /* not JSON */ }
    }
    for (let k = accepted.length - 1; k >= 0; k--) {
        remaining = remaining.slice(0, accepted[k].start) + remaining.slice(accepted[k].end);
    }
    remaining = remaining.replace(/```(?:json)?\s*```/gi, '').trim();
    return { calls, remaining };
}

/** Remove <tool>...</tool> blocks from text-mode output before rendering. */
function stripToolBlocks(text: string): string {
    return text.replace(/<tool>[\s\S]*?<\/tool>\s*/g, '').trim();
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globToRegExp(glob: string): RegExp {
    let re = '';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*') {
            if (glob[i + 1] === '*') {
                re += '.*';
                i++;
                if (glob[i + 1] === '/') { i++; }
            } else { re += '[^/]*'; }
        } else if (c === '?') {
            re += '[^/]';
        } else if (c === '{') {
            const end = glob.indexOf('}', i);
            if (end > i) {
                re += '(?:' + glob.slice(i + 1, end).split(',').map(escapeRe).join('|') + ')';
                i = end;
            } else { re += '\\{'; }
        } else {
            re += escapeRe(c);
        }
    }
    return new RegExp('^' + re + '$', 'i');
}

function copyRecursive(src: string, dst: string): void {
    const st = fs.statSync(src);
    if (st.isDirectory()) {
        fs.mkdirSync(dst, { recursive: true });
        for (const name of fs.readdirSync(src)) {
            copyRecursive(path.join(src, name), path.join(dst, name));
        }
    } else {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
    }
}

function isRealUserMessage(m: OllamaMessage): boolean {
    return m.role === 'user' && !String(m.content ?? '').startsWith('[TOOL RESULT:');
}

// ── Agent ─────────────────────────────────────────────────────────────────────

export type PostFn = (msg: object) => void;

export class Agent {
    private history: OllamaMessage[] = [];
    private stopRef = { stop: false };
    private postFn: PostFn = () => { /* noop until run() is called */ };
    /**
     * 'native' — use Ollama's tool-calling API (default).
     * 'text'   — model rejected native tools; fall back to <tool> XML in text.
     * Reset whenever the model changes.
     */
    private toolMode: 'native' | 'text' = 'native';
    private currentModel = '';
    private activeChild: ChildProcess | null = null;
    /** Permission kinds the user chose "don't ask again" for (this session only). */
    private sessionAllow = new Set<string>();

    constructor(
        private workspaceRoot: string,
        private readonly memory: ProjectMemory | null = null
    ) {}

    get historyLength(): number { return this.history.length; }

    reset(): void {
        this.history = [];
        this.sessionAllow.clear();
    }

    /** Forget all "don't ask again" choices. */
    resetPermissions(): void { this.sessionAllow.clear(); }

    stop(): void {
        this.stopRef.stop = true;
        if (this.activeChild) { this.killTree(this.activeChild); }
    }

    /** Full conversation history (no system message) — safe to serialize. */
    get conversationHistory(): OllamaMessage[] { return [...this.history]; }

    restoreHistory(history: OllamaMessage[]): void {
        this.history = [...history];
        logInfo(`[agent] History restored — ${this.history.length} messages`);
    }

    private lastRealUserIndex(): number {
        for (let i = this.history.length - 1; i >= 0; i--) {
            if (isRealUserMessage(this.history[i])) { return i; }
        }
        return -1;
    }

    get lastUserMessage(): string | undefined {
        const i = this.lastRealUserIndex();
        return i >= 0 ? this.history[i].content : undefined;
    }

    retryLast(): string | undefined {
        const i = this.lastRealUserIndex();
        if (i < 0) { return undefined; }
        const last = this.history[i].content;
        this.history.length = i; // drop that user message and everything after it
        return last;
    }

    // ── Main loop ─────────────────────────────────────────────────────────────

    async run(userMessage: string, model: string, post: PostFn): Promise<void> {
        this.stopRef = { stop: false };
        this.postFn  = post;
        if (this.currentModel !== model) {
            this.currentModel = model;
            this.toolMode = 'native';
        }
        this.history.push({ role: 'user', content: userMessage });
        logInfo(`Agent run — model: ${model}, mode: ${this.toolMode}, history: ${this.history.length}`);

        const cfg = getConfig();
        const baseSystemContent = cfg.systemPrompt.trim() || DEFAULT_SYSTEM_PROMPT;

        const callCounts = new Map<string, number>();
        let finished = false;

        for (let turn = 0; turn < MAX_TURNS; turn++) {
            if (this.stopRef.stop) { break; }

            const isTextMode = this.toolMode === 'text';
            const systemContent = baseSystemContent + '\n\n' + this.buildEnvironment()
                + (isTextMode ? TEXT_MODE_TOOL_INSTRUCTIONS : '');
            const tools = isTextMode ? [] : TOOL_DEFINITIONS;

            this.trimHistory();
            post({ type: 'streamStart' });

            let result: StreamResult;
            try {
                result = await streamChatRequest(
                    model,
                    [{ role: 'system', content: systemContent }, ...this.history],
                    tools,
                    (token) => post({ type: 'token', text: token }),
                    this.stopRef
                );
            } catch (err) {
                if (err instanceof ToolsNotSupportedError && this.toolMode === 'native') {
                    this.toolMode = 'text';
                    logInfo(`Model ${model} → switching to text-mode tool calling`);
                    post({ type: 'streamEnd' });
                    post({ type: 'removeLastAssistant' });
                    post({ type: 'modeSwitch', mode: 'text', model });
                    turn--; // retry this turn in text mode
                    continue;
                }
                const msg = (err as Error).message;
                logError(`Agent stream error (turn ${turn}): ${msg}`);
                post({ type: 'streamEnd' });
                post({ type: 'error', text: this.friendlyError(msg) });
                finished = true;
                break;
            }

            post({ type: 'streamEnd' });

            // ── Extract tool calls depending on mode ──────────────────────────
            let toolCalls: OllamaToolCall[];
            let displayContent: string;

            if (isTextMode) {
                toolCalls = parseTextToolCalls(result.content);
                displayContent = stripToolBlocks(result.content);
            } else {
                toolCalls = result.toolCalls ?? [];
                displayContent = result.content;

                // Fallback: model printed the tool call as JSON instead of using tool_calls.
                if (!toolCalls.length) {
                    const parsed = parseJsonToolCall(result.content);
                    if (parsed.calls.length) {
                        toolCalls = parsed.calls;
                        displayContent = parsed.remaining;
                        logInfo(`JSON tool-call fallback — ${parsed.calls.map((c) => c.function.name).join(', ')}`);
                    }
                }
            }

            // The raw tool block / JSON was already streamed into the bubble — replace it.
            // Also drop the bubble when the model only made tool calls (no text), otherwise an
            // empty "AGENT" header is left in the chat for every tool step.
            if (toolCalls.length && (displayContent !== result.content || !displayContent.trim())) {
                this.replaceLastBubble(displayContent);
            }

            // History: text mode keeps the raw <tool> block so the model sees its own format;
            // native mode stores structured tool_calls.
            this.history.push({
                role: 'assistant',
                content: isTextMode ? result.content : displayContent,
                ...(toolCalls.length && !isTextMode ? { tool_calls: toolCalls } : {}),
            });

            if (!toolCalls.length) {
                if (!result.content.trim() && !this.stopRef.stop) {
                    post({ type: 'error', text: 'The model returned an empty response. Try again, or use a larger model.' });
                }
                finished = true;
                break;
            }

            // ── Execute tool calls ────────────────────────────────────────────
            for (let i = 0; i < toolCalls.length; i++) {
                const tc = toolCalls[i];
                const name = tc.function.name;

                if (this.stopRef.stop) {
                    for (let j = i; j < toolCalls.length; j++) {
                        this.pushToolResult(isTextMode, toolCalls[j].function.name, 'Cancelled by user.');
                    }
                    break;
                }

                let args: Record<string, unknown> = {};
                try {
                    const raw = tc.function.arguments as unknown;
                    args = asArgs(raw) ?? {};
                } catch { args = {}; }

                const toolId = `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
                logInfo(`Tool [${this.toolMode}]: ${name}  args=${JSON.stringify(args).slice(0, 500)}`);
                post({ type: 'toolCall', id: toolId, name, args });

                // Guard against the model looping on the same call.
                const sig = `${name}:${JSON.stringify(args)}`;
                const count = (callCounts.get(sig) ?? 0) + 1;
                callCounts.set(sig, count);

                let toolResult: string;
                let ok = true;
                if (count > 3) {
                    ok = false;
                    toolResult = `Error: you already made this exact call ${count - 1} times. Stop repeating it — try a different approach or explain the problem to the user.`;
                } else {
                    try {
                        toolResult = await this.executeTool(name, args, toolId);
                        logInfo(`Tool ${name} OK — ${toolResult.length} chars`);
                    } catch (err) {
                        ok = false;
                        toolResult = `Error: ${(err as Error).message}`;
                        logError(`Tool ${name} failed: ${toolResult}`);
                    }
                }
                post({ type: 'toolResult', id: toolId, name, success: ok, preview: toolResult.slice(0, 400) });
                this.pushToolResult(isTextMode, name, toolResult);
            }
        }

        if (!finished && !this.stopRef.stop) {
            post({ type: 'error', text: `Stopped after ${MAX_TURNS} steps. Send "continue" to keep going.` });
        }
    }

    // ── History helpers ───────────────────────────────────────────────────────

    private pushToolResult(isTextMode: boolean, name: string, text: string): void {
        const content = text.length > MAX_TOOL_RESULT_CHARS
            ? text.slice(0, MAX_TOOL_RESULT_CHARS) + `\n…[truncated ${text.length - MAX_TOOL_RESULT_CHARS} chars]`
            : text;
        if (isTextMode) {
            this.history.push({
                role: 'user',
                content: `[TOOL RESULT: ${name}]\n${content}\n[END TOOL RESULT]`,
            });
        } else {
            this.history.push({ role: 'tool', content, tool_name: name } as OllamaMessage);
        }
    }

    /** Drop the oldest turns when the conversation gets too large (never the current request). */
    private trimHistory(): void {
        const size = () => this.history.reduce((n, m) => n + String(m.content ?? '').length, 0);
        let lastUser = this.lastRealUserIndex();
        if (lastUser < 0) { return; }

        while (size() > MAX_HISTORY_CHARS && lastUser > 0) {
            this.history.shift();
            lastUser--;
        }
        // Never start the history on an assistant/tool message.
        while (lastUser > 0 && !isRealUserMessage(this.history[0])) {
            this.history.shift();
            lastUser--;
        }
        // Still too big (one very long agent run): shrink the oldest tool results of this run.
        for (let i = lastUser + 1; i < this.history.length && size() > MAX_HISTORY_CHARS; i++) {
            const m = this.history[i];
            const text = String(m.content ?? '');
            if ((m.role === 'tool' || text.startsWith('[TOOL RESULT:')) && text.length > 2000) {
                m.content = text.slice(0, 2000) + '\n…[older output trimmed]';
            }
        }
    }

    private replaceLastBubble(text: string): void {
        this.postFn({ type: 'removeLastAssistant' });
        if (text.trim()) {
            this.postFn({ type: 'streamStart' });
            this.postFn({ type: 'token', text });
            this.postFn({ type: 'streamEnd' });
        }
    }

    // ── Environment / paths ───────────────────────────────────────────────────

    private get root(): string {
        return this.workspaceRoot || os.homedir();
    }

    private isDir(p: string): boolean {
        try { return fs.statSync(p).isDirectory(); } catch { return false; }
    }

    private knownFolder(name: 'Desktop' | 'Documents' | 'Downloads'): string | undefined {
        const home = os.homedir();
        const candidates = [
            process.env.OneDrive ? path.join(process.env.OneDrive, name) : '',
            path.join(home, 'OneDrive', name),
            path.join(home, name),
        ].filter(Boolean);
        return candidates.find((c) => this.isDir(c));
    }

    private buildEnvironment(): string {
        const shell = process.platform === 'win32'
            ? (process.env.ComSpec ?? 'cmd.exe')
            : (process.env.SHELL ?? '/bin/sh');
        const lines = [
            '═══ ENVIRONMENT ═══',
            `OS: ${process.platform} (${os.type()} ${os.release()}), shell: ${shell}`,
            `Home: ${os.homedir()}`,
            `Desktop: ${this.knownFolder('Desktop') ?? '(not found)'}`,
            `Documents: ${this.knownFolder('Documents') ?? '(not found)'}`,
            `Downloads: ${this.knownFolder('Downloads') ?? '(not found)'}`,
            `Workspace root: ${this.workspaceRoot || '(no folder open — relative paths resolve to the home folder)'}`,
            `Today: ${new Date().toDateString()}`,
            'Paths may be absolute (anywhere on this computer), "~/...", "Desktop/...", "Documents/...", "Downloads/...", or relative to the workspace root.',
            '═══════════════════',
        ];
        return lines.join('\n');
    }

    private resolvePath(input: string): string {
        let p = String(input ?? '').trim().replace(/^["']|["']$/g, '');
        if (!p) { throw new Error('path is required'); }

        // Environment variables: %VAR% and $VAR / ${VAR}
        p = p.replace(/%([^%]+)%/g, (m, v: string) => process.env[v] ?? m);
        p = p.replace(/\$(?:\{(\w+)\}|(\w+))/g, (m, a: string | undefined, b: string | undefined) => {
            const v = (a ?? b) as string;
            if (v === 'HOME') { return os.homedir(); }
            return process.env[v] ?? m;
        });

        if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
            p = path.join(os.homedir(), p.slice(1));
        }
        if (path.isAbsolute(p)) { return path.resolve(p); }

        // "Desktop/foo" → the real Desktop (unless the workspace really has such a folder)
        const parts = p.split(/[\\/]+/).filter(Boolean);
        const first = parts[0]?.toLowerCase();
        const wk = first === 'desktop' ? 'Desktop'
            : first === 'documents' ? 'Documents'
            : first === 'downloads' ? 'Downloads'
            : undefined;
        if (wk && !fs.existsSync(path.resolve(this.root, parts[0]))) {
            const folder = this.knownFolder(wk);
            if (folder) { return path.resolve(folder, ...parts.slice(1)); }
        }
        return path.resolve(this.root, p);
    }

    private isInside(parent: string, child: string): boolean {
        const rel = path.relative(parent, child);
        return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    }

    private displayPath(full: string): string {
        return this.isInside(this.root, full) ? (path.relative(this.root, full) || '.') : full;
    }

    private assertDeletable(full: string): void {
        const resolved = path.resolve(full).toLowerCase();
        const protectedPaths = [
            path.parse(full).root,
            os.homedir(),
            this.root,
            process.env.windir,
            process.env.SystemRoot,
            process.env.ProgramFiles,
            process.env['ProgramFiles(x86)'],
            this.knownFolder('Desktop'),
            this.knownFolder('Documents'),
            this.knownFolder('Downloads'),
        ].filter((x): x is string => !!x).map((x) => path.resolve(x).toLowerCase());
        if (protectedPaths.includes(resolved)) {
            throw new Error(`Refusing to delete protected location: ${full}`);
        }
    }

    // ── Permissions ───────────────────────────────────────────────────────────

    private async confirm(
        kind: string,
        message: string,
        verb: string,
        detail?: string,
        modal = true
    ): Promise<boolean> {
        if (this.sessionAllow.has(kind)) { return true; }
        const always = `${verb} — don't ask again`;
        const choice = await vscode.window.showWarningMessage(message, { modal, detail }, verb, always);
        if (choice === always) {
            this.sessionAllow.add(kind);
            return true;
        }
        return choice === verb;
    }

    /**
     * Writes inside the workspace are allowed silently (unless alwaysAsk);
     * anything outside the workspace needs approval.
     */
    private async authorize(
        tool: string,
        full: string,
        message: string,
        verb: string,
        alwaysAsk: boolean
    ): Promise<boolean> {
        const outside = !this.isInside(this.root, full);
        if (!outside && !alwaysAsk) { return true; }
        return this.confirm(
            outside ? `${tool}:outside` : tool,
            outside ? `${message}\n\n⚠ This is OUTSIDE your workspace.` : message,
            verb,
            full
        );
    }

    // ── Tool executor ─────────────────────────────────────────────────────────

    private async executeTool(
        name: string,
        args: Record<string, unknown>,
        toolId: string
    ): Promise<string> {
        switch (name) {

            case 'system_info':
                return this.buildEnvironment();

            case 'workspace_summary': {
                if (!this.workspaceRoot) {
                    return `No workspace folder is open.\n${this.buildEnvironment()}`;
                }
                return buildWorkspaceSummary(this.workspaceRoot);
            }

            case 'read_file': {
                const full = this.resolvePath(String(args.path ?? ''));
                if (!fs.existsSync(full)) { throw new Error(`File not found: ${full}`); }
                const st = fs.statSync(full);
                if (st.isDirectory()) { return this.listDir(full); }
                if (st.size > READ_MAX_BYTES) {
                    throw new Error(`File is too large (${Math.round(st.size / 1024)} KB). Use search_files or run_command to inspect it.`);
                }
                const buf = fs.readFileSync(full);
                if (buf.subarray(0, 8000).includes(0)) {
                    throw new Error(`${full} looks like a binary file; cannot read it as text.`);
                }
                const lines = buf.toString('utf8').split(/\r?\n/);
                const start = Math.max(1, Math.floor(Number(args.start_line)) || 1);
                const end = Math.min(lines.length, Math.floor(Number(args.end_line)) || lines.length);
                let body = lines.slice(start - 1, end).join('\n');
                let note = '';
                if (body.length > READ_MAX_CHARS) {
                    body = body.slice(0, READ_MAX_CHARS);
                    note = '\n…[truncated — use start_line/end_line to read the rest]';
                }
                const range = (start !== 1 || end !== lines.length) ? `, showing lines ${start}-${end}` : '';
                return `File: ${this.displayPath(full)} (${lines.length} lines${range})\n${'─'.repeat(50)}\n${body}${note}`;
            }

            case 'list_files': {
                const dir = this.resolvePath(String(args.path ?? '.'));
                if (!fs.existsSync(dir)) { throw new Error(`Directory not found: ${dir}`); }
                return this.listDir(dir);
            }

            case 'find_files': {
                const pattern = String(args.pattern ?? '').trim();
                if (!pattern) { throw new Error('pattern is required'); }
                const base = this.resolvePath(String(args.path ?? '.'));
                const re = globToRegExp(pattern);
                const matchBase = !pattern.includes('/');
                const found: string[] = [];
                let visited = 0;

                const walk = (dir: string): void => {
                    if (found.length >= FIND_MAX_RESULTS || visited > 50_000) { return; }
                    let entries: fs.Dirent[];
                    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
                    for (const e of entries) {
                        if (SKIP_DIRS.has(e.name)) { continue; }
                        visited++;
                        const full = path.join(dir, e.name);
                        const rel = path.relative(base, full).split(path.sep).join('/');
                        if (re.test(matchBase ? e.name : rel)) {
                            found.push(`${e.isDirectory() ? '📁' : '📄'} ${this.displayPath(full)}`);
                        }
                        if (e.isDirectory()) { walk(full); }
                        if (found.length >= FIND_MAX_RESULTS) { return; }
                    }
                };
                walk(base);
                return found.length
                    ? `Found ${found.length} match(es) for "${pattern}":\n${found.join('\n')}`
                    : `No files match "${pattern}" under ${base}`;
            }

            case 'search_files': {
                const query = String(args.query ?? '');
                if (!query) { throw new Error('query is required'); }
                const base = this.resolvePath(String(args.path ?? '.'));
                const isRegex = args.is_regex === true || args.is_regex === 'true';
                let matcher: RegExp;
                try {
                    matcher = new RegExp(isRegex ? query : escapeRe(query), 'i');
                } catch (e) {
                    throw new Error(`Invalid regex: ${(e as Error).message}`);
                }
                const includeRe = args.include ? globToRegExp(String(args.include)) : undefined;
                const results: string[] = [];
                let filesScanned = 0;

                const walk = (dir: string): void => {
                    if (results.length >= SEARCH_MAX_RESULTS || filesScanned >= SEARCH_MAX_FILES) { return; }
                    let entries: fs.Dirent[];
                    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
                    for (const e of entries) {
                        if (SKIP_DIRS.has(e.name)) { continue; }
                        const full = path.join(dir, e.name);
                        if (e.isDirectory()) { walk(full); continue; }
                        if (includeRe) {
                            const rel = path.relative(base, full).split(path.sep).join('/');
                            if (!includeRe.test(e.name) && !includeRe.test(rel)) { continue; }
                        }
                        try {
                            if (fs.statSync(full).size > SEARCH_MAX_FILE_BYTES) { continue; }
                            const buf = fs.readFileSync(full);
                            if (buf.subarray(0, 4000).includes(0)) { continue; }
                            filesScanned++;
                            const lines = buf.toString('utf8').split(/\r?\n/);
                            for (let i = 0; i < lines.length; i++) {
                                if (matcher.test(lines[i])) {
                                    results.push(`${this.displayPath(full)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
                                    if (results.length >= SEARCH_MAX_RESULTS) { return; }
                                }
                            }
                        } catch { /* skip unreadable */ }
                        if (results.length >= SEARCH_MAX_RESULTS) { return; }
                    }
                };
                walk(base);
                return results.length
                    ? `Results for "${query}" (${results.length}${results.length >= SEARCH_MAX_RESULTS ? '+' : ''}):\n${results.join('\n')}`
                    : `No matches found for "${query}"`;
            }

            case 'create_file': {
                const content = String(args.content ?? '');
                const full = this.resolvePath(String(args.path ?? ''));
                if (fs.existsSync(full)) {
                    throw new Error(`File already exists: ${full}. Use write_file to overwrite or edit_file to modify.`);
                }
                if (!(await this.authorize('create_file', full, `Ollama Agent wants to create the file:\n${full}`, 'Create', false))) {
                    return 'Create cancelled by user.';
                }
                fs.mkdirSync(path.dirname(full), { recursive: true });
                fs.writeFileSync(full, content, 'utf8');
                this.postFn({ type: 'fileChanged', path: this.displayPath(full), action: 'created' });
                return `Created: ${full} (${content.split('\n').length} lines)`;
            }

            case 'create_folder': {
                const full = this.resolvePath(String(args.path ?? args.name ?? ''));
                if (fs.existsSync(full)) {
                    if (this.isDir(full)) { return `Folder already exists: ${full}`; }
                    throw new Error(`A file with that name already exists: ${full}`);
                }
                if (!(await this.authorize('create_folder', full, `Ollama Agent wants to create the folder:\n${full}`, 'Create', false))) {
                    return 'Folder creation cancelled by user.';
                }
                fs.mkdirSync(full, { recursive: true });
                this.postFn({ type: 'fileChanged', path: this.displayPath(full), action: 'created' });
                return `Created folder: ${full}`;
            }

            case 'edit_file':
                return this.editFile(args);

            case 'write_file': {
                const content = String(args.content ?? '');
                const full = this.resolvePath(String(args.path ?? ''));
                const exists = fs.existsSync(full);
                if (exists && this.isDir(full)) { throw new Error(`${full} is a folder, not a file.`); }
                const lineCount = content.split('\n').length;
                const ok = await this.authorize(
                    'write_file',
                    full,
                    exists
                        ? `Ollama Agent wants to OVERWRITE:\n${full}\n(${lineCount} lines)`
                        : `Ollama Agent wants to create:\n${full}\n(${lineCount} lines)`,
                    exists ? 'Overwrite' : 'Write',
                    exists
                );
                if (!ok) { return 'Write cancelled by user.'; }
                fs.mkdirSync(path.dirname(full), { recursive: true });
                fs.writeFileSync(full, content, 'utf8');
                this.postFn({ type: 'fileChanged', path: this.displayPath(full), action: exists ? 'written' : 'created' });
                return `${exists ? 'Overwrote' : 'Created'}: ${full} (${lineCount} lines)`;
            }

            case 'append_to_file': {
                const content = String(args.content ?? '');
                const full = this.resolvePath(String(args.path ?? ''));
                if (!fs.existsSync(full)) {
                    throw new Error(`File not found: ${full}. Use create_file instead.`);
                }
                if (!(await this.authorize('append_to_file', full, `Ollama Agent wants to append to:\n${full}`, 'Append', false))) {
                    return 'Append cancelled by user.';
                }
                fs.appendFileSync(full, content, 'utf8');
                this.postFn({ type: 'fileChanged', path: this.displayPath(full), action: 'appended' });
                return `Appended ${content.length} chars to ${full}`;
            }

            case 'rename_file': {
                const oldFull = this.resolvePath(String(args.old_path ?? ''));
                const newFull = this.resolvePath(String(args.new_path ?? ''));
                if (!fs.existsSync(oldFull)) { throw new Error(`Not found: ${oldFull}`); }
                if (fs.existsSync(newFull)) { throw new Error(`Destination already exists: ${newFull}`); }
                const checkPath = !this.isInside(this.root, newFull) ? newFull : oldFull;
                if (!(await this.authorize('rename_file', checkPath, `Ollama Agent wants to move/rename:\n${oldFull}\n→ ${newFull}`, 'Rename', true))) {
                    return 'Rename cancelled by user.';
                }
                fs.mkdirSync(path.dirname(newFull), { recursive: true });
                try {
                    fs.renameSync(oldFull, newFull);
                } catch (err) {
                    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') { throw err; }
                    copyRecursive(oldFull, newFull); // different drives
                    fs.rmSync(oldFull, { recursive: true, force: true });
                }
                this.postFn({ type: 'fileChanged', path: this.displayPath(newFull), action: 'renamed' });
                return `Moved: ${oldFull} → ${newFull}`;
            }

            case 'copy_file': {
                const src = this.resolvePath(String(args.source ?? ''));
                const dst = this.resolvePath(String(args.destination ?? ''));
                if (!fs.existsSync(src)) { throw new Error(`Not found: ${src}`); }
                if (fs.existsSync(dst)) { throw new Error(`Destination already exists: ${dst}`); }
                if (!(await this.authorize('copy_file', dst, `Ollama Agent wants to copy:\n${src}\n→ ${dst}`, 'Copy', false))) {
                    return 'Copy cancelled by user.';
                }
                copyRecursive(src, dst);
                this.postFn({ type: 'fileChanged', path: this.displayPath(dst), action: 'created' });
                return `Copied: ${src} → ${dst}`;
            }

            case 'delete_file': {
                const full = this.resolvePath(String(args.path ?? ''));
                if (!fs.existsSync(full)) { throw new Error(`Not found: ${full}`); }
                this.assertDeletable(full);
                const isDir = this.isDir(full);
                const ok = await this.authorize(
                    'delete_file',
                    full,
                    `Ollama Agent wants to DELETE ${isDir ? 'the folder (and everything in it)' : 'the file'}:\n${full}\n\nThis cannot be undone.`,
                    'Delete',
                    true
                );
                if (!ok) { return 'Delete cancelled by user.'; }
                fs.rmSync(full, { recursive: true, force: false });
                this.postFn({ type: 'fileChanged', path: this.displayPath(full), action: 'deleted' });
                return `Deleted ${isDir ? 'folder' : 'file'}: ${full}`;
            }

            case 'run_command': {
                const cmd = String(args.command ?? '').trim();
                if (!cmd) { throw new Error('command is required'); }

                const DANGEROUS = [
                    /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)[a-z]*\s+(\/|~|\*)(\s|$)/i,
                    /\bmkfs\b/i, /\bdd\s+if=/i, /:\(\)\s*\{.*\}/,
                    /\bformat\s+[a-z]:/i,
                    /\b(rd|rmdir)\s+\/s\s+(\/q\s+)?[a-z]:\\?(\s|$)/i,
                    /\bdel\s+(\/[a-z]\s+)*[a-z]:\\\*?(\s|$)/i,
                    /Remove-Item\b.*-Recurse.*\s[a-z]:\\?(\s|$)/i,
                ];
                for (const pattern of DANGEROUS) {
                    if (pattern.test(cmd)) {
                        throw new Error(`Blocked: command matches dangerous pattern (${pattern.toString()})`);
                    }
                }

                const cwd = args.cwd ? this.resolvePath(String(args.cwd)) : this.root;
                if (!this.isDir(cwd)) { throw new Error(`Working directory not found: ${cwd}`); }
                const timeoutS = Math.min(
                    COMMAND_MAX_TIMEOUT_S,
                    Math.max(1, Math.floor(Number(args.timeout_seconds)) || COMMAND_DEFAULT_TIMEOUT_S)
                );

                const ok = await this.confirm(
                    'run_command',
                    `Ollama Agent wants to run:\n${cmd}`,
                    'Run',
                    `Folder: ${cwd}`
                );
                if (!ok) { return 'Command cancelled by user.'; }
                return this.runCommandStreaming(cmd, cwd, toolId, timeoutS * 1000);
            }

            case 'get_diagnostics': {
                const filter = args.path ? this.resolvePath(String(args.path)).toLowerCase() : '';
                const sev = ['Error', 'Warning', 'Info', 'Hint'];
                const lines: string[] = [];
                outer:
                for (const [uri, diags] of vscode.languages.getDiagnostics()) {
                    if (uri.scheme !== 'file') { continue; }
                    if (filter && uri.fsPath.toLowerCase() !== filter) { continue; }
                    for (const d of diags) {
                        if (d.severity > vscode.DiagnosticSeverity.Warning) { continue; }
                        lines.push(
                            `${this.displayPath(uri.fsPath)}:${d.range.start.line + 1}:${d.range.start.character + 1} ` +
                            `[${sev[d.severity]}] ${d.message.split('\n')[0]}`
                        );
                        if (lines.length >= 100) { break outer; }
                    }
                }
                return lines.length ? `Problems (${lines.length}):\n${lines.join('\n')}` : 'No errors or warnings reported by VS Code.';
            }

            case 'memory_list': {
                if (!this.memory) { return '(project memory not available in this session)'; }
                return `Project memory notes:\n\n${this.memory.formatAll()}`;
            }

            case 'memory_write': {
                if (!this.memory) { return '(project memory not available in this session)'; }
                const content = String(args.content ?? '');
                const tag = args.tag ? String(args.tag) : undefined;
                if (!content.trim()) { throw new Error('content is required'); }
                const note = this.memory.add(content, tag);
                return `Note saved (id: ${note.id}). Use memory_list to view all notes.`;
            }

            case 'memory_delete': {
                if (!this.memory) { return '(project memory not available in this session)'; }
                const id = String(args.id ?? '');
                if (!id) { throw new Error('id is required'); }
                const ok = this.memory.delete(id);
                return ok ? `Deleted note ${id}.` : `Note ${id} not found. Use memory_list to see current notes.`;
            }

            default:
                throw new Error(`Unknown tool: "${name}". Available tools: ${[...TOOL_NAMES].join(', ')}`);
        }
    }

    // ── Tool helpers ──────────────────────────────────────────────────────────

    private listDir(dir: string): string {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        const lines = entries
            .filter((e) => !SKIP_DIRS.has(e.name))
            .sort((a, b) => {
                if (a.isDirectory() !== b.isDirectory()) { return a.isDirectory() ? -1 : 1; }
                return a.name.localeCompare(b.name);
            })
            .map((e) => `${e.isDirectory() ? '📁' : '📄'} ${e.name}`)
            .join('\n');
        return `${dir}:\n${lines || '(empty)'}`;
    }

    private async editFile(args: Record<string, unknown>): Promise<string> {
        const oldRaw = String(args.old_string ?? '');
        const newRaw = String(args.new_string ?? '');
        const replaceAll = args.replace_all === true || args.replace_all === 'true';
        if (!oldRaw) { throw new Error('old_string is required'); }
        if (oldRaw === newRaw) { throw new Error('old_string and new_string are identical — nothing to change.'); }

        const full = this.resolvePath(String(args.path ?? ''));
        if (!fs.existsSync(full)) { throw new Error(`File not found: ${full}`); }
        if (this.isDir(full)) { throw new Error(`${full} is a folder, not a file.`); }

        const original = fs.readFileSync(full, 'utf8');
        // Windows files use CRLF while the model almost always sends LF — normalise, then restore.
        const usesCRLF = original.includes('\r\n');
        const norm = (s: string) => s.replace(/\r\n/g, '\n');
        const text = norm(original);
        const oldStr = norm(oldRaw);
        const newStr = norm(newRaw);
        const rel = this.displayPath(full);

        const occurrences = text.split(oldStr).length - 1;
        if (occurrences === 0) {
            const firstLine = oldStr.split('\n')[0].trim();
            const near = text.split('\n').findIndex((l) => l.trim() === firstLine);
            const hint = near >= 0
                ? ` The first line was found at line ${near + 1} but the full block didn't match — check indentation/whitespace.`
                : ' The first line of old_string was not found in the file.';
            throw new Error(`edit_file: old_string not found in ${rel}.${hint} Re-read the file and try again.`);
        }
        if (occurrences > 1 && !replaceAll) {
            throw new Error(
                `edit_file: old_string matches ${occurrences} places in ${rel}. ` +
                `Add more surrounding context to make it unique, or set replace_all to true.`
            );
        }

        // split/join instead of String.replace so "$&" etc. in new_string stay literal.
        let updated = replaceAll
            ? text.split(oldStr).join(newStr)
            : text.slice(0, text.indexOf(oldStr)) + newStr + text.slice(text.indexOf(oldStr) + oldStr.length);
        if (usesCRLF) { updated = updated.replace(/\n/g, '\r\n'); }

        const outside = !this.isInside(this.root, full);
        const kind = outside ? 'edit_file:outside' : 'edit_file';
        const summary = `${oldStr.split('\n').length} line(s) → ${newStr.split('\n').length} line(s)` +
            (replaceAll && occurrences > 1 ? `, ${occurrences} occurrences` : '');

        if (!this.sessionAllow.has(kind)) {
            // Show a diff, then ask (non-modal so the diff stays readable).
            const tmpPath = path.join(os.tmpdir(), `ollama-edit-${Date.now()}${path.extname(full)}`);
            const title = `Ollama Agent — Edit: ${path.basename(full)}`;
            fs.writeFileSync(tmpPath, updated, 'utf8');
            try {
                await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(full), vscode.Uri.file(tmpPath), title);
            } catch { /* diff view is optional */ }

            const ok = await this.confirm(
                kind,
                `Apply edit to "${rel}"? (${summary})${outside ? ' — OUTSIDE workspace' : ''}`,
                'Apply',
                undefined,
                false
            );

            await this.closeDiffTab(title);
            try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
            if (!ok) { return 'Edit cancelled by user.'; }
        }

        fs.writeFileSync(full, updated, 'utf8');
        this.postFn({ type: 'fileChanged', path: rel, action: 'edited' });
        return `Edited: ${rel} — ${summary}`;
    }

    private async closeDiffTab(title: string): Promise<void> {
        try {
            for (const group of vscode.window.tabGroups.all) {
                for (const tab of group.tabs) {
                    if (tab.input instanceof vscode.TabInputTextDiff && tab.label === title) {
                        await vscode.window.tabGroups.close(tab);
                    }
                }
            }
        } catch { /* ignore */ }
    }

    // ── Streaming command execution ───────────────────────────────────────────

    private killTree(child: ChildProcess): void {
        if (!child.pid) { return; }
        try {
            if (process.platform === 'win32') {
                spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
            } else {
                process.kill(-child.pid, 'SIGKILL');
            }
        } catch {
            try { child.kill(); } catch { /* ignore */ }
        }
    }

    private runCommandStreaming(cmd: string, cwd: string, cmdId: string, timeoutMs: number): Promise<string> {
        return new Promise((resolve) => {
            const post = this.postFn;
            post({ type: 'commandStart', id: cmdId, cmd });

            let output = '';
            let streamed = 0;
            let done = false;
            let timer: NodeJS.Timeout | undefined;
            const STREAM_LIMIT = 20_000;

            const finish = (code: number | null, note = '') => {
                if (done) { return; }
                done = true;
                if (timer) { clearTimeout(timer); }
                this.activeChild = null;
                const exitCode = code ?? -1;
                post({ type: 'commandEnd', id: cmdId, exitCode });
                logInfo(`Command exited ${exitCode}: ${cmd}`);
                let text = output;
                if (text.length > COMMAND_RESULT_LIMIT) {
                    const half = COMMAND_RESULT_LIMIT / 2;
                    text = text.slice(0, half) + '\n…[output truncated]…\n' + text.slice(-half);
                }
                resolve(`Exit code: ${exitCode}${note}\n${text || '(no output)'}`);
            };

            let child: ChildProcess;
            try {
                child = spawn(cmd, {
                    cwd,
                    shell: true,                       // cmd.exe on Windows, /bin/sh elsewhere
                    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
                    stdio: ['ignore', 'pipe', 'pipe'], // no stdin → interactive prompts fail fast instead of hanging
                    windowsHide: true,
                    detached: process.platform !== 'win32',
                });
            } catch (err) {
                post({ type: 'commandChunk', id: cmdId, text: `Error: ${(err as Error).message}`, stream: 'stderr' });
                output = `Error: ${(err as Error).message}`;
                finish(-1);
                return;
            }
            this.activeChild = child;

            const onData = (stream: 'stdout' | 'stderr') => (data: Buffer) => {
                const text = data.toString();
                if (output.length < 200_000) { output += text; }
                if (streamed < STREAM_LIMIT) {
                    streamed += text.length;
                    post({ type: 'commandChunk', id: cmdId, text, stream });
                }
            };
            child.stdout?.on('data', onData('stdout'));
            child.stderr?.on('data', onData('stderr'));

            child.on('close', (code) => finish(code, this.stopRef.stop ? ' (stopped by user)' : ''));
            child.on('error', (err) => {
                output += `\nError: ${err.message}`;
                post({ type: 'commandChunk', id: cmdId, text: `\nError: ${err.message}`, stream: 'stderr' });
                finish(-1);
            });

            timer = setTimeout(() => {
                this.killTree(child);
                const msg = `\n(timed out after ${Math.round(timeoutMs / 1000)}s and was killed)`;
                post({ type: 'commandChunk', id: cmdId, text: msg, stream: 'stderr' });
                output += msg;
                finish(-1, ' (timed out)');
            }, timeoutMs);
        });
    }

    // ── Utilities ─────────────────────────────────────────────────────────────

    private friendlyError(raw: string): string {
        if (raw.includes('ECONNREFUSED')) { return 'Ollama is not running. Run: ollama serve'; }
        if (raw.includes('timed out'))    { return 'Request timed out. The model may be loading or overloaded.'; }
        if (raw.includes('404'))          { return 'Model not found. Run: ollama pull <model-name>'; }
        return raw;
    }
}