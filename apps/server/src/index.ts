import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../../../packages/search-core/src/index.js';
import { createApp } from './app.js';
import { ensureOllama } from './runtime.js';

const config = loadConfig(process.cwd());
await fs.mkdir(config.dataDir, { recursive: true });
const ollama = await ensureOllama(config);
if (!ollama.reachable) console.warn(`Ollama warning: ${ollama.error}`);
const { app } = await createApp(config);
await app.listen({ host: config.host, port: config.port });
await fs.writeFile(path.join(config.dataDir, 'server.json'), JSON.stringify({ pid: process.pid, port: config.port, token: config.token, startedAt: new Date().toISOString() }, null, 2));
console.log(`Search Agent is ready at http://${config.host}:${config.port}`);

const shutdown = async () => { try { await app.close(); } finally { await fs.rm(path.join(config.dataDir, 'server.json'), { force: true }); process.exit(0); } };
process.on('SIGINT', () => void shutdown()); process.on('SIGTERM', () => void shutdown());
