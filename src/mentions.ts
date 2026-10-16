import * as fs from 'fs';
import * as path from 'path';
import { SKIP_DIRS } from './workspace';
import { logInfo, logWarn } from './logger';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FileMention {
    /** Path relative to workspace root. */
    rel: string;
    /** Basename for display in the dropdown. */
    display: string;
    /** Lowercase extension without the dot (e.g. "ts"). */
    ext: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Maximum files to index (performance guard for huge monorepos). */
const MAX_INDEX = 4000;
/** Cap per mentioned file — protects context window. */
const MAX_FILE_CHARS = 100_000;
/** Binary-ish extensions we skip when reading file content. */
const BINARY_EXTS = new Set([
    'png','jpg','jpeg','gif','webp','svg','ico','bmp','tiff',
    'pdf','zip','gz','tar','rar','7z',
    'exe','dll','so','dylib','wasm',
    'mp3','mp4','wav','ogg','webm','mov',
    'ttf','otf','woff','woff2','eot',
    'lock','vsix',
]);

// ── Workspace file index ──────────────────────────────────────────────────────

/**
 * Walk the workspace and build a flat list of all (non-binary-ish) file paths.
 * Respects SKIP_DIRS and includes dot-files such as environment templates.
 */
export function indexWorkspaceFiles(root: string): FileMention[] {
    const results: FileMention[] = [];

    function walk(dir: string): void {
        if (results.length >= MAX_INDEX) { return; }
        try {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                if (SKIP_DIRS.has(e.name) || (e.isDirectory() && e.name.startsWith('.'))) { continue; }
                const full = path.join(dir, e.name);
                if (e.isDirectory()) { walk(full); continue; }
                const ext = path.extname(e.name).slice(1).toLowerCase();
                if (BINARY_EXTS.has(ext)) { continue; }
                results.push({
                    rel: path.relative(root, full),
                    display: e.name,
                    ext,
                });
            }
        } catch { /* skip inaccessible dirs */ }
    }

    walk(root);
    logInfo(`[mentions] Indexed ${results.length} files`);
    return results;
}

// ── Fuzzy search ──────────────────────────────────────────────────────────────

/**
 * Score how well a file matches the query string.
 * Higher = better match.
 */
function score(file: FileMention, q: string): number {
    const rel = file.rel.toLowerCase();
    const base = file.display.toLowerCase();
    const query = q.toLowerCase();

    if (base === query) { return 100; }
    if (base.startsWith(query)) { return 80; }
    if (base.includes(query)) { return 60; }

    // All whitespace-separated tokens must appear in the relative path
    const tokens = query.split(/[\s/\\.-]+/).filter(Boolean);
    if (!tokens.every((t) => rel.includes(t))) { return 0; }

    // Bonus for shorter paths (more specific match)
    return Math.max(1, 40 - rel.length / 10);
}

/**
 * Fuzzy search files by query string.
 * Returns at most `limit` results, sorted by relevance.
 */
export function fuzzySearchFiles(
    files: FileMention[],
    query: string,
    limit = 12
): FileMention[] {
    if (!query.trim()) {
        // No query: return recently modified / alphabetically first
        return files.slice(0, limit);
    }

    return files
        .map((f) => ({ f, s: score(f, query) }))
        .filter(({ s }) => s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, limit)
        .map(({ f }) => f);
}

// ── File content reading ──────────────────────────────────────────────────────

export interface MentionContent {
    rel: string;
    content: string;
    lines: number;
    truncated: boolean;
    lang: string;
}

const EXT_TO_LANG: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    py: 'python',
    rs: 'rust',
    go: 'go',
    java: 'java', kt: 'kotlin',
    cs: 'csharp',
    cpp: 'cpp', cc: 'cpp', cxx: 'cpp', c: 'c', h: 'c', hpp: 'cpp',
    rb: 'ruby',
    php: 'php',
    swift: 'swift',
    sh: 'bash', bash: 'bash', zsh: 'bash',
    html: 'html', htm: 'html',
    css: 'css', scss: 'scss', less: 'less',
    json: 'json',
    yaml: 'yaml', yml: 'yaml',
    toml: 'toml',
    md: 'markdown',
    sql: 'sql',
    xml: 'xml',
    dockerfile: 'dockerfile',
};

/**
 * Read a mentioned file's content, capped at MAX_FILE_CHARS.
 * Throws if the path is outside the workspace or the file is unreadable.
 */
export function readMentionedFile(rel: string, root: string): MentionContent {
    const full = path.resolve(root, rel);
    if (!full.startsWith(root)) {
        throw new Error(`Path outside workspace: ${rel}`);
    }

    const raw = fs.readFileSync(full, 'utf8');
    const truncated = raw.length > MAX_FILE_CHARS;
    const content = truncated ? raw.slice(0, MAX_FILE_CHARS) : raw;
    const lines = content.split('\n').length;
    const ext = path.extname(rel).slice(1).toLowerCase();
    const lang = EXT_TO_LANG[ext] ?? ext ?? 'text';

    if (truncated) {
        logWarn(`[mentions] ${rel} truncated at ${MAX_FILE_CHARS} chars`);
    }

    return { rel, content, lines, truncated, lang };
}

/**
 * Build the context string blocks for all mentioned files.
 * Already-attached content (from auto-include) can be passed to avoid duplication.
 */
export function buildMentionContext(
    paths: string[],
    root: string,
    alreadyAttached: Set<string> = new Set()
): string {
    const blocks: string[] = [];

    for (const rel of paths) {
        if (alreadyAttached.has(rel)) { continue; }
        try {
            const { content, lines, truncated, lang } = readMentionedFile(rel, root);
            const note = truncated ? ` [truncated at ${MAX_FILE_CHARS} chars]` : '';
            blocks.push(
                `<mention path="${rel}" lang="${lang}" lines="${lines}"${note}>\n` +
                `\`\`\`${lang}\n${content}\n\`\`\`` +
                `\n</mention>`
            );
        } catch (err) {
            blocks.push(`<mention path="${rel}" error="${(err as Error).message}" />`);
        }
    }

    return blocks.length ? `\n\n${blocks.join('\n\n')}` : '';
}
