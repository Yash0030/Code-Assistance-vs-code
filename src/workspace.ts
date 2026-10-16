import * as fs from 'fs';
import * as path from 'path';

// Directories to ignore during all workspace scans
export const SKIP_DIRS = new Set([
    '.git', 'node_modules', '.vscode', 'dist', 'build', 'out', '.next',
    '__pycache__', 'coverage', '.nyc_output', '.cache', 'tmp', 'temp',
    '.turbo', '.parcel-cache', 'vendor',
]);

// ── File tree ─────────────────────────────────────────────────────────────────

/**
 * Build an ASCII file tree rooted at `dir`.
 * Returns the tree as a single string.
 */
export function buildFileTree(dir: string, maxDepth = 3): string {
    const lines: string[] = [];

    function walk(d: string, depth: number, prefix: string): void {
        if (depth > maxDepth) { return; }
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(d, { withFileTypes: true }); }
        catch { return; }

        const visible = entries
            .filter((e) => !SKIP_DIRS.has(e.name) && (!e.isDirectory() || !e.name.startsWith('.')))
            .sort((a, b) => {
                if (a.isDirectory() !== b.isDirectory()) { return a.isDirectory() ? -1 : 1; }
                return a.name.localeCompare(b.name);
            });

        visible.forEach((e, i) => {
            const last = i === visible.length - 1;
            lines.push(`${prefix}${last ? '└── ' : '├── '}${e.name}${e.isDirectory() ? '/' : ''}`);
            if (e.isDirectory()) {
                walk(path.join(d, e.name), depth + 1, prefix + (last ? '    ' : '│   '));
            }
        });
    }

    lines.push(`${path.basename(dir)}/`);
    walk(dir, 0, '');
    return lines.join('\n');
}

// ── Project type detection ────────────────────────────────────────────────────

const PROJECT_MARKERS: [string, string][] = [
    ['package.json',    'Node.js / TypeScript'],
    ['requirements.txt','Python'],
    ['Pipfile',         'Python (Pipenv)'],
    ['pyproject.toml',  'Python (PEP 517)'],
    ['Cargo.toml',      'Rust'],
    ['go.mod',          'Go'],
    ['pom.xml',         'Java (Maven)'],
    ['build.gradle',    'Java/Kotlin (Gradle)'],
    ['Gemfile',         'Ruby'],
    ['composer.json',   'PHP'],
    ['pubspec.yaml',    'Dart / Flutter'],
    ['.csproj',         'C# (.NET)'],
];

export function detectProjectType(root: string): string {
    for (const [marker, type] of PROJECT_MARKERS) {
        if (marker.startsWith('.')) {
            // Extension search
            try {
                const files = fs.readdirSync(root);
                if (files.some((f) => f.endsWith(marker))) { return type; }
            } catch { /* skip */ }
        } else if (fs.existsSync(path.join(root, marker))) {
            return type;
        }
    }
    return 'Unknown';
}

// ── Key files summary ─────────────────────────────────────────────────────────

export function getKeyFilesSummary(root: string): string {
    const parts: string[] = [];

    // package.json
    const pkgPath = path.join(root, 'package.json');
    if (fs.existsSync(pkgPath)) {
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
                name?: string; version?: string; description?: string;
                scripts?: Record<string, string>; dependencies?: Record<string, string>;
                devDependencies?: Record<string, string>;
            };
            parts.push(`package.json:`);
            if (pkg.name)        { parts.push(`  name: ${pkg.name} ${pkg.version ?? ''}`); }
            if (pkg.description) { parts.push(`  description: ${pkg.description}`); }
            if (pkg.scripts) {
                const scripts = Object.keys(pkg.scripts).slice(0, 6).join(', ');
                parts.push(`  scripts: ${scripts}`);
            }
            if (pkg.dependencies) {
                const deps = Object.keys(pkg.dependencies).slice(0, 8).join(', ');
                parts.push(`  dependencies: ${deps}`);
            }
        } catch { /* skip */ }
    }

    // README
    const readmeNames = ['README.md', 'README.txt', 'readme.md', 'Readme.md'];
    for (const name of readmeNames) {
        const p = path.join(root, name);
        if (fs.existsSync(p)) {
            try {
                const lines = fs.readFileSync(p, 'utf8').split('\n').slice(0, 8);
                parts.push(`\n${name} (first 8 lines):\n${lines.join('\n')}`);
            } catch { /* skip */ }
            break;
        }
    }

    // tsconfig / pyproject / etc.
    for (const name of ['tsconfig.json', 'pyproject.toml', 'Cargo.toml']) {
        if (fs.existsSync(path.join(root, name))) {
            parts.push(`\n${name}: present`);
        }
    }

    return parts.join('\n') || '(no key files found)';
}

// ── Recently modified files ───────────────────────────────────────────────────

export function getRecentlyModifiedFiles(root: string, maxFiles = 10): string[] {
    const files: { rel: string; mtime: number }[] = [];

    function walk(dir: string): void {
        try {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) { continue; }
                const full = path.join(dir, e.name);
                if (e.isDirectory()) { walk(full); continue; }
                try {
                    const { mtimeMs } = fs.statSync(full);
                    files.push({ rel: path.relative(root, full), mtime: mtimeMs });
                } catch { /* skip */ }
            }
        } catch { /* skip */ }
    }

    walk(root);
    return files
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, maxFiles)
        .map((f) => f.rel);
}

// ── Full workspace summary (used as a tool result) ────────────────────────────

export function buildWorkspaceSummary(root: string): string {
    const type = detectProjectType(root);
    const tree = buildFileTree(root, 3);
    const keyFiles = getKeyFilesSummary(root);
    const recent = getRecentlyModifiedFiles(root, 8);

    return [
        `Workspace: ${path.basename(root)}`,
        `Type: ${type}`,
        '',
        '── File tree ──',
        tree,
        '',
        '── Key files ──',
        keyFiles,
        '',
        `── Recently modified (top ${recent.length}) ──`,
        recent.map((f) => `  ${f}`).join('\n') || '  (none)',
    ].join('\n');
}
