import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from './types.js';

function readJson(file: string): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>; }
  catch { return {}; }
}

function ensureToken(dataDir: string): string {
  const file = path.join(dataDir, 'session-token');
  try {
    const token = fs.readFileSync(file, 'utf8').trim();
    if (token.length >= 32) return token;
  } catch {}
  fs.mkdirSync(dataDir, { recursive: true });
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, token, { encoding: 'utf8', mode: 0o600 });
  return token;
}

export function loadConfig(root = process.cwd()): AppConfig {
  const raw = { ...readJson(path.join(root, 'config.example.json')), ...readJson(path.join(root, 'config.json')) };
  const dataDir = path.resolve(root, '.data');
  const host = String(raw.host ?? '127.0.0.1');
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('Search Agent must bind to loopback only.');
  const ollamaUrl = String(raw.ollamaUrl ?? 'http://127.0.0.1:11434');
  const parsed = new URL(ollamaUrl);
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
    throw new Error('Ollama URL must be a local HTTP endpoint.');
  }
  const readRoots = Array.isArray(raw.readRoots) ? raw.readRoots.map(String).map((p) => path.resolve(p)) : [];
  return {
    root,
    dataDir,
    host,
    port: Number(raw.port ?? 4321),
    ollamaUrl,
    chatModel: String(raw.chatModel ?? 'qwen3:1.7b'),
    embeddingModel: String(raw.embeddingModel ?? 'qwen3-embedding:0.6b'),
    downloadDirectory: path.resolve(String(raw.downloadDirectory ?? path.join(dataDir, 'downloads'))),
    externalSearxngUrl: String(raw.externalSearxngUrl ?? ''),
    allowAgentIndexing: raw.allowAgentIndexing === true,
    allowAgentDownloads: raw.allowAgentDownloads === true,
    readRoots,
    token: ensureToken(dataDir),
  };
}
