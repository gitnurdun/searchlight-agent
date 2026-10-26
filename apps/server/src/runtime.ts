import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AppConfig } from '../../../packages/search-core/src/types.js';

const execFileAsync = promisify(execFile);

export async function findCommand(name: string): Promise<string | undefined> {
  try { const result = await execFileAsync('where.exe', [name], { windowsHide: true }); return result.stdout.trim().split(/\r?\n/)[0]; }
  catch { return undefined; }
}

export async function ensureOllama(config: AppConfig): Promise<{ reachable: boolean; started: boolean; error?: string }> {
  const ready = async () => {
    try { return (await fetch(`${config.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
  };
  if (await ready()) return { reachable: true, started: false };
  const executable = await findCommand('ollama');
  if (!executable) return { reachable: false, started: false, error: 'Ollama executable was not found.' };
  await fs.mkdir(config.dataDir, { recursive: true });
  const log = await fs.open(path.join(config.dataDir, 'ollama.log'), 'a');
  const url = new URL(config.ollamaUrl);
  const child = spawn(executable, ['serve'], {
    cwd: config.root, detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd],
    env: { ...process.env, OLLAMA_HOST: `${url.hostname}:${url.port || '11434'}`, OLLAMA_NUM_PARALLEL: '1' },
  });
  child.unref(); await log.close();
  for (let i = 0; i < 20; i++) { await new Promise((resolve) => setTimeout(resolve, 300)); if (await ready()) return { reachable: true, started: true }; }
  return { reachable: false, started: true, error: 'Ollama did not become ready. See .data/ollama.log.' };
}

export async function doctor(config: AppConfig): Promise<Record<string, unknown>> {
  const commands = ['ollama', 'rg', 'pdftotext', 'pandoc', 'qpdf', 'tesseract', 'yt-dlp', 'ffmpeg'];
  const tools = Object.fromEntries(await Promise.all(commands.map(async (name) => [name, await findCommand(name)])));
  let ollama: Record<string, unknown> = { reachable: false };
  try {
    const response = await fetch(`${config.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    const data = await response.json() as { models?: Array<{ name: string; size: number }> };
    ollama = { reachable: response.ok, models: (data.models ?? []).map((model) => ({ name: model.name, sizeGB: Math.round(model.size / 1e8) / 10 })) };
  } catch (error) { ollama = { reachable: false, error: error instanceof Error ? error.message : String(error) }; }
  return {
    node: process.version, platform: process.platform, projectRoot: config.root, dataDirectory: config.dataDir,
    bind: `${config.host}:${config.port}`, chatModel: config.chatModel, embeddingModel: config.embeddingModel,
    edge: await fs.access('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe').then(() => true).catch(() => false),
    tools, ollama,
  };
}
