import * as http from 'http';
import * as https from 'https';
import * as vscode from 'vscode';
import { getConfig, parseBaseUrl } from './config';
import { logInfo, logWarn, logError } from './logger';

// ── Shared types ──────────────────────────────────────────────────────────────

export interface OllamaMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    tool_calls?: OllamaToolCall[];
    /** Name of the tool that produced this message (Ollama tool-role messages). */
    tool_name?: string;
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

const CHAT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

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
    stopRef: { stop: boolean },
    stopWhenToolReady?: (content: string, toolCalls: OllamaToolCall[]) => boolean,
    format?: unknown,
    onProgress?: (elapsedSeconds: number, receivedChars: number) => void,
    traceId = 'untracked'
): Promise<StreamResult> {
    return new Promise((resolve, reject) => {
        const requestStartedAt = Date.now();
        const requestId = `${traceId}/ollama-${requestStartedAt.toString(36)}`;
        const elapsed = (): string => `${((Date.now() - requestStartedAt) / 1000).toFixed(1)}s`;
        const trace = (message: string): void => logInfo(`[request ${requestId} +${elapsed()}] ${message}`);
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
        if (format) { payload.format = format; }

        const body = JSON.stringify(payload);
        trace(
            `Preparing POST /api/chat — model=${model}, messages=${messages.length}, ` +
            `num_ctx=${numCtx}, tools=${tools.length}, format=${format ? 'structured' : 'none'}, ` +
            `body=${Buffer.byteLength(body)} bytes, endpoint=${hostname}:${port}`
        );

        let fullContent = '';
        const toolCalls: OllamaToolCall[] = [];
        let settled = false;
        let bytesReceived = 0;
        let parsedLines = 0;
        let malformedLines = 0;
        let lastProgressBytes = 0;
        let partialLineChars = 0;
        let heartbeat: NodeJS.Timeout | undefined;
        const clearHeartbeat = (): void => {
            if (heartbeat) {
                clearInterval(heartbeat);
                heartbeat = undefined;
            }
        };

        const succeed = () => {
            if (settled) { return; }
            settled = true;
            clearHeartbeat();
            trace(
                `Request resolved — response_bytes=${bytesReceived}, ndjson_lines=${parsedLines}, ` +
                `malformed_lines=${malformedLines}, content_chars=${fullContent.length}, tool_calls=${toolCalls.length}`
            );
            resolve({ content: fullContent, toolCalls });
        };
        const fail = (err: Error) => {
            if (settled) { return; }
            settled = true;
            clearHeartbeat();
            logError(
                `[request ${requestId} +${elapsed()}] Request rejected — ${err.name}: ${err.message}; ` +
                `response_bytes=${bytesReceived}, ndjson_lines=${parsedLines}, content_chars=${fullContent.length}`
            );
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
                trace(`HTTP response received — status=${res.statusCode ?? 0}, content-type=${res.headers['content-type'] ?? '(none)'}`);
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
                trace('Streaming response accepted — waiting for NDJSON chunks');

                const handleLine = (line: string): void => {
                    if (!line.trim()) { return; }
                    let p: ChatChunk;
                    try {
                        p = JSON.parse(line) as ChatChunk;
                    } catch {
                        malformedLines++;
                        logWarn(`[request ${requestId} +${elapsed()}] Ignoring malformed NDJSON line (${line.length} chars)`);
                        return;
                    }
                    parsedLines++;

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
                        trace(`Tool-call chunk received — total tool_calls=${toolCalls.length}`);
                    }
                    if (!p.done && stopWhenToolReady?.(fullContent, toolCalls)) {
                        trace(`Stopping stream early — ${toolCalls.length ? 'native tool call ready' : 'text tool call ready'}`);
                        succeed();
                        req.destroy();
                        return;
                    }
                    if (p.done) {
                        trace(`Ollama marked stream done — content_chars=${fullContent.length}, tool_calls=${toolCalls.length}`);
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
                    bytesReceived += chunk.length;
                    buf += chunk.toString();
                    const lines = buf.split('\n');
                    buf = lines.pop() ?? '';
                    partialLineChars = buf.length;
                    for (const line of lines) { handleLine(line); }
                });

                res.on('end', () => {
                    trace(`Response stream ended — remaining_buffer=${buf.length} chars`);
                    handleLine(buf); // last line without trailing newline
                    succeed();
                });
                res.on('error', (err) => {
                    logError(`[request ${requestId} +${elapsed()}] Response stream error — ${err.message}`);
                    if (stopRef.stop) { succeed(); } else { fail(err); }
                });
            }
        );
        req.on('socket', (socket) => {
            if (socket.connecting) {
                trace('Socket assigned — connecting to Ollama');
                socket.once('connect', () => trace('TCP connection established'));
            } else {
                trace('Reusing established Ollama socket');
            }
        });
        req.on('finish', () => trace('HTTP request body sent'));
        req.on('close', () => {
            if (!settled) {
                trace(`HTTP request closed before completion — response_bytes=${bytesReceived}`);
            }
        });
        req.setTimeout(CHAT_IDLE_TIMEOUT_MS, () => {
            const error = new Error(`No response from Ollama for ${Math.round(CHAT_IDLE_TIMEOUT_MS / 1000)} seconds.`);
            fail(error);
            req.destroy();
        });
        heartbeat = setInterval(() => {
            const elapsedSeconds = Math.floor((Date.now() - requestStartedAt) / 1000);
            const newBytes = bytesReceived - lastProgressBytes;
            lastProgressBytes = bytesReceived;
            trace(
                `Still waiting — received_bytes=${bytesReceived} (+${newBytes}), ` +
                `ndjson_lines=${parsedLines}, partial_line_chars=${partialLineChars}, ` +
                `content_chars=${fullContent.length}, tool_calls=${toolCalls.length}`
            );
            onProgress?.(elapsedSeconds, fullContent.length);
        }, 15_000);
        req.on('error', (err) => {
            if (stopRef.stop) { succeed(); return; }
            fail(err);
        });
        trace('Sending HTTP request');
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