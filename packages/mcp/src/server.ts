import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SearchEngine } from '../../search-core/src/engine.js';
import type { SearchRequest } from '../../search-core/src/types.js';

async function waitFor(engine: SearchEngine, request: SearchRequest): Promise<any> {
  const job = engine.start(request); const deadline = Date.now() + (request.depth === 'deep' ? 140_000 : 60_000);
  while (Date.now() < deadline) {
    const current = engine.store.getJob(job.id);
    if (current?.status === 'completed') return current.result;
    if (current?.status === 'failed') throw new Error(current.error ?? 'Search failed.');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { jobId: job.id, status: 'running', note: 'Use get_search_status to continue polling.' };
}

const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], structuredContent: typeof value === 'object' && value ? value as Record<string, unknown> : undefined });

export function createMcpServer(engine: SearchEngine): McpServer {
  const server = new McpServer({ name: 'local-qwen-search-agent', version: '1.0.0' });
  const searchInput = { query: z.string().min(1).max(2000), depth: z.enum(['quick', 'deep']).default('quick') };
  server.registerTool('search_web', { description: 'Search public web sources and return ranked evidence.', inputSchema: searchInput }, async ({ query, depth }) => {
    const value = await waitFor(engine, { query, mode: 'web', depth }); return result({ results: value.results, warnings: value.warnings, sourceStatuses: value.sourceStatuses });
  });
  server.registerTool('answer_web', { description: 'Research a web question and return an evidence-bound answer with citations.', inputSchema: searchInput }, async ({ query, depth }) => result(await waitFor(engine, { query, mode: 'web', depth })));
  server.registerTool('search_local', { description: 'Search indexed local folders and return ranked passages.', inputSchema: { ...searchInput, corpusIds: z.array(z.string().uuid()).optional() } }, async ({ query, depth, corpusIds }) => {
    const value = await waitFor(engine, { query, mode: 'local', depth, corpusIds }); return result({ results: value.results, warnings: value.warnings });
  });
  server.registerTool('answer_local', { description: 'Answer a question from indexed local files with file and page citations.', inputSchema: { ...searchInput, corpusIds: z.array(z.string().uuid()).optional() } }, async ({ query, depth, corpusIds }) => result(await waitFor(engine, { query, mode: 'local', depth, corpusIds })));
  server.registerTool('list_corpora', { description: 'List local folder indexes.', inputSchema: {} }, async () => result(engine.store.listCorpora()));
  server.registerTool('index_folder', { description: 'Register and index a permitted local folder. Disabled unless allowAgentIndexing is enabled.', inputSchema: { path: z.string().min(1) } }, async ({ path }) => {
    if (!engine.config.allowAgentIndexing) throw new Error('Agent indexing is disabled in config.json.');
    const corpus = await engine.local.register(path); return result(await engine.local.index(corpus.id));
  });
  server.registerTool('inspect_media', { description: 'Inspect a public URL for images, video and audio candidates.', inputSchema: { url: z.string().url() } }, async ({ url }) => result(await engine.media.inspect(url)));
  server.registerTool('download_media', { description: 'Download authorized public media. Disabled unless allowAgentDownloads is enabled.', inputSchema: { url: z.string().url(), useYtDlp: z.boolean().default(false), filename: z.string().optional() } }, async (input) => {
    if (!engine.config.allowAgentDownloads) throw new Error('Agent downloads are disabled in config.json.'); return result(await engine.media.download(input));
  });
  server.registerTool('get_search_status', { description: 'Read the status or result of a search job.', inputSchema: { id: z.string().uuid() } }, async ({ id }) => result(engine.store.getJob(id) ?? { error: 'Search not found.' }));
  return server;
}
