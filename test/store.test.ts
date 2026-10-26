import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Store, type AppConfig } from '../packages/search-core/src/index.js';

test('persists jobs and performs FTS5 retrieval', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'search-agent-test-'));
  const config: AppConfig = { root, dataDir: path.join(root, '.data'), host: '127.0.0.1', port: 4321, ollamaUrl: 'http://127.0.0.1:11434', chatModel: 'qwen3:1.7b', embeddingModel: 'qwen3-embedding:0.6b', downloadDirectory: path.join(root, 'downloads'), externalSearxngUrl: '', allowAgentIndexing: false, allowAgentDownloads: false, readRoots: [root], token: 'a'.repeat(64) };
  const store = new Store(config);
  store.createCorpus({ id: 'c1', name: 'books', rootPath: root, status: 'ready', fileCount: 1, chunkCount: 1 });
  store.replaceDocument({ id: 'd1', corpusId: 'c1', path: path.join(root, 'book.txt'), title: 'Book', sourceType: 'txt', size: 20, mtimeMs: 1, contentHash: 'hash', chunks: [{ ordinal: 0, locator: 'line 1', text: 'DeepSeek released a new reasoning model for research.' }] });
  const hits = store.searchFts('DeepSeek reasoning', ['c1']);
  assert.equal(hits.length, 1);
  const job = store.createJob('j1', { query: 'test', mode: 'local' });
  assert.equal(store.getJob(job.id)?.status, 'queued');
  store.close(); fs.rmSync(root, { recursive: true, force: true });
});
