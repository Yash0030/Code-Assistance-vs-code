// @ts-check
'use strict';

const vscode = acquireVsCodeApi();

// ── DOM refs ──────────────────────────────────────────────────────────────────
const messagesEl       = /** @type {HTMLDivElement}     */ (document.getElementById('messages'));
const welcomeEl        = /** @type {HTMLDivElement}     */ (document.getElementById('welcome'));
const promptEl         = /** @type {HTMLTextAreaElement} */ (document.getElementById('prompt'));
const sendBtn          = /** @type {HTMLButtonElement}  */ (document.getElementById('send-btn'));
const stopBtn          = /** @type {HTMLButtonElement}  */ (document.getElementById('stop-btn'));
const newChatBtn       = /** @type {HTMLButtonElement}  */ (document.getElementById('new-chat-btn'));
const modelSelect      = /** @type {HTMLSelectElement}  */ (document.getElementById('model-select'));
const statusDot        = /** @type {HTMLSpanElement}    */ (document.getElementById('status-dot'));
const statusText       = /** @type {HTMLSpanElement}    */ (document.getElementById('status-text'));
const agentStatus      = /** @type {HTMLDivElement}     */ (document.getElementById('agent-status'));
const agentStatusText  = /** @type {HTMLSpanElement}    */ (document.getElementById('agent-status-text'));
const scrollBtn        = /** @type {HTMLButtonElement}  */ (document.getElementById('scroll-btn'));
const contextBar       = /** @type {HTMLDivElement}     */ (document.getElementById('context-bar'));
const historyBtn       = /** @type {HTMLButtonElement}  */ (document.getElementById('history-btn'));
const historyPanel     = /** @type {HTMLDivElement}     */ (document.getElementById('history-panel'));
const historyList      = /** @type {HTMLDivElement}     */ (document.getElementById('history-list'));
const historyCloseBtn  = /** @type {HTMLButtonElement}  */ (document.getElementById('history-close-btn'));
const historyClearBtn  = /** @type {HTMLButtonElement}  */ (document.getElementById('history-clear-btn'));
const mentionDropdown  = /** @type {HTMLDivElement}     */ (document.getElementById('mention-dropdown'));
const tokenIndicator   = /** @type {HTMLSpanElement}    */ (document.getElementById('token-indicator'));

// ── State ─────────────────────────────────────────────────────────────────────

/** @type {HTMLDivElement | null} */
let currentMsgEl = null;
/** @type {string} */
let currentRaw = '';
let streaming = false;
/** True when the user has manually scrolled away from the bottom. */
let userScrolledUp = false;

/** Context state received from the extension. */
const ctx = {
    /** @type {string | null} */
    file: null,
    fileLines: 0,
    language: '',
    selectionLines: 0,
    includeFile: false,
    includeSelection: true,
};

// ── @mention state ────────────────────────────────────────────────────────────

/** Files the user has explicitly mentioned via @. [{rel, display, ext}] */
/** @type {Array<{rel: string, display: string, ext: string}>} */
let mentionedFiles = [];
/** Position in textarea where the current @ query started (-1 = not active). */
let mentionAtStart = -1;
/** Current autocomplete query (text after @). */
let mentionQuery = '';
/** Currently highlighted dropdown item index. */
let mentionSelectedIdx = 0;
/** File results from the last searchFiles response. */
/** @type {Array<{rel: string, display: string, ext: string}>} */
let mentionResults = [];

// ── Token estimation state ────────────────────────────────────────────────────

/** Approximate context window sizes (tokens) for known model families. */
const MODEL_CONTEXT_WINDOWS = {
    'llama2':           4096,
    'llama3':           8192,
    'llama3.1':         8192,
    'llama3.2':         8192,
    'llama3.3':         8192,
    'qwen2.5':          8192,
    'qwen2.5-coder':   32768,
    'qwen3':           32768,
    'phi3':             4096,
    'phi3.5':           8192,
    'phi4':            16384,
    'codellama':       16384,
    'mistral':          8192,
    'mixtral':         32768,
    'gemma2':           8192,
    'deepseek-coder':  16384,
    'deepseek-r1':     32768,
    'starcoder2':      16384,
    'granite-code':     8192,
};

/** Estimate token count using the 4-chars-per-token heuristic. */
function estimateTokens(text) {
    return Math.ceil(text.length / 4);
}

/** Find the approximate context window for the selected model. */
function getContextWindow() {
    const model = modelSelect.value.toLowerCase();
    for (const [prefix, size] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
        if (model.startsWith(prefix)) { return size; }
    }
    return 8192; // safe default
}

/** Update the token indicator in the footer. */
function updateTokenIndicator() {
    if (!tokenIndicator) { return; }
    const promptText = promptEl.value;
    if (!promptText.trim()) {
        tokenIndicator.textContent = '';
        tokenIndicator.className = '';
        return;
    }

    // Estimate: prompt + any mentioned file content (rough chars / 4)
    let totalChars = promptText.length;
    // Add rough estimate for each mentioned file (we don't have content here,
    // use a conservative 500 tokens per mention as placeholder)
    totalChars += mentionedFiles.length * 2000;
    if (ctx.includeFile && ctx.fileLines) { totalChars += ctx.fileLines * 40; }

    const estimated = Math.ceil(totalChars / 4); // (estimateTokens() expects text, not a char count)
    const window = getContextWindow();
    const pct = estimated / window;

    if (pct >= 0.95) {
        tokenIndicator.textContent = `~${estimated.toLocaleString()} / ${window.toLocaleString()} tokens ⚠`;
        tokenIndicator.className = 'over';
    } else if (pct >= 0.75) {
        tokenIndicator.textContent = `~${estimated.toLocaleString()} tokens`;
        tokenIndicator.className = 'warn';
    } else if (estimated > 50) {
        tokenIndicator.textContent = `~${estimated.toLocaleString()} tokens`;
        tokenIndicator.className = '';
    } else {
        tokenIndicator.textContent = '';
        tokenIndicator.className = '';
    }
}

// ── Status helpers ────────────────────────────────────────────────────────────

/** @param {'connected'|'disconnected'|'checking'} state @param {string} text */
function setStatus(state, text) {
    statusDot.className = state;
    statusText.textContent = text;
}

// ── Model list ────────────────────────────────────────────────────────────────

/**
 * @param {string[]} models
 * @param {boolean} connected
 */
function populateModels(models, connected) {
    modelSelect.innerHTML = '';
    if (!connected || !models.length) {
        setStatus('disconnected', 'Ollama not running — run: ollama serve');
        const o = document.createElement('option');
        o.textContent = 'No models';
        o.disabled = true;
        o.selected = true;
        modelSelect.appendChild(o);
        sendBtn.disabled = true;
        return;
    }
    models.forEach((name, i) => {
        const o = document.createElement('option');
        o.value = name;
        o.textContent = name;
        if (i === 0) { o.selected = true; }
        modelSelect.appendChild(o);
    });
    setStatus('connected', `${models.length} model${models.length > 1 ? 's' : ''} available`);
    sendBtn.disabled = false;
    promptEl.focus();
    updateTokenIndicator();
}

// Update token indicator when model changes (context window changes)
modelSelect.addEventListener('change', updateTokenIndicator);

// ── Markdown renderer ─────────────────────────────────────────────────────────

/** @param {string} s */
function escHtml(s) {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Inline markdown (bold / italic / strike) on text that is already HTML-escaped.
 * Underscore emphasis only applies at word boundaries, so names like read_file stay intact.
 * @param {string} s
 */
function renderInline(s) {
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|\W)__([^_\n]+)__(?!\w)/g, '$1<strong>$2</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\s][^*\n]*)\*(?![*\w])/g, '$1<em>$2</em>');
    s = s.replace(/(^|\W)_([^_\s][^_\n]*)_(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
    return s;
}

const LIST_RE        = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const PLACEHOLDER_RE = /^\x01(?:CB|TH)\d+\x01$/;
const HR_RE          = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const HEADING_RE     = /^(#{1,6})\s+(.+)$/;

/** Width of leading whitespace (tab = 4). @param {string} line */
function leadingIndent(line) {
    const ws = line.slice(0, line.length - line.trimStart().length);
    return ws.replace(/\t/g, '    ').length;
}

/**
 * Parse one (possibly nested) list starting at lines[start].
 * Items are emitted as <li> inside a real <ul>/<ol> with NO <br> between them, so no stray gaps.
 * @param {string[]} lines
 * @param {number} start
 * @returns {{html: string, next: number}}
 */
function renderList(lines, start) {
    const first = LIST_RE.exec(lines[start]);
    if (!first) { return { html: '', next: start + 1 }; }

    const baseIndent = leadingIndent(lines[start]);
    const ordered    = /^\d/.test(first[2]);
    const startNum   = ordered ? parseInt(first[2], 10) : 1;
    let i = start;
    let items = '';

    while (i < lines.length) {
        const m = LIST_RE.exec(lines[i]);
        if (!m) { break; }
        if (leadingIndent(lines[i]) < baseIndent) { break; }   // belongs to a parent list
        if (/^\d/.test(m[2]) !== ordered) { break; }            // bullet <-> numbered switch = new list

        let item = renderInline(m[3]);
        i++;

        // Collect nested lists, indented continuation text and code blocks that belong to this item.
        while (i < lines.length) {
            const line = lines[i];
            const t = line.trim();

            if (!t) {
                // Blank line: keep going only if the list / item content continues after it.
                let j = i + 1;
                while (j < lines.length && !lines[j].trim()) { j++; }
                if (j >= lines.length) { i = j; break; }
                if (LIST_RE.test(lines[j]) || leadingIndent(lines[j]) > baseIndent) { i = j; continue; }
                break;
            }

            if (LIST_RE.test(line)) {
                if (leadingIndent(line) > baseIndent) {
                    const sub = renderList(lines, i);
                    item += sub.html;
                    i = sub.next;
                    continue;
                }
                break; // sibling or parent item
            }
            if (PLACEHOLDER_RE.test(t)) { item += t; i++; continue; }          // code block inside the item
            if (leadingIndent(line) > baseIndent) {                            // indented continuation text
                item += '<br>' + renderInline(t);
                i++;
                continue;
            }
            break;
        }
        items += `<li>${item}</li>`;
    }

    const tag = ordered ? 'ol' : 'ul';
    const startAttr = ordered && startNum !== 1 ? ` start="${startNum}"` : '';
    return { html: `<${tag}${startAttr}>${items}</${tag}>`, next: i };
}

/**
 * Block-level markdown on escaped text: headings, rules, quotes, lists, paragraphs.
 * @param {string} text
 */
function renderBlocks(text) {
    const lines = text.split('\n');
    /** @type {string[]} */
    const out = [];
    let i = 0;

    const startsBlock = (/** @type {string} */ l) => {
        const t = l.trim();
        return !t || PLACEHOLDER_RE.test(t) || HR_RE.test(l) || HEADING_RE.test(t) ||
               t.startsWith('&gt;') || LIST_RE.test(l);
    };

    while (i < lines.length) {
        const line = lines[i];
        const t = line.trim();

        if (!t) { i++; continue; }
        if (PLACEHOLDER_RE.test(t)) { out.push(t); i++; continue; }
        if (HR_RE.test(line))       { out.push('<hr>'); i++; continue; }

        const h = HEADING_RE.exec(t);
        if (h) {
            const level = h[1].length;
            const tag = level === 1 ? 'h2' : level <= 3 ? 'h3' : 'h4';
            out.push(`<${tag}>${renderInline(h[2])}</${tag}>`);
            i++;
            continue;
        }

        if (t.startsWith('&gt;')) {
            /** @type {string[]} */
            const quote = [];
            while (i < lines.length && lines[i].trim().startsWith('&gt;')) {
                quote.push(renderInline(lines[i].trim().replace(/^&gt;\s?/, '')));
                i++;
            }
            out.push(`<blockquote>${quote.join('<br>')}</blockquote>`);
            continue;
        }

        if (LIST_RE.test(line)) {
            const list = renderList(lines, i);
            out.push(list.html);
            i = list.next;
            continue;
        }

        // Paragraph: consecutive plain lines (single newline = line break)
        /** @type {string[]} */
        const para = [];
        while (i < lines.length && !startsBlock(lines[i])) {
            para.push(renderInline(lines[i].trim()));
            i++;
        }
        if (!para.length) { para.push(renderInline(t)); i++; } // safety: always make progress
        out.push(`<p>${para.join('<br>')}</p>`);
    }
    return out.join('');
}

/** @param {string} text */
function renderMarkdown(text) {
    // 1. Extract fenced code blocks → placeholders
    /** @type {{lang:string, code:string}[]} */
    const codeBlocks = [];
    text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
        const id = `\x01CB${codeBlocks.length}\x01`;
        codeBlocks.push({ lang: lang || '', code: code.replace(/\n$/, '') });
        return id;
    });

    // 2. Extract inline code → placeholders
    /** @type {string[]} */
    const inlines = [];
    text = text.replace(/`([^`\n]+)`/g, (_, code) => {
        const id = `\x01IC${inlines.length}\x01`;
        inlines.push(code);
        return id;
    });

    // 3. Extract <think> blocks → placeholders
    /** @type {string[]} */
    const thinks = [];
    text = text.replace(/<think>([\s\S]*?)<\/think>/gi, (_, content) => {
        const id = `\x01TH${thinks.length}\x01`;
        thinks.push(content.trim());
        return id;
    });

    // 4. Escape remaining HTML
    text = escHtml(text);

    // 5. Put code / think placeholders on their own lines so they become real block elements
    text = text.replace(/\x01(?:CB|TH)\d+\x01/g, '\n$&\n');

    // 6. Headings, lists, quotes, paragraphs → HTML
    text = renderBlocks(text);

    // 7. Restore think blocks first (their text may hold code placeholders)…
    // NOTE: function replacers are used everywhere below so "$&", "$$" or "$'" inside code stay literal.
    thinks.forEach((content, i) => {
        const inner = escHtml(content).replace(/\n/g, '<br>');
        text = text.replace(
            `\x01TH${i}\x01`,
            () => `<details class="think-block"><summary>Reasoning (click to expand)</summary><div class="think-content">${inner}</div></details>`
        );
    });

    // 8. …then code blocks with optional syntax highlighting…
    codeBlocks.forEach(({ lang, code }, i) => {
        let highlighted = escHtml(code);

        // Use highlight.js if available and the language is known
        if (typeof window.hljs !== 'undefined' && lang) {
            try {
                const validLang = window.hljs.getLanguage(lang);
                if (validLang) {
                    highlighted = window.hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
                } else {
                    // Try auto-detection as fallback for unknown language tags
                    const auto = window.hljs.highlightAuto(code, ['javascript','typescript','python','rust','go','java','bash','json']);
                    if (auto.relevance > 5) { highlighted = auto.value; }
                }
            } catch { highlighted = escHtml(code); }
        }

        const header = `<div class="code-header">` +
            `<span class="code-lang-label">${escHtml(lang || 'code')}</span>` +
            `<button class="copy-btn" data-copy-idx="${i}">Copy</button>` +
            `</div>`;
        text = text.replace(
            `\x01CB${i}\x01`,
            () => `<div class="code-block" data-block-idx="${i}">${header}<pre class="hljs">${highlighted}</pre></div>`
        );
    });

    // 9. …then inline code
    inlines.forEach((code, i) => {
        text = text.replace(
            `\x01IC${i}\x01`,
            () => `<code class="inline">${escHtml(code)}</code>`
        );
    });

    return text || '&nbsp;';
}

// ── Copy code — event delegation (CSP-safe, no onclick attributes) ────────────

messagesEl.addEventListener('click', (e) => {
    const btn = /** @type {HTMLElement} */ (e.target);
    if (!btn.classList.contains('copy-btn')) { return; }
    const block = btn.closest('.code-block');
    if (!block) { return; }
    const pre = block.querySelector('pre');
    if (!pre) { return; }
    navigator.clipboard?.writeText(pre.textContent ?? '').then(() => {
        btn.textContent = 'Copied!';
        setTimeout(() => (btn.textContent = 'Copy'), 1500);
    }).catch(() => {
        // Fallback for environments where clipboard API is restricted
        btn.textContent = 'Copy';
    });
});

// ── Scroll helpers ────────────────────────────────────────────────────────────

function scrollBottom(force = false) {
    if (force || !userScrolledUp) {
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }
}

messagesEl.addEventListener('scroll', () => {
    const distFromBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
    userScrolledUp = distFromBottom > 60;
    scrollBtn.classList.toggle('visible', userScrolledUp && streaming);
});

scrollBtn.addEventListener('click', () => {
    userScrolledUp = false;
    scrollBtn.classList.remove('visible');
    scrollBottom(true);
});

// ── Tool icons ────────────────────────────────────────────────────────────────

const TOOL_ICONS = {
    workspace_summary: '🗂️',
    read_file:         '📄',
    list_files:        '📁',
    search_files:      '🔍',
    create_file:       '🆕',
    create_folder:     '📂',
    copy_file:         '📋',
    find_files:        '🔎',
    system_info:       '🖥️',
    get_diagnostics:   '🩺',
    edit_file:         '✏️',
    write_file:        '💾',
    append_to_file:    '📝',
    rename_file:       '🔄',
    delete_file:       '🗑️',
    run_command:       '⚡',
    memory_list:       '🧠',
    memory_write:      '💡',
    memory_delete:     '🗑️',
};

// ── Time helper ───────────────────────────────────────────────────────────────

function getTimeStr() {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ── Chat helpers ──────────────────────────────────────────────────────────────

function hideWelcome() {
    if (welcomeEl && welcomeEl.parentNode === messagesEl) {
        messagesEl.removeChild(welcomeEl);
    }
}

// addUserMessage is defined later in the History section with optional timestamp support

function startAssistantMessage() {
    hideWelcome();
    const div = document.createElement('div');
    div.className = 'message assistant';
    div.innerHTML =
        `<div class="msg-header">` +
            `<span class="msg-role">✦ Agent <span class="dots"><span></span><span></span><span></span></span></span>` +
            `<time class="msg-time">${getTimeStr()}</time>` +
        `</div>` +
        `<div class="msg-content"></div>`;
    messagesEl.insertBefore(div, scrollBtn);
    currentMsgEl = div;
    currentRaw = '';
    scrollBottom();
    return div;
}

/** @param {string} token */
function appendToken(token) {
    if (!currentMsgEl) { return; }
    currentRaw += token;
    const content = currentMsgEl.querySelector('.msg-content');
    if (content) {
        // During streaming show raw text — low-cost, avoids mid-stream markdown flicker
        content.textContent = currentRaw;
        scrollBottom();
    }
}

function finalizeMessage() {
    if (!currentMsgEl) { return; }

    // Remove loading dots from role label
    const roleEl = currentMsgEl.querySelector('.msg-role');
    if (roleEl) { roleEl.innerHTML = 'Agent'; }

    // Render full markdown
    const content = currentMsgEl.querySelector('.msg-content');
    if (content) { content.innerHTML = renderMarkdown(currentRaw); }

    // Add retry button to completed assistant messages
    const header = currentMsgEl.querySelector('.msg-header');
    if (header && currentRaw) {
        const actions = document.createElement('div');
        actions.className = 'msg-actions';
        const retryBtn = document.createElement('button');
        retryBtn.className = 'msg-action-btn retry-btn';
        retryBtn.title = 'Retry this response';
        retryBtn.textContent = '↺ Retry';
        actions.appendChild(retryBtn);
        header.appendChild(actions);
    }

    currentMsgEl = null;
    currentRaw = '';
    scrollBottom();
}

/** Remove the last assistant message element from the DOM (used for retry). */
function removeLastAssistantMsg() {
    // Walk backwards from scrollBtn (our fixed last child)
    let node = scrollBtn.previousSibling;
    while (node) {
        const el = /** @type {HTMLElement} */ (node);
        if (el.classList && el.classList.contains('message') && el.classList.contains('assistant')) {
            el.remove();
            return;
        }
        node = node.previousSibling;
    }
}

/**
 * @param {string} id
 * @param {string} name
 * @param {Record<string, unknown>} args
 */
function addToolCard(id, name, args) {
    const target = args.path || args.command || args.pattern || args.query;
    const activity = {
        workspace_summary: 'Exploring the workspace',
        system_info: 'Checking the environment',
        read_file: target ? `Reading ${target}` : 'Reading a file',
        list_files: target ? `Listing ${target}` : 'Listing workspace files',
        find_files: target ? `Finding ${target}` : 'Finding workspace files',
        search_files: target ? `Searching for ${target}` : 'Searching workspace files',
        create_file: target ? `Creating ${target}` : 'Creating a file',
        create_folder: target ? `Creating folder ${target}` : 'Creating a folder',
        edit_file: target ? `Editing ${target}` : 'Editing a file',
        write_file: target ? `Writing ${target}` : 'Writing a file',
        append_to_file: target ? `Updating ${target}` : 'Updating a file',
        rename_file: args.new_path ? `Moving to ${args.new_path}` : 'Renaming a file',
        copy_file: args.destination ? `Copying to ${args.destination}` : 'Copying a file',
        delete_file: target ? `Deleting ${target}` : 'Deleting a file',
        run_command: target ? `Running: ${target}` : 'Running a command',
        get_diagnostics: 'Checking code diagnostics',
        memory_list: 'Checking project notes',
        memory_write: 'Saving a project note',
        memory_delete: 'Removing a project note',
    };
    setAgentStatus(`${activity[name] || `Using ${name.replace(/_/g, ' ')}`}…`);
    const icon = TOOL_ICONS[name] || '🔧';
    const visibleArgs = ['create_file', 'write_file', 'append_to_file', 'edit_file'].includes(name)
        ? Object.fromEntries(Object.entries(args).filter(([key]) => !['content', 'old_string', 'new_string'].includes(key)))
        : args;
    const argsStr = Object.entries(visibleArgs)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(' ');
    const div = document.createElement('div');
    div.className = 'tool-card';
    div.id = `tool-${id}`;
    div.innerHTML =
        `<div class="tool-icon">${icon}</div>` +
        `<div class="tool-info">` +
            `<div class="tool-name">${escHtml(name)}</div>` +
            `<div class="tool-args">${escHtml(argsStr)}</div>` +
        `</div>` +
        `<div class="dots"><span></span><span></span><span></span></div>`;
    messagesEl.insertBefore(div, scrollBtn);
    scrollBottom();
}

/**
 * @param {string} id
 * @param {boolean} success
 * @param {string} preview
 */
function updateToolCard(id, success, preview) {
    const card = document.getElementById(`tool-${id}`);
    if (!card) { return; }
    card.classList.add(success ? 'success' : 'error');
    const dots = card.querySelector('.dots');
    if (dots) { dots.remove(); }
    const info = card.querySelector('.tool-info');
    if (info) {
        const p = document.createElement('div');
        p.className = 'tool-preview';
        p.textContent = preview;
        info.appendChild(p);
    }
    setAgentStatus('Thinking about the next step…');
    scrollBottom();
}

/** @param {string} text */
function addErrorMessage(text) {
    finalizeMessage();
    const div = document.createElement('div');
    div.className = 'message error-msg';
    div.innerHTML =
        `<div class="msg-header">` +
            `<span class="msg-role" style="color:var(--vscode-errorForeground,#f48771);opacity:0.9">Error</span>` +
            `<time class="msg-time">${getTimeStr()}</time>` +
        `</div>` +
        `<div class="msg-content" style="color:var(--vscode-errorForeground,#f48771)">⚠ ${escHtml(text)}</div>`;
    messagesEl.insertBefore(div, scrollBtn);
    scrollBottom(true);
}

function clearChat() {
    // Remove all message / tool-card children but keep #welcome and #scroll-btn
    Array.from(messagesEl.childNodes).forEach((node) => {
        const el = /** @type {HTMLElement} */ (node);
        if (el.id === 'scroll-btn') { return; }
        if (el.id === 'welcome') { return; }
        el.remove();
    });
    // Re-attach welcome if it was removed
    if (!document.getElementById('welcome')) {
        messagesEl.insertBefore(welcomeEl, scrollBtn);
        // Re-attach hint chip handlers
        welcomeEl.querySelectorAll('.hint-chip').forEach((btn) => {
            btn.addEventListener('click', () => {
                const hint = /** @type {HTMLButtonElement} */ (btn).dataset.hint;
                if (hint) { promptEl.value = hint; sendMessage(); }
            });
        });
    }
    currentMsgEl = null;
    currentRaw = '';
    userScrolledUp = false;
    scrollBtn.classList.remove('visible');
}

// ── Retry via event delegation ────────────────────────────────────────────────

messagesEl.addEventListener('click', (e) => {
    const btn = /** @type {HTMLElement} */ (e.target);
    if (!btn.classList.contains('retry-btn')) { return; }
    if (streaming) { return; }
    // Remove this message bubble so it will be replaced
    const msgDiv = btn.closest('.message.assistant');
    if (msgDiv) { msgDiv.remove(); }
    setStreaming(true);
    vscode.postMessage({ command: 'retryLast', model: modelSelect.value });
});

// ── Context bar ───────────────────────────────────────────────────────────────

function updateContextBar() {
    contextBar.innerHTML = '';

    if (ctx.file) {
        const pill = document.createElement('span');
        pill.className = 'ctx-pill' + (ctx.includeFile ? ' active' : '');
        pill.title = ctx.includeFile
            ? 'Full file attached — click × to detach'
            : 'Click to attach full file';

        const fileName = ctx.file.split('/').pop() || ctx.file;
        pill.innerHTML =
            `📄 <span style="overflow:hidden;text-overflow:ellipsis;max-width:100px;display:inline-block;vertical-align:middle">${escHtml(fileName)}</span>` +
            ` <span class="ctx-pill-toggle" data-toggle="file">${ctx.includeFile ? '×' : '+'}</span>`;
        contextBar.appendChild(pill);
    }

    if (ctx.selectionLines > 0) {
        const pill = document.createElement('span');
        pill.className = 'ctx-pill' + (ctx.includeSelection ? ' active' : '');
        pill.title = ctx.includeSelection
            ? 'Selection attached — click × to detach'
            : 'Click to attach selection';
        pill.innerHTML =
            `✂️ ${ctx.selectionLines} line${ctx.selectionLines > 1 ? 's' : ''}` +
            ` <span class="ctx-pill-toggle" data-toggle="selection">${ctx.includeSelection ? '×' : '+'}</span>`;
        contextBar.appendChild(pill);
    }

    // @mention pills
    mentionedFiles.forEach((f) => {
        const pill = document.createElement('span');
        pill.className = 'mention-pill';
        pill.title = f.rel;
        pill.innerHTML =
            `${fileIcon(f.ext)} ${escHtml(f.display)}` +
            ` <span class="mention-pill-remove" data-remove-rel="${escHtml(f.rel)}">×</span>`;
        contextBar.appendChild(pill);
    });
}

contextBar.addEventListener('click', (e) => {
    const el = /** @type {HTMLElement} */ (e.target);

    // Handle @mention pill removal
    if (el.dataset.removeRel) {
        mentionedFiles = mentionedFiles.filter((f) => f.rel !== el.dataset.removeRel);
        updateContextBar();
        updateTokenIndicator();
        return;
    }

    // Handle file/selection toggle
    if (!el.dataset.toggle) { return; }
    if (el.dataset.toggle === 'file') {
        ctx.includeFile = !ctx.includeFile;
        if (ctx.includeFile) { ctx.includeSelection = false; }
    } else if (el.dataset.toggle === 'selection') {
        ctx.includeSelection = !ctx.includeSelection;
        if (ctx.includeSelection) { ctx.includeFile = false; }
    }
    updateContextBar();
    updateTokenIndicator();
});

// ── Command output blocks ─────────────────────────────────────────────────────

/**
 * @param {string} id
 * @param {string} cmd
 */
function addCommandBlock(id, cmd) {
    const div = document.createElement('div');
    div.className = 'cmd-block';
    div.id = `cmd-${id}`;
    div.innerHTML =
        `<div class="cmd-header">` +
            `<span class="cmd-icon">⚡</span>` +
            `<span class="cmd-label">${escHtml(cmd)}</span>` +
            `<div class="dots"><span></span><span></span><span></span></div>` +
        `</div>` +
        `<div class="cmd-output"></div>`;
    messagesEl.insertBefore(div, scrollBtn);
    scrollBottom();
}

/**
 * @param {string} id
 * @param {string} text
 * @param {'stdout'|'stderr'} stream
 */
function appendCommandChunk(id, text, stream) {
    const block = document.getElementById(`cmd-${id}`);
    if (!block) { return; }
    const output = block.querySelector('.cmd-output');
    if (!output) { return; }
    const span = document.createElement('span');
    if (stream === 'stderr') { span.className = 'stderr'; }
    span.textContent = text;
    output.appendChild(span);
    // Auto-scroll the output pane itself
    output.scrollTop = output.scrollHeight;
    scrollBottom();
}

/**
 * @param {string} id
 * @param {number} exitCode
 */
function finalizeCommandBlock(id, exitCode) {
    const block = document.getElementById(`cmd-${id}`);
    if (!block) { return; }
    block.classList.add(exitCode === 0 ? 'success' : 'error');
    const dots = block.querySelector('.dots');
    if (dots) { dots.remove(); }
    const header = block.querySelector('.cmd-header');
    if (header) {
        const badge = document.createElement('span');
        badge.className = 'cmd-exit';
        badge.textContent = `exit ${exitCode}`;
        header.appendChild(badge);
    }
    scrollBottom();
}

// ── File-changed notification ─────────────────────────────────────────────────

const FILE_ACTION_ICONS = {
    created:  '✅',
    edited:   '✏️',
    written:  '💾',
    appended: '📝',
    renamed:  '🔄',
    deleted:  '🗑️',
};

/**
 * @param {string} filePath
 * @param {string} action
 * @param {number | undefined} added
 * @param {number | undefined} removed
 */
function addFileToast(filePath, action, added, removed) {
    const div = document.createElement('div');
    const isEdit   = action === 'edited'  || action === 'written' || action === 'appended';
    const isDelete = action === 'deleted';
    div.className = `file-toast${isEdit ? ' edited' : ''}${isDelete ? ' deleted' : ''}`;
    const icon = FILE_ACTION_ICONS[action] ?? '📁';
    const hasLineChanges = (Number.isInteger(added) && added !== 0) || (Number.isInteger(removed) && removed !== 0);
    const lineStats = hasLineChanges
        ? `<span class="file-diff-stats" aria-label="${Number(added) || 0} lines added, ${Number(removed) || 0} lines removed">` +
            `<span class="file-diff-added">+${Number(added) || 0}</span>` +
            `<span class="file-diff-removed">−${Number(removed) || 0}</span>` +
          `</span>`
        : '';
    div.innerHTML = `${icon} <span class="file-toast-label">${escHtml(action.charAt(0).toUpperCase() + action.slice(1))}: <strong>${escHtml(filePath)}</strong></span>${lineStats}`;
    messagesEl.insertBefore(div, scrollBtn);
    scrollBottom();
}

// ── Mode-switch notice (native → text-mode tool calling) ─────────────────────

/** @param {string} model */
function addModeNotice(model) {
    const div = document.createElement('div');
    div.className = 'file-toast';
    div.style.cssText = 'background:rgba(229,192,123,0.08);border-color:rgba(229,192,123,0.35);color:#e5c07b;';
    div.innerHTML =
        `⚙️ <span><strong>${escHtml(model)}</strong> doesn't support native tool calling — ` +
        `switched to text-mode automatically. Tools still work.</span>`;
    messagesEl.insertBefore(div, scrollBtn);
    scrollBottom(true);
}

// ── Send logic ────────────────────────────────────────────────────────────────

/** @param {boolean} on */
function setStreaming(on) {
    streaming = on;
    sendBtn.disabled = on || modelSelect.value === '';
    stopBtn.classList.toggle('visible', on);
    scrollBtn.classList.toggle('visible', on && userScrolledUp);
    if (!on) {
        promptEl.focus();
        scrollBtn.classList.remove('visible');
    }
}

/** @param {string} text */
function setAgentStatus(text) {
    agentStatusText.textContent = text;
    agentStatus.classList.toggle('visible', Boolean(text));
}

function sendMessage() {
    const text = promptEl.value.trim();
    if (!text || streaming) { return; }

    addUserMessage(text);
    promptEl.value = '';
    autoResize();
    hideMentionDropdown();
    setStreaming(true);

    const filesToSend = mentionedFiles.map((f) => f.rel);
    // Clear mention state after send
    mentionedFiles = [];
    updateContextBar();
    updateTokenIndicator();

    vscode.postMessage({
        command: 'sendMessage',
        text,
        model: modelSelect.value,
        includeFile: ctx.includeFile,
        includeSelection: ctx.includeSelection,
        mentionedFiles: filesToSend,
    });
}

sendBtn.addEventListener('click', sendMessage);

stopBtn.addEventListener('click', () => {
    vscode.postMessage({ command: 'stopGeneration' });
});

newChatBtn.addEventListener('click', () => {
    if (streaming) { return; }
    vscode.postMessage({ command: 'newChat' });
    clearChat();
});

promptEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

// Auto-resize textarea
function autoResize() {
    promptEl.style.height = 'auto';
    promptEl.style.height = `${Math.min(promptEl.scrollHeight, 140)}px`;
}
promptEl.addEventListener('input', () => { autoResize(); updateTokenIndicator(); });

// ── @mention autocomplete ─────────────────────────────────────────────────────

const EXT_ICONS = {
    ts:'🟦', tsx:'🟦', js:'🟨', jsx:'🟨', py:'🐍', rs:'🦀', go:'🐹',
    java:'☕', kt:'🟪', cs:'🔷', cpp:'⚙️', c:'⚙️', rb:'💎', php:'🐘',
    swift:'🍎', sh:'🖥️', bash:'🖥️', css:'🎨', scss:'🎨', html:'🌐',
    json:'📋', yaml:'📋', yml:'📋', md:'📝', sql:'🗄️', xml:'📄',
    toml:'📄', dockerfile:'🐳', lock:'🔒',
};
function fileIcon(ext) { return EXT_ICONS[ext] || '📄'; }

function showMentionDropdown(results) {
    mentionResults = results;
    mentionSelectedIdx = 0;
    mentionDropdown.innerHTML = '';

    if (!results.length) {
        mentionDropdown.style.display = 'none';
        return;
    }

    results.forEach((f, i) => {
        const item = document.createElement('div');
        item.className = 'mention-item' + (i === 0 ? ' selected' : '');
        item.dataset.idx = String(i);
        item.innerHTML =
            `<span class="mention-item-icon">${fileIcon(f.ext)}</span>` +
            `<span class="mention-item-base">${escHtml(f.display)}</span>` +
            `<span class="mention-item-rel">${escHtml(f.rel)}</span>`;
        item.addEventListener('mousedown', (e) => {
            e.preventDefault(); // keep textarea focused
            selectMentionItem(i);
        });
        mentionDropdown.appendChild(item);
    });

    mentionDropdown.style.display = 'block';
}

function hideMentionDropdown() {
    mentionDropdown.style.display = 'none';
    mentionAtStart = -1;
    mentionQuery = '';
    mentionResults = [];
}

function selectMentionItem(idx) {
    const file = mentionResults[idx];
    if (!file) { return; }

    // Replace @query in textarea with empty string (the pill takes its place)
    const val = promptEl.value;
    const before = val.slice(0, mentionAtStart);
    const after  = val.slice(mentionAtStart + 1 + mentionQuery.length); // +1 for '@'
    promptEl.value = before + after;
    autoResize();

    // Add to mentioned files (avoid duplicates)
    if (!mentionedFiles.some((f) => f.rel === file.rel)) {
        mentionedFiles.push(file);
        updateContextBar();
    }

    hideMentionDropdown();
    promptEl.focus();
    updateTokenIndicator();
}

function navigateMentionDropdown(direction) {
    if (!mentionResults.length) { return; }
    const items = mentionDropdown.querySelectorAll('.mention-item');
    items[mentionSelectedIdx]?.classList.remove('selected');
    mentionSelectedIdx = (mentionSelectedIdx + direction + mentionResults.length) % mentionResults.length;
    items[mentionSelectedIdx]?.classList.add('selected');
    items[mentionSelectedIdx]?.scrollIntoView({ block: 'nearest' });
}

promptEl.addEventListener('input', () => {
    const val = promptEl.value;
    const pos = promptEl.selectionStart ?? val.length;

    // Check if there's an active @ mention being typed
    const before = val.slice(0, pos);
    const atIdx = before.lastIndexOf('@');

    if (atIdx >= 0) {
        const fragment = before.slice(atIdx + 1);
        // Only trigger if no space in the query (space = @mention ended)
        if (!fragment.includes(' ') && !fragment.includes('\n')) {
            mentionAtStart = atIdx;
            mentionQuery = fragment;
            vscode.postMessage({ command: 'searchFiles', query: fragment });
            return;
        }
    }

    // No active mention
    hideMentionDropdown();
    updateTokenIndicator();
});

promptEl.addEventListener('keydown', (e) => {
    if (mentionDropdown.style.display !== 'none') {
        if (e.key === 'ArrowDown')  { e.preventDefault(); navigateMentionDropdown(+1); return; }
        if (e.key === 'ArrowUp')    { e.preventDefault(); navigateMentionDropdown(-1); return; }
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); selectMentionItem(mentionSelectedIdx); return; }
        if (e.key === 'Escape')     { hideMentionDropdown(); return; }
        if (e.key === 'Tab')        { e.preventDefault(); selectMentionItem(mentionSelectedIdx); return; }
    }
});

// Hint chips (initial welcome screen)
document.querySelectorAll('.hint-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
        const hint = /** @type {HTMLButtonElement} */ (btn).dataset.hint;
        if (hint) { promptEl.value = hint; sendMessage(); }
    });
});

// ── Message handler (extension → webview) ────────────────────────────────────

window.addEventListener('message', (event) => {
    const msg = event.data;

    switch (msg.type) {
        case 'models':
            populateModels(msg.models, msg.connected);
            break;

        case 'agentStart':
            setAgentStatus('Thinking through your request…');
            setStreaming(true);
            break;

        case 'agentEnd':
            setAgentStatus('');
            setStreaming(false);
            break;

        case 'agentActivity':
            setAgentStatus(msg.text ?? 'Working…');
            break;

        case 'streamStart':
            setAgentStatus('Planning the next step…');
            startAssistantMessage();
            break;

        case 'token':
            if (agentStatusText.textContent === 'Planning the next step…') {
                setAgentStatus('Working on your request…');
            }
            appendToken(msg.text);
            break;

        case 'streamEnd':
            finalizeMessage();
            break;

        case 'toolCall':
            addToolCard(msg.id, msg.name, msg.args);
            break;

        case 'toolResult':
            updateToolCard(msg.id, msg.success, msg.preview ?? '');
            break;

        case 'error':
            addErrorMessage(msg.text);
            setStreaming(false);
            break;

        case 'clearChat':
            clearChat();
            break;

        case 'removeLastAssistant':
            removeLastAssistantMsg();
            break;

        case 'commandStart':
            setAgentStatus(msg.cmd ? `Running: ${msg.cmd}` : 'Running command…');
            addCommandBlock(msg.id, msg.cmd);
            break;

        case 'commandChunk':
            appendCommandChunk(msg.id, msg.text, msg.stream);
            break;

        case 'commandEnd':
            finalizeCommandBlock(msg.id, msg.exitCode);
            setAgentStatus('Thinking about the command result…');
            break;

        case 'fileChanged':
            addFileToast(msg.path, msg.action, msg.added, msg.removed);
            break;

        case 'modeSwitch':
            addModeNotice(msg.model);
            break;

        case 'sessionList':
            renderSessionList(msg.sessions, msg.currentId);
            break;

        case 'sessionLoaded':
            renderStoredSession(msg.session, msg.messages);
            break;

        case 'sessionSaved':
            // Silently update active session id
            activeSessionId = msg.session.id;
            break;

        case 'contextUpdate':
            ctx.file           = msg.file ?? null;
            ctx.fileLines      = msg.fileLines ?? 0;
            ctx.language       = msg.language ?? '';
            ctx.selectionLines = msg.selectionLines ?? 0;
            if (!ctx.file)           { ctx.includeFile = false; }
            if (!ctx.selectionLines) { ctx.includeSelection = false; }
            updateContextBar();
            updateTokenIndicator();
            break;

        case 'fileSearchResults':
            // Only apply if the query matches the current active mention
            if (msg.query === mentionQuery) {
                showMentionDropdown(msg.files ?? []);
            }
            break;
    }
});

// ── History panel ─────────────────────────────────────────────────────────────

/** @type {string | null} Current active session id (for highlighting in the list) */
let activeSessionId = null;

function openHistoryPanel() {
    historyPanel.classList.add('open');
    historyBtn.classList.add('active');
    vscode.postMessage({ command: 'listSessions' });
}

function closeHistoryPanel() {
    historyPanel.classList.remove('open');
    historyBtn.classList.remove('active');
}

historyBtn.addEventListener('click', () => {
    historyPanel.classList.contains('open') ? closeHistoryPanel() : openHistoryPanel();
});
historyCloseBtn.addEventListener('click', closeHistoryPanel);

historyClearBtn.addEventListener('click', () => {
    if (!confirm('Delete ALL saved chats? This cannot be undone.')) { return; }
    vscode.postMessage({ command: 'clearAllSessions' });
    closeHistoryPanel();
});

/**
 * @typedef {{ id: string, title: string, model: string, messageCount: number, updatedAt: number, relativeTime: string }} SessionSummary
 */

/**
 * @param {SessionSummary[]} sessions
 * @param {string | null} currentId
 */
function renderSessionList(sessions, currentId) {
    activeSessionId = currentId;
    historyList.innerHTML = '';

    if (!sessions.length) {
        const empty = document.createElement('div');
        empty.id = 'history-empty';
        empty.innerHTML = '<span style="font-size:24px;opacity:0.4">🕐</span><span>No saved chats yet.<br>Start a conversation to save it here.</span>';
        historyList.appendChild(empty);
        return;
    }

    sessions.forEach((s) => {
        const item = document.createElement('div');
        item.className = 'session-item' + (s.id === currentId ? ' active' : '');
        item.dataset.id = s.id;

        const info = document.createElement('div');
        info.className = 'session-info';

        const title = document.createElement('div');
        title.className = 'session-title';
        title.textContent = s.title;

        const meta = document.createElement('div');
        meta.className = 'session-meta';
        meta.innerHTML =
            `<span>${escHtml(s.relativeTime)}</span>` +
            `<span>${s.messageCount} msg${s.messageCount !== 1 ? 's' : ''}</span>` +
            `<span>${escHtml(s.model.split(':')[0])}</span>`;

        info.appendChild(title);
        info.appendChild(meta);

        const del = document.createElement('button');
        del.className = 'session-delete';
        del.title = 'Delete chat';
        del.textContent = '🗑';
        del.addEventListener('click', (e) => {
            e.stopPropagation();
            vscode.postMessage({ command: 'deleteSession', id: s.id });
        });

        item.appendChild(info);
        item.appendChild(del);

        item.addEventListener('click', () => {
            vscode.postMessage({ command: 'loadSession', id: s.id });
            closeHistoryPanel();
        });

        historyList.appendChild(item);
    });
}

// ── Load a stored session into the chat UI ────────────────────────────────────

/**
 * @param {SessionSummary} session
 * @param {Array<{role: string, content: string, timestamp: number}>} messages
 */
function renderStoredSession(session, messages) {
    clearChat();
    activeSessionId = session.id;

    if (!messages.length) { return; }

    messages.forEach((msg) => {
        if (msg.role === 'user') {
            addUserMessage(msg.content, msg.timestamp);
        } else if (msg.role === 'assistant') {
            addStoredAssistantMessage(msg.content, msg.timestamp);
        } else if (msg.role === 'error') {
            addErrorMessage(msg.content);
        }
    });
}

/**
 * Add a completed assistant message (no streaming — render markdown immediately).
 * @param {string} content
 * @param {number} timestamp
 */
function addStoredAssistantMessage(content, timestamp) {
    hideWelcome();
    const div = document.createElement('div');
    div.className = 'message assistant';
    const timeStr = timestamp
        ? new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : getTimeStr();
    div.innerHTML =
        `<div class="msg-header">` +
            `<span class="msg-role">Agent</span>` +
            `<time class="msg-time">${timeStr}</time>` +
            `<div class="msg-actions"><button class="msg-action-btn retry-btn" title="Retry">↺ Retry</button></div>` +
        `</div>` +
        `<div class="msg-content">${renderMarkdown(content)}</div>`;
    messagesEl.insertBefore(div, scrollBtn);
}

// ── Update addUserMessage to accept an optional stored timestamp ──────────────
// (override the existing one)
function addUserMessage(text, timestamp) {
    hideWelcome();
    const div = document.createElement('div');
    div.className = 'message user';
    const timeStr = timestamp
        ? new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : getTimeStr();
    div.innerHTML =
        `<div class="msg-header">` +
            `<span class="msg-role">You</span>` +
            `<time class="msg-time">${timeStr}</time>` +
        `</div>` +
        `<div class="msg-content">${escHtml(text).replace(/\n/g, '<br>')}</div>`;
    messagesEl.insertBefore(div, scrollBtn);
    userScrolledUp = false;
    scrollBottom(true);
}

// ── Init ──────────────────────────────────────────────────────────────────────

setStatus('checking', 'Connecting…');
// Request models + current editor context
vscode.postMessage({ command: 'getModels' });
vscode.postMessage({ command: 'getContext' });