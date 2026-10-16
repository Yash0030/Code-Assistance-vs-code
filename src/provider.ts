import * as vscode from 'vscode';
import { Agent, PostFn } from './agent';
import { fetchModels, rawGet, streamChatRequest } from './ollamaClient';
import { getConfig } from './config';
import { getActiveContext, buildContextString } from './context';
import { logInfo, logError, channel } from './logger';
import { ChatStorage, ChatSession, StoredMessage, deriveTitle, relativeTime } from './chatStorage';
import { indexWorkspaceFiles, fuzzySearchFiles, buildMentionContext } from './mentions';
import { buildGitDiffContext } from './gitContext';
import { ProjectMemory } from './projectMemory';

// ── Message shapes (webview → extension) ─────────────────────────────────────

interface MsgGetModels     { command: 'getModels' }
interface MsgSendMessage   { command: 'sendMessage'; text: string; model: string; includeFile: boolean; includeSelection: boolean; mentionedFiles?: string[]; }
interface MsgNewChat       { command: 'newChat' }
interface MsgStopGen       { command: 'stopGeneration' }
interface MsgRetryLast     { command: 'retryLast'; model: string }
interface MsgGetContext    { command: 'getContext' }
interface MsgListSessions  { command: 'listSessions' }
interface MsgLoadSession   { command: 'loadSession';   id: string }
interface MsgDeleteSession { command: 'deleteSession'; id: string }
interface MsgClearSessions { command: 'clearAllSessions' }
interface MsgSearchFiles   { command: 'searchFiles'; query: string }

type WebviewMsg =
    | MsgGetModels | MsgSendMessage  | MsgNewChat      | MsgStopGen
    | MsgRetryLast | MsgGetContext   | MsgListSessions  | MsgLoadSession
    | MsgDeleteSession | MsgClearSessions | MsgSearchFiles;

// ── Serialised session summary sent to the webview ───────────────────────────

interface SessionSummary {
    id: string;
    title: string;
    model: string;
    messageCount: number;
    updatedAt: number;
    relativeTime: string;
}

function toSummary(s: ChatSession): SessionSummary {
    return {
        id:           s.id,
        title:        s.title,
        model:        s.model,
        messageCount: s.messages.length,
        updatedAt:    s.updatedAt,
        relativeTime: relativeTime(s.updatedAt),
    };
}

// ── Provider ──────────────────────────────────────────────────────────────────

export class OllamaAgentProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _agent?: Agent;
    private _editorListener?: vscode.Disposable;

    private readonly storage: ChatStorage;
    private readonly memory: ProjectMemory;
    private currentSession: ChatSession;
    /** Cached workspace file index for @mention autocomplete. Rebuilt on new workspace. */
    private _fileIndex: ReturnType<typeof indexWorkspaceFiles> = [];
    private _fileIndexRoot = '';

    constructor(private readonly context: vscode.ExtensionContext) {
        this.storage = new ChatStorage(context);
        this.memory  = new ProjectMemory(context);
        // Bootstrap: restore the last session or start fresh
        const sessions = this.storage.list();
        this.currentSession = sessions[0] ?? this.storage.createNew(getConfig().model);
        logInfo(`[provider] Loaded session "${this.currentSession.title}" (${this.currentSession.messages.length} msgs)`);
    }

    async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
        this._view = webviewView;

        const workspaceRoot = this.getWorkspaceRoot();
        this._agent = new Agent(workspaceRoot, this.memory);

        // Build file index for @mention autocomplete (async, non-blocking)
        if (workspaceRoot) {
            setTimeout(() => {
                try {
                    this._fileIndex = indexWorkspaceFiles(workspaceRoot);
                    this._fileIndexRoot = workspaceRoot;
                }
                catch { /* best-effort */ }
            }, 500);
        }

        // Restore agent conversation history from the loaded session
        if (this.currentSession.agentHistory.length) {
            this._agent.restoreHistory(this.currentSession.agentHistory);
        }

        webviewView.webview.options = { enableScripts: true };

        const post = (m: object) => webviewView.webview.postMessage(m);

        webviewView.webview.onDidReceiveMessage(async (raw: WebviewMsg) => {
            logInfo(`[webview→ext] ${raw.command}`);

            switch (raw.command) {

                // ── Model discovery ───────────────────────────────────────
                case 'getModels': {
                    const models = await fetchModels();
                    post({ type: 'models', models, connected: models.length > 0 });
                    break;
                }

                // ── Send a message ────────────────────────────────────────
                case 'sendMessage': {
                    const text  = raw.text?.trim() ?? '';
                    const model = raw.model ?? getConfig().model;
                    if (!text) { break; }
                    const workspaceRoot = this.getWorkspaceRoot();
                    this._agent?.setWorkspaceRoot(workspaceRoot);
                    this.refreshFileIndex(workspaceRoot);

                    logInfo(`[user] ${text.slice(0, 120)}${text.length > 120 ? '…' : ''}`);

                    // Record user message (display text only, no injected context)
                    this.appendToSession({ role: 'user', content: text, timestamp: Date.now() });
                    // Propagate model if it changed
                    this.currentSession.model = model;

                    // Build context string for the model
                    const ctx = buildContextString(raw.includeFile, raw.includeSelection);

                    // Resolve @mentioned files (deduplicate against auto-attached file)
                    const autoAttachedFile = raw.includeFile
                        ? vscode.workspace.asRelativePath(vscode.window.activeTextEditor?.document.uri ?? vscode.Uri.parse(''), false)
                        : '';
                    const mentionCtx = raw.mentionedFiles?.length
                        ? buildMentionContext(raw.mentionedFiles, workspaceRoot, new Set([autoAttachedFile]))
                        : '';

                    // Optionally inject git diff context
                    const cfg = getConfig();
                    const gitCtx = cfg.injectGitDiff && workspaceRoot
                        ? await buildGitDiffContext(workspaceRoot)
                        : '';

                    const fullMessage = ctx || mentionCtx || gitCtx
                        ? `${text}${ctx}${mentionCtx}${gitCtx}`
                        : text;

                    // Wrap post() to capture streamed tokens → save assistant message
                    const trackedPost = this.makeTrackedPost(post, true);

                    await this._agent!.run(fullMessage, model, trackedPost);
                    // Sync agent history into session after run completes
                    this.currentSession.agentHistory = this._agent!.conversationHistory;
                    this.persistSession();
                    break;
                }

                // ── New chat ──────────────────────────────────────────────
                case 'newChat': {
                    this.startNewSession(raw as unknown as { model?: string });
                    post({ type: 'clearChat' });
                    logInfo('[provider] New chat started');
                    break;
                }

                // ── Stop generation ───────────────────────────────────────
                case 'stopGeneration': {
                    this._agent!.stop();
                    post({ type: 'streamEnd' });
                    logInfo('[provider] Generation stopped');
                    break;
                }

                // ── Retry last ────────────────────────────────────────────
                case 'retryLast': {
                    const model   = raw.model ?? getConfig().model;
                    this._agent?.setWorkspaceRoot(this.getWorkspaceRoot());
                    const lastMsg = this._agent!.retryLast();
                    if (!lastMsg) { break; }
                    // Remove the last assistant + error messages from session
                    this.trimSessionToLastUser();
                    post({ type: 'removeLastAssistant' });
                    logInfo('[provider] Retrying last message…');

                    const retryPost = this.makeTrackedPost(post, true);

                    await this._agent!.run(lastMsg, model, retryPost);
                    this.currentSession.agentHistory = this._agent!.conversationHistory;
                    this.persistSession();
                    break;
                }

                // ── Context ───────────────────────────────────────────────
                case 'getContext': {
                    post({ type: 'contextUpdate', ...getActiveContext() });
                    break;
                }

                // ── Session management ────────────────────────────────────
                case 'listSessions': {
                    const summaries = this.storage.list().map(toSummary);
                    post({ type: 'sessionList', sessions: summaries, currentId: this.currentSession.id });
                    break;
                }

                case 'loadSession': {
                    const session = this.storage.get(raw.id);
                    if (!session) {
                        post({ type: 'error', text: `Session not found: ${raw.id}` });
                        break;
                    }
                    this.currentSession = session;
                    // Rebuild agent with the saved history
                    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
                    this._agent = new Agent(root, this.memory);
                    if (session.agentHistory.length) {
                        this._agent.restoreHistory(session.agentHistory);
                    }
                    logInfo(`[provider] Loaded session "${session.title}"`);
                    post({
                        type: 'sessionLoaded',
                        session: toSummary(session),
                        messages: session.messages,
                    });
                    break;
                }

                case 'deleteSession': {
                    this.storage.delete(raw.id);
                    // If we just deleted the active session, start a new one
                    if (raw.id === this.currentSession.id) {
                        this.startNewSession({});
                        post({ type: 'clearChat' });
                    }
                    post({ type: 'sessionList', sessions: this.storage.list().map(toSummary), currentId: this.currentSession.id });
                    break;
                }

                case 'clearAllSessions': {
                    this.storage.clearAll();
                    this.startNewSession({});
                    post({ type: 'clearChat' });
                    post({ type: 'sessionList', sessions: [], currentId: this.currentSession.id });
                    logInfo('[provider] All sessions cleared');
                    break;
                }

                // ── @mention file search ──────────────────────────────────
                case 'searchFiles': {
                    const q = (raw as MsgSearchFiles).query ?? '';
                    const matches = fuzzySearchFiles(this._fileIndex, q, 12);
                    post({ type: 'fileSearchResults', query: q, files: matches.map((f) => ({ rel: f.rel, display: f.display, ext: f.ext })) });
                    break;
                }
            }
        });

        // Push context updates when the active editor / selection changes
        this._editorListener?.dispose();
        this._editorListener = vscode.window.onDidChangeActiveTextEditor(() => {
            if (webviewView.visible) {
                post({ type: 'contextUpdate', ...getActiveContext() });
            }
        });
        this.context.subscriptions.push(
            vscode.window.onDidChangeTextEditorSelection(() => {
                if (webviewView.visible) {
                    post({ type: 'contextUpdate', ...getActiveContext() });
                }
            })
        );

        try {
            webviewView.webview.html = await this.buildHtml();
            logInfo('[provider] Webview HTML loaded');

            // Restore the current session into the freshly-loaded webview
            if (this.currentSession.messages.length) {
                setTimeout(() => {
                    post({
                        type: 'sessionLoaded',
                        session: toSummary(this.currentSession),
                        messages: this.currentSession.messages,
                    });
                }, 300); // small delay so the webview JS has time to initialise
            }
        } catch (err) {
            logError(`[provider] Failed to build webview: ${(err as Error).message}`);
        }
    }

    /** Called from the `ollamaAgent.newChat` command. */
    newChat(): void {
        this.startNewSession({});
        this._view?.webview.postMessage({ type: 'clearChat' });
    }

    dispose(): void {
        this._editorListener?.dispose();
    }

    // ── Session helpers ───────────────────────────────────────────────────────

    private startNewSession(opts: { model?: string }): void {
        const model = opts.model ?? getConfig().model;
        this.currentSession = this.storage.createNew(model);
        const root = this.getWorkspaceRoot();
        this._agent = new Agent(root, this.memory);
        // Re-index files for the new session (workspace may have changed)
        if (root && !this._fileIndex.length) {
            try { this._fileIndex = indexWorkspaceFiles(root); } catch { /* best-effort */ }
        }
        logInfo(`[provider] New session: ${this.currentSession.id}`);
    }

    private getWorkspaceRoot(): string {
        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    }

    private refreshFileIndex(root: string): void {
        if (root === this._fileIndexRoot) { return; }
        this._fileIndexRoot = root;
        this._fileIndex = root ? indexWorkspaceFiles(root) : [];
        logInfo(`[provider] File index refreshed for workspace: ${root || '(none)'}`);
    }

    private appendToSession(msg: StoredMessage): void {
        this.currentSession.messages.push(msg);
        // Update title once we have the first user message
        if (this.currentSession.title === 'New Chat') {
            this.currentSession.title = deriveTitle(this.currentSession.messages);
        }
    }

    private trimSessionToLastUser(): void {
        // Remove everything after (and including) the last non-user message
        while (
            this.currentSession.messages.length > 0 &&
            this.currentSession.messages[this.currentSession.messages.length - 1].role !== 'user'
        ) {
            this.currentSession.messages.pop();
        }
    }

    /**
     * Wraps the webview `post` so streamed tokens are saved into the chat session.
     * Also honours `removeLastAssistant`: when the agent replaces a bubble (e.g. it streamed raw
     * tool-call JSON and then swapped in clean text) the stored copy is dropped too, so reloading
     * the session never shows the raw JSON.
     */
    private makeTrackedPost(post: (m: object) => unknown, saveErrors: boolean): PostFn {
        let buf = '';
        let lastSavedIndex = -1;
        return (m: object) => {
            post(m);
            const pm = m as { type: string; text?: string };
            switch (pm.type) {
                case 'streamStart':
                    buf = '';
                    lastSavedIndex = -1;
                    break;
                case 'token':
                    buf += pm.text ?? '';
                    break;
                case 'streamEnd': {
                    if (buf.trim()) {
                        const clean = buf
                            .replace(/<tool>[\s\S]*?<\/tool>\s*/g, '')
                            .replace(/<mention[\s\S]*?<\/mention>\s*/g, '')
                            .replace(/<git-diff[\s\S]*?<\/git-diff>\s*/g, '')
                            .trim();
                        this.appendToSession({ role: 'assistant', content: clean, timestamp: Date.now() });
                        lastSavedIndex = this.currentSession.messages.length - 1;
                        logInfo(`[assistant] ${clean.slice(0, 120)}${clean.length > 120 ? '…' : ''}`);
                    }
                    buf = '';
                    this.persistSession();
                    break;
                }
                case 'removeLastAssistant': {
                    const msgs = this.currentSession.messages;
                    if (lastSavedIndex >= 0 && lastSavedIndex === msgs.length - 1 && msgs[lastSavedIndex].role === 'assistant') {
                        msgs.pop();
                    }
                    lastSavedIndex = -1;
                    break;
                }
                case 'error':
                    if (saveErrors) {
                        const errText = (m as { type: string; text: string }).text;
                        this.appendToSession({ role: 'error', content: errText, timestamp: Date.now() });
                        this.persistSession();
                    }
                    break;
            }
        };
    }

    private persistSession(): void {
        this.storage.upsert(this.currentSession);
        this._view?.webview.postMessage({
            type: 'sessionSaved',
            session: toSummary(this.currentSession),
        });
    }

    // ── HTML builder ──────────────────────────────────────────────────────────

    private async buildHtml(): Promise<string> {
        const read = async (rel: string): Promise<string> => {
            const uri = vscode.Uri.joinPath(this.context.extensionUri, rel);
            return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
        };

        // Load vendor bundle — gracefully degrade if missing (first build before vendor step)
        let hljs = '';
        try { hljs = await read('webview/vendor/highlight.bundle.js'); }
        catch { logInfo('[provider] highlight.bundle.js not found — syntax highlighting disabled'); }

        const [html, js] = await Promise.all([
            read('webview/webview.html'),
            read('webview/webview.js'),
        ]);

        const nonce = Array.from({ length: 32 }, () =>
            'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
                .charAt(Math.floor(Math.random() * 62))
        ).join('');

        return html
            .replace(/\{\{nonce\}\}/g, nonce)
            .replace('{{inlineHljs}}', () => hljs)
            .replace('{{inlineScript}}', () => js);
    }
}

// ── Diagnostics ───────────────────────────────────────────────────────────────

export async function runDiagnostics(): Promise<void> {
    channel.show(false);
    logInfo('━━━━━  DIAGNOSTICS  ━━━━━');
    logInfo(`Platform: ${process.platform}  Node: ${process.version}`);
    logInfo(`HTTP_PROXY: ${process.env.HTTP_PROXY ?? process.env.http_proxy ?? '(none)'}`);
    logInfo(`Extension storage: ${vscode.Uri.joinPath(vscode.extensions.getExtension('local-dev.ollama-agent')?.extensionUri ?? vscode.Uri.parse(''), '').fsPath}`);

    try {
        const { status, body } = await rawGet('/', 3000);
        logInfo(`Ollama root → HTTP ${status}: ${body.trim()}`);
    } catch (e) {
        logError(`Ollama unreachable: ${(e as Error).message}`);
    }

    const models = await fetchModels();
    logInfo(`Available models: ${models.join(', ') || '(none)'}`);

    if (models.length) {
        let toks = 0;
        try {
            await streamChatRequest(
                models[0],
                [{ role: 'user', content: 'Say ok.' }],
                [],
                () => toks++,
                { stop: false }
            );
            logInfo(`Stream test OK — ${toks} tokens from ${models[0]}`);
        } catch (e) {
            logError(`Stream test failed: ${(e as Error).message}`);
        }
    }

    logInfo('━━━━━  END  ━━━━━');
    vscode.window.showInformationMessage('Diagnostics done — check Output › Ollama Agent');
}