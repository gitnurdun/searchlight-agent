import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { AppConfig } from '../packages/search-core/src/index.js';
import { createApp } from '../apps/server/src/app.js';

test('REST contract indexes and searches a local fixture', async () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.test-runtime-api-'));
  const library = path.join(root, 'library'); fs.mkdirSync(library); fs.writeFileSync(path.join(library, 'note.md'), '# Note\n\nThe jade lighthouse protocol is the unique acceptance phrase.');
  const config: AppConfig = { root, dataDir: path.join(root, '.data'), host: '127.0.0.1', port: 4321, ollamaUrl: 'http://127.0.0.1:9', chatModel: 'missing', embeddingModel: 'missing', downloadDirectory: path.join(root, 'downloads'), externalSearxngUrl: '', allowAgentIndexing: false, allowAgentDownloads: false, readRoots: [root], token: 'b'.repeat(64) };
  const { app } = await createApp(config); const headers = { 'x-search-agent-token': config.token };
  const health = await app.inject({ method: 'GET', url: '/api/v1/health' }); assert.equal(health.statusCode, 200);
  const unauthorized = await app.inject({ method: 'GET', url: '/api/v1/corpora' }); assert.equal(unauthorized.statusCode, 401);
  const created = await app.inject({ method: 'POST', url: '/api/v1/corpora', headers, payload: { path: library } }); assert.equal(created.statusCode, 201, created.body);
  const corpus = created.json();
  const indexing = await app.inject({ method: 'POST', url: `/api/v1/corpora/${corpus.id}/index`, headers, payload: {} }); assert.equal(indexing.statusCode, 202);
  let status: any;
  for (let i = 0; i < 80; i++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    status = (await app.inject({ method: 'GET', url: `/api/v1/corpora/${corpus.id}`, headers })).json();
    if (status.status !== 'indexing') break;
  }
  assert.equal(status.status, 'ready'); assert.equal(status.fileCount, 1);
  const started = await app.inject({ method: 'POST', url: '/api/v1/searches', headers, payload: { query: 'jade lighthouse protocol', mode: 'local', corpusIds: [corpus.id] } }); assert.equal(started.statusCode, 202);
  const jobId = started.json().id; let job: any;
  for (let i = 0; i < 100; i++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    job = (await app.inject({ method: 'GET', url: `/api/v1/searches/${jobId}`, headers })).json();
    if (!['queued', 'running'].includes(job.status)) break;
  }
  assert.equal(job.status, 'completed'); assert.ok(job.result.results.length >= 1); assert.match(job.result.answer, /\[S1\]/);
  await app.close(); fs.rmSync(root, { recursive: true, force: true });
});
