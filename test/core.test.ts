import assert from 'node:assert/strict';
import test from 'node:test';
import { chunkText, cosine, normalizeText, safeFilename, isPrivateIp } from '../packages/search-core/src/index.js';
import { extractHtml } from '../packages/search-core/src/web.js';

test('normalizes and chunks multilingual text', () => {
  const text = normalizeText('ＡＢＣ\r\n\r\n你好世界\u200b');
  assert.equal(text, 'ABC\n\n你好世界');
  const chunks = chunkText(`${'first sentence. '.repeat(100)}\n\n${'第二部分。'.repeat(200)}`, 300, 30);
  assert.ok(chunks.length > 2);
  assert.equal(chunks[0]?.ordinal, 0);
});

test('cosine score is stable', () => {
  assert.equal(cosine(Float32Array.from([1, 0]), Float32Array.from([1, 0])), 1);
  assert.equal(cosine(Float32Array.from([1, 0]), Float32Array.from([0, 1])), 0);
});

test('blocks private network ranges', () => {
  for (const ip of ['127.0.0.1', '10.2.3.4', '192.168.1.9', '172.16.0.1', '::1', 'fe80::1']) assert.equal(isPrivateIp(ip), true);
  assert.equal(isPrivateIp('8.8.8.8'), false);
});

test('sanitizes Windows filenames', () => {
  assert.equal(safeFilename('bad:name?.jpg'), 'bad_name_.jpg');
  assert.equal(safeFilename('CON'), 'download');
});

test('extracts article content and removes unsafe chrome', () => {
  const document = extractHtml('<html><head><title>Example</title><meta property="article:published_time" content="2026-01-02"></head><body><nav>menu</nav><article><h1>Headline</h1><p>This is meaningful evidence about a subject and it should remain readable for extraction.</p><p>Another paragraph adds context for the result.</p></article><script>ignore()</script></body></html>', 'https://example.com/a');
  assert.equal(document.title, 'Example');
  assert.match(document.text, /meaningful evidence/);
  assert.doesNotMatch(document.text, /ignore/);
  assert.equal(document.sourceType, 'news');
});
