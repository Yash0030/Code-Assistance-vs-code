import * as http from 'http';
import * as https from 'https';
import * as vscode from 'vscode';
import { getConfig, parseBaseUrl } from './config';
import { logInfo, logError } from './logger';

// ── Shared types ──────────────────────────────────────────────────────────────

export interface OllamaMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    tool_calls?: OllamaToolCall[];
}

export interface OllamaToolCall {
    function: { name: string; arguments: Record<string, unknown> };
}

export interface StreamResult {
    content: string;
    toolCalls: OllamaToolCall[];
}

/** Shape of one NDJSON line from Ollama's /api/chat stream. */
interface ChatChunk {
    message?: { content?: string; tool_calls?: OllamaToolCall[] };
    done?: boolean;
    error?: string;
}

// ── Endpoint helpers ──────────────────────────────────────────────────────────

function getEndpoint(): { hostname: string; port: number; isHttps: boolean } {
    const { baseUrl } = getConfig();
    const { hostname, port, protocol } = parseBaseUrl(baseUrl);
    return { hostname, port, isHttps: protocol === 'https:' };
}

function makeRequest(
    options: http.RequestOptions,
    callback: (res: http.IncomingMessage) => void
): http.ClientRequest {
    const { isHttps } = getEndpoint();
    return isHttps
        ? https.request(options, callback)
        : http.request(options, callback);
}

/**
 * Context window sent to Ollama. Ollama's own default is only ~2-4k tokens, which is far
 * too small for the tool definitions + system prompt + conversation, so the model silently
 * "forgets" its tools. Override with the `ollamaAgent.numCtx` setting (8192 if your GPU is small).
 */
function getNumCtx(): number {
    const v = vscode.workspace.getConfiguration('ollamaAgent').get<number>('numCtx', 16384);
    return Number.isFinite(v) && v >= 1024 ? Math.floor(v) : 16384;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

export function rawGet(
    urlPath: string,
    timeoutMs = 5000
): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const { hostname, port } = getEndpoint();
        const req = makeRequest(
            { hostname, port, path: urlPath, method: 'GET', timeout: timeoutMs },
            (res) => {
                let body = '';
                res.on('data', (c: Buffer) => (body += c.toString()));
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
            }
        );
        req.on('timeout', () => { req.destroy(); reject(new Error('Connection timed out')); });
        req.on('error', reject);
        req.end();
    });
}

/** Sentinel thrown when the model doesn't support Ollama native tool calling. */
export class ToolsNotSupportedError extends Error {
    constructor(model: string) {
        super(`Model "${model}" does not support native tool calling. Switched to text-mode.`);
        this.name = 'ToolsNotSupportedError';
    }
}

export function streamChatRequest(
    model: string,
    messages: OllamaMessage[],
    tools: unknown[],
    onToken: (t: string) => void,
    stopRef: { stop: boolean }
): Promise<StreamResult> {
    return new Promise((resolve, reject) => {
        const { hostname, port } = getEndpoint();
        const cfg = getConfig();
        const numCtx = getNumCtx();
        const payload: Record<string, unknown> = {
            model,
            messages,
            stream: true,
            keep_alive: '30m', // keep the model loaded between turns
            options: {
                num_ctx: numCtx,
                temperature: cfg.temperature,
            },
        };
        // Only include tools if non-empty (some models reject the field when empty)
        if (tools.length) { payload.tools = tools; }

        const body = JSON.stringify(payload);
        logInfo(`POST /api/chat  model=${model}  msgs=${messages.length}  num_ctx=${numCtx}`);

        let fullContent = '';
        const toolCalls: OllamaToolCall[] = [];
        let settled = false;

        const succeed = () => {
            if (settled) { return; }
            settled = true;
            resolve({ content: fullContent, toolCalls });
        };
        const fail = (err: Error) => {
            if (settled) { return; }
            settled = true;
            reject(err);
        };

        const req = makeRequest(
            {
                hostname, port, path: '/api/chat', method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                },
            },
            (res) => {
                if (res.statusCode !== 200) {
                    let e = '';
                    res.on('data', (c: Buffer) => (e += c.toString()));
                    res.on('end', () => {
                        // Detect the "model does not support tools" 400 specifically
                        if (res.statusCode === 400 && e.toLowerCase().includes('does not support tools')) {
                            fail(new ToolsNotSupportedError(model));
                        } else {
                            fail(new Error(`HTTP ${res.statusCode}: ${e}`));
                        }
                    });
                    return;
                }

                let buf = '';

                const handleLine = (line: string): void => {
                    if (!line.trim()) { return; }
                    let p: ChatChunk;
                    try { p = JSON.parse(line) as ChatChunk; } catch { return; /* skip malformed line */ }

                    // Ollama can report errors inside a 200 stream (e.g. out of memory while loading)
                    if (p.error) {
                        fail(new Error(String(p.error)));
                        req.destroy();
                        return;
                    }
                    if (p.message?.content) {
                        fullContent += p.message.content;
                        onToken(p.message.content);
                    }
                    if (p.message?.tool_calls?.length) {
                        // Append (don't overwrite): some models stream one call per chunk
                        toolCalls.push(...p.message.tool_calls);
                    }
                    if (p.done) {
                        logInfo(`Stream done — ${fullContent.length} chars, ${toolCalls.length} tool calls`);
                        succeed();
                    }
                };

                res.on('data', (chunk: Buffer) => {
                    if (stopRef.stop) {
                        // User pressed Stop: keep what we have instead of surfacing an "aborted" error.
                        succeed();
                        req.destroy();
                        return;
                    }
                    buf += chunk.toString();
                    const lines = buf.split('\n');
                    buf = lines.pop() ?? '';
                    for (const line of lines) { handleLine(line); }
                });

                res.on('end', () => {
                    handleLine(buf); // last line without trailing newline
                    succeed();
                });
                res.on('error', (err) => {
                    if (stopRef.stop) { succeed(); } else { fail(err); }
                });
            }
        );
        req.on('error', (err) => {
            if (stopRef.stop) { succeed(); return; }
            logError(`streamChatRequest: ${err.message}`);
            fail(err);
        });
        req.write(body);
        req.end();
    });
}

export async function fetchModels(): Promise<string[]> {
    try {
        const { status, body } = await rawGet('/api/tags');
        if (status !== 200) { logError(`/api/tags HTTP ${status}`); return []; }
        const parsed = JSON.parse(body) as { models?: { name: string }[] };
        const names = parsed.models?.map((m) => m.name) ?? [];
        logInfo(`Models: ${names.join(', ') || '(none)'}`);
        return names;
    } catch (err) {
        const e = err as NodeJS.ErrnoException;
        logError(`fetchModels: ${e.code ?? ''} ${e.message}`);
        return [];
    }
}