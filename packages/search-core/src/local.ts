import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AppConfig, Corpus, SearchResultItem } from './types.js';
import { Store } from './store.js';
import { OllamaClient } from './ollama.js';
import { chunkText, clip, cosine, lexicalScore, normalizeText, sha256 } from './text.js';
import { isExcludedName, resolveAllowedPath } from './security.js';
import { runProcess } from './process.js';

const execFileAsync = promisify(execFile);
const textExtensions = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.yaml', '.yml', '.xml', '.html', '.htm', '.log', '.ini', '.toml', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.py', '.java', '.go', '.rs', '.c', '.cpp', '.h', '.hpp', '.sh', '.ps1', '.sql', '.rst', '.tex']);
const pandocExtensions = new Set(['.epub', '.docx', '.odt', '.rtf']);

async function commandExists(name: string): Promise<boolean> {
  try { await execFileAsync('where.exe', [name], { windowsHide: true }); return true; } catch { return false; }
}

async function extractPdf(file: string): Promise<Array<{ text: string; locator: string }>> {
  if (!await commandExists('pdftotext')) throw new Error('pdftotext is not installed.');
  const result = await runProcess('pdftotext', ['-enc', 'UTF-8', '-layout', file, '-'], { timeoutMs: 120_000, maxBytes: 50 * 1024 * 1024 });
  if (result.code !== 0) throw new Error(`pdftotext failed: ${clip(result.stderr, 300)}`);
  return result.stdout.toString('utf8').split('\f').map((text, index) => ({ text: normalizeText(text), locator: `page ${index + 1}` })).filter((row) => row.text);
}

async function extractPandoc(file: string): Promise<string> {
  if (!await commandExists('pandoc')) throw new Error('Pandoc is not installed.');
  const result = await runProcess('pandoc', [file, '-t', 'plain', '--wrap=none'], { timeoutMs: 120_000, maxBytes: 50 * 1024 * 1024 });
  if (result.code !== 0) throw new Error(`Pandoc failed: ${clip(result.stderr, 300)}`);
  return normalizeText(result.stdout.toString('utf8'));
}

async function extractOcr(file: string): Promise<string> {
  if (!await commandExists('tesseract')) throw new Error('OCR requires optional Tesseract.');
  const result = await runProcess('tesseract', [file, 'stdout', '-l', 'eng+chi_sim'], { timeoutMs: 180_000, maxBytes: 30 * 1024 * 1024 });
  if (result.code !== 0) throw new Error(`Tesseract failed: ${clip(result.stderr, 300)}`);
  return normalizeText(result.stdout.toString('utf8'));
}

export async function extractLocalFile(file: string): Promise<{ title: string; sourceType: string; chunks: Array<{ ordinal: number; locator?: string; text: string }>; contentHash: string }> {
  const ext = path.extname(file).toLowerCase();
  const stat = await fs.stat(file);
  if (stat.size > 100 * 1024 * 1024) throw new Error('File exceeds the 100 MB indexing limit.');
  let chunks: Array<{ ordinal: number; locator?: string; text: string }>;
  if (ext === '.pdf') {
    const pages = await extractPdf(file);
    chunks = pages.flatMap((page) => chunkText(page.text).map((chunk) => ({ ...chunk, locator: page.locator })));
  } else if (pandocExtensions.has(ext)) {
    chunks = chunkText(await extractPandoc(file));
  } else if (['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.webp'].includes(ext)) {
    chunks = chunkText(await extractOcr(file)).map((chunk) => ({ ...chunk, locator: 'OCR' }));
  } else if (textExtensions.has(ext)) {
    const buffer = await fs.readFile(file);
    if (buffer.includes(0)) throw new Error('Binary file is not a supported document.');
    const text = normalizeText(buffer.toString('utf8'));
    chunks = chunkText(text).map((chunk) => {
      const before = text.indexOf(chunk.text.slice(0, 80));
      const line = before < 0 ? undefined : text.slice(0, before).split('\n').length;
      return { ...chunk, locator: line ? `line ${line}` : undefined };
    });
  } else throw new Error(`Unsupported file type: ${ext || 'none'}`);
  if (!chunks.length) throw new Error('No searchable text was extracted.');
  return { title: path.basename(file), sourceType: ext.slice(1) || 'file', chunks, contentHash: sha256(chunks.map((chunk) => chunk.text).join('\n')) };
}

async function* walk(root: string, depth = 0): AsyncGenerator<string> {
  if (depth > 20) return;
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (isExcludedName(entry.name) || entry.isSymbolicLink()) continue;
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) yield* walk(target, depth + 1);
    else if (entry.isFile()) yield target;
  }
}

export class LocalIndex {
  constructor(private readonly config: AppConfig, private readonly store: Store, private readonly ollama: OllamaClient) {}

  async register(folder: string): Promise<Corpus> {
    const rootPath = await resolveAllowedPath(this.config, folder);
    if (!(await fs.stat(rootPath)).isDirectory()) throw new Error('Corpus path must be a directory.');
    const existing = this.store.listCorpora().find((row) => row.rootPath.toLowerCase() === rootPath.toLowerCase());
    if (existing) return existing;
    const corpus: Corpus = { id: crypto.randomUUID(), name: path.basename(rootPath), rootPath, status: 'new', fileCount: 0, chunkCount: 0 };
    this.store.createCorpus(corpus);
    return corpus;
  }

  async index(corpusId: string, onProgress: (message: string, data?: unknown) => void = () => {}): Promise<Corpus> {
    const corpus = this.store.getCorpus(corpusId);
    if (!corpus) throw new Error('Corpus not found.');
    corpus.status = 'indexing'; corpus.error = undefined; this.store.updateCorpus(corpus);
    const files: string[] = [];
    for await (const file of walk(corpus.rootPath)) {
      const ext = path.extname(file).toLowerCase();
      if (textExtensions.has(ext) || pandocExtensions.has(ext) || ['.pdf', '.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.webp'].includes(ext)) files.push(file);
      if (files.length >= 10_000) break;
    }
    let chunks = 0; let processed = 0; let embeddingAvailable = await this.ollama.hasModel(this.config.embeddingModel);
    for (const file of files) {
      try {
        const stat = await fs.stat(file);
        const prior = this.store.documentFingerprint(corpusId, file);
        if (prior && prior.size === stat.size && prior.mtimeMs === stat.mtimeMs) { processed++; continue; }
        const extracted = await extractLocalFile(file);
        let vectors: Float32Array[] = [];
        if (embeddingAvailable) {
          try {
            for (let i = 0; i < extracted.chunks.length; i += 16) vectors.push(...await this.ollama.embed(extracted.chunks.slice(i, i + 16).map((chunk) => chunk.text)));
          } catch { embeddingAvailable = false; vectors = []; }
        }
        this.store.replaceDocument({
          id: crypto.randomUUID(), corpusId, path: file, title: extracted.title, sourceType: extracted.sourceType,
          size: stat.size, mtimeMs: stat.mtimeMs, contentHash: extracted.contentHash,
          chunks: extracted.chunks.map((chunk, i) => ({ ...chunk, embedding: vectors[i] })),
        });
        chunks += extracted.chunks.length;
      } catch (error) {
        onProgress(`Skipped ${path.basename(file)}`, { error: error instanceof Error ? error.message : String(error) });
      }
      processed++;
      if (processed % 10 === 0 || processed === files.length) onProgress(`Indexed ${processed} of ${files.length} files.`, { processed, total: files.length });
    }
    this.store.removeMissingDocuments(corpusId, files);
    const counts = this.store.db.prepare('SELECT COUNT(DISTINCT document_id) files, COUNT(*) chunks FROM chunks WHERE corpus_id=?').get(corpusId) as Record<string, unknown>;
    corpus.status = 'ready'; corpus.fileCount = Number(counts.files); corpus.chunkCount = Number(counts.chunks); corpus.indexedAt = new Date().toISOString();
    this.store.updateCorpus(corpus);
    return corpus;
  }

  async search(query: string, corpusIds: string[], limit = 12): Promise<{ results: SearchResultItem[]; warnings: string[] }> {
    const ids = corpusIds.length ? corpusIds : this.store.listCorpora().filter((row) => row.status === 'ready').map((row) => row.id);
    const warnings: string[] = [];
    const fts = this.store.searchFts(query, ids, 60);
    const combined = new Map<number, SearchResultItem>();
    for (const row of fts) {
      const id = Number(row.id);
      combined.set(id, {
        id: `L${id}`, title: String(row.title), path: String(row.path), locator: row.locator ? String(row.locator) : undefined,
        excerpt: clip(row.text, 1000), sourceType: String(row.source_type), score: Math.max(0.05, 0.7 + lexicalScore(query, String(row.text)) * 0.3),
        contentHash: sha256(String(row.text)),
      });
    }
    if (await this.ollama.hasModel(this.config.embeddingModel)) {
      try {
        const [queryVector] = await this.ollama.embed([query]);
        if (queryVector) {
          for (const row of this.store.allEmbeddedChunks(ids)) {
            const buffer = row.embedding as Buffer;
            const vector = new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 4));
            const similarity = cosine(queryVector, vector);
            if (similarity < 0.25) continue;
            const id = Number(row.id); const prior = combined.get(id);
            const score = prior ? Math.min(1, prior.score * 0.55 + similarity * 0.45) : similarity * 0.85;
            combined.set(id, prior ? { ...prior, score } : {
              id: `L${id}`, title: String(row.title), path: String(row.path), locator: row.locator ? String(row.locator) : undefined,
              excerpt: clip(row.text, 1000), sourceType: String(row.source_type), score, contentHash: sha256(String(row.text)),
            });
          }
        }
      } catch { warnings.push('Semantic embeddings were unavailable; results use lexical retrieval only.'); }
    } else warnings.push('Embedding model is not installed; results use lexical retrieval only.');
    return { results: [...combined.values()].sort((a, b) => b.score - a.score).slice(0, limit), warnings };
  }
}
