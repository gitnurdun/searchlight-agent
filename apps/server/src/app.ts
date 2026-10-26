import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { z } from 'zod';
import { loadConfig, SearchEngine, Store, type AppConfig, type SearchRequest } from '../../../packages/search-core/src/index.js';
import { doctor } from './runtime.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from '../../../packages/mcp/src/server.js';

const searchSchema = z.object({
  query: z.string().trim().min(1).max(2000), mode: z.enum(['web', 'local']), depth: z.enum(['quick', 'deep']).default('quick'),
  corpusIds: z.array(z.string().uuid()).max(20).optional(), filters: z.object({ domains: z.array(z.string()).max(20).optional(), dateFrom: z.string().optional(), dateTo: z.string().optional() }).optional(),
});

export async function createApp(config: AppConfig = loadConfig()) {
  const app = Fastify({ logger: { level: 'info', redact: ['req.headers.x-search-agent-token', 'req.headers.authorization'] }, bodyLimit: 2 * 1024 * 1024 });
  const store = new Store(config); const engine = new SearchEngine(config, store);
  await app.register(cors, { origin: (origin, callback) => callback(null, !origin || /^http:\/\/(127\.0\.0\.1|localhost):(4321|5173)$/.test(origin)), methods: ['GET', 'POST', 'DELETE'] });
  await app.register(swagger, { openapi: { info: { title: 'Local Qwen Search Agent', version: '1.0.0', description: 'Local-only web and file research API' }, servers: [{ url: `http://${config.host}:${config.port}` }] } });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/') || request.url.startsWith('/api/v1/session') || request.url.startsWith('/api/v1/health')) return;
    const candidate = String(request.headers['x-search-agent-token'] ?? '');
    const expected = Buffer.from(config.token); const actual = Buffer.from(candidate);
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return reply.code(401).send({ error: 'Local session token required.' });
  });

  app.get('/api/v1/session', async (request, reply) => {
    const ip = request.ip; if (!['127.0.0.1', '::1'].includes(ip)) return reply.code(403).send({ error: 'Loopback only.' });
    return { token: config.token };
  });
  app.get('/api/v1/health', async () => ({ ok: true, version: '1.0.0', now: new Date().toISOString() }));
  app.get('/api/v1/doctor', async () => doctor(config));

  app.post('/api/v1/searches', { schema: { tags: ['Search'], summary: 'Start a web or local search' } }, async (request, reply) => {
    const parsed = searchSchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
    const job = engine.start(parsed.data as SearchRequest); return reply.code(202).send(job);
  });
  app.get('/api/v1/searches/:id', async (request, reply) => {
    const job = store.getJob((request.params as { id: string }).id); return job ?? reply.code(404).send({ error: 'Search not found.' });
  });
  app.get('/api/v1/searches/:id/events', async (request, reply) => {
    const id = (request.params as { id: string }).id; if (!store.getJob(id)) return reply.code(404).send({ error: 'Search not found.' });
    reply.hijack(); const response = reply.raw;
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const send = (event: unknown) => response.write(`data: ${JSON.stringify(event)}\n\n`);
    for (const event of store.getEvents(id)) send(event);
    const current = store.getJob(id); if (current?.status === 'completed' || current?.status === 'failed') { response.end(); return; }
    const unsubscribe = engine.subscribe(id, (event) => { send(event); if (event.phase === 'done' || event.phase === 'error') { unsubscribe(); response.end(); } });
    request.raw.on('close', unsubscribe);
  });

  app.post('/api/v1/chats', async (request, reply) => {
    const mode = z.object({ mode: z.enum(['web', 'local']) }).safeParse(request.body); if (!mode.success) return reply.code(400).send({ error: mode.error.issues });
    const id = crypto.randomUUID(); store.createChat(id, mode.data.mode); return reply.code(201).send({ id, mode: mode.data.mode });
  });
  app.post('/api/v1/chats/:id/messages', async (request, reply) => {
    const parsed = searchSchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
    const chatId = (request.params as { id: string }).id; const job = engine.start(parsed.data as SearchRequest); store.addMessage(chatId, 'user', parsed.data.query, job.id);
    const unsubscribe = engine.subscribe(job.id, (event) => { if (event.phase === 'done') { const result = store.getJob(job.id)?.result; if (result) store.addMessage(chatId, 'assistant', result.answer, job.id); unsubscribe(); } });
    return reply.code(202).send(job);
  });

  app.get('/api/v1/corpora', async () => engine.store.listCorpora());
  app.post('/api/v1/corpora', async (request, reply) => {
    const parsed = z.object({ path: z.string().min(1).max(2000) }).safeParse(request.body); if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
    try { return reply.code(201).send(await engine.local.register(parsed.data.path)); } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.get('/api/v1/corpora/:id', async (request, reply) => engine.store.getCorpus((request.params as { id: string }).id) ?? reply.code(404).send({ error: 'Corpus not found.' }));
  app.post('/api/v1/corpora/:id/index', async (request, reply) => {
    const id = (request.params as { id: string }).id; if (!engine.store.getCorpus(id)) return reply.code(404).send({ error: 'Corpus not found.' });
    setImmediate(() => void engine.local.index(id).catch((error) => {
      const corpus = engine.store.getCorpus(id); if (corpus) { corpus.status = 'error'; corpus.error = error instanceof Error ? error.message : String(error); engine.store.updateCorpus(corpus); }
    }));
    return reply.code(202).send({ id, status: 'indexing' });
  });
  app.delete('/api/v1/corpora/:id', async (request, reply) => { engine.store.deleteCorpus((request.params as { id: string }).id); return reply.code(204).send(); });

  app.post('/api/v1/media/inspect', async (request, reply) => {
    const parsed = z.object({ url: z.string().url().max(4000) }).safeParse(request.body); if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
    try { return await engine.media.inspect(parsed.data.url); } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.post('/api/v1/media/download', async (request, reply) => {
    const parsed = z.object({ url: z.string().url().max(4000), filename: z.string().max(180).optional(), useYtDlp: z.boolean().optional() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
    try { return await engine.media.download(parsed.data); } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
  });

  const mcpServer = createMcpServer(engine);
  const mcpTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await mcpServer.connect(mcpTransport);
  app.all('/mcp', async (request, reply) => {
    const candidate = String(request.headers['x-search-agent-token'] ?? '');
    const expected = Buffer.from(config.token); const actual = Buffer.from(candidate);
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return reply.code(401).send({ error: 'Local session token required.' });
    reply.hijack(); await mcpTransport.handleRequest(request.raw, reply.raw, request.body);
  });
  app.post('/api/v1/shutdown', async (_request, reply) => { await reply.send({ ok: true }); setTimeout(() => process.kill(process.pid, 'SIGTERM'), 100); });

  const webRoot = path.join(config.root, 'dist', 'web');
  if (fs.existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot, wildcard: false });
    app.get('/*', async (_request, reply) => reply.sendFile('index.html'));
  } else app.get('/', async (_request, reply) => reply.type('text/plain').send('Web UI is not built. Run npm run build:web.'));

  app.addHook('onClose', async () => { await mcpServer.close(); store.close(); });
  return { app, engine, store };
}
