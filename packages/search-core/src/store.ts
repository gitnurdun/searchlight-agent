import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AppConfig, Corpus, NormalizedSearchResult, SearchEvent, SearchRequest, StoredJob } from './types.js';

type Row = Record<string, unknown>;

export class Store {
  readonly db: DatabaseSync;

  constructor(config: AppConfig) {
    fs.mkdirSync(config.dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(config.dataDir, 'search-agent.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, request_json TEXT NOT NULL, status TEXT NOT NULL,
        result_json TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS job_events (
        job_id TEXT NOT NULL, seq INTEGER NOT NULL, at TEXT NOT NULL, phase TEXT NOT NULL,
        message TEXT NOT NULL, data_json TEXT, PRIMARY KEY(job_id, seq),
        FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS corpora (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL UNIQUE, status TEXT NOT NULL,
        file_count INTEGER NOT NULL DEFAULT 0, chunk_count INTEGER NOT NULL DEFAULT 0,
        indexed_at TEXT, error TEXT
      );
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY, corpus_id TEXT NOT NULL, path TEXT NOT NULL, title TEXT NOT NULL,
        source_type TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms REAL NOT NULL, content_hash TEXT NOT NULL,
        indexed_at TEXT NOT NULL, error TEXT,
        UNIQUE(corpus_id, path), FOREIGN KEY(corpus_id) REFERENCES corpora(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL, corpus_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL, locator TEXT, text TEXT NOT NULL, embedding BLOB,
        FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE,
        FOREIGN KEY(corpus_id) REFERENCES corpora(id) ON DELETE CASCADE
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, content='chunks', content_rowid='id', tokenize='unicode61');
      CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
      END;
      CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
        INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
      END;
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY, mode TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, role TEXT NOT NULL,
        content TEXT NOT NULL, job_id TEXT, created_at TEXT NOT NULL,
        FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
      );
    `);
  }

  createJob(id: string, request: SearchRequest): StoredJob {
    const now = new Date().toISOString();
    this.db.prepare('INSERT INTO jobs VALUES (?, ?, ?, NULL, NULL, ?, ?)').run(id, JSON.stringify(request), 'queued', now, now);
    return { id, request, status: 'queued', createdAt: now, updatedAt: now };
  }

  updateJob(id: string, status: StoredJob['status'], result?: NormalizedSearchResult, error?: string): void {
    this.db.prepare('UPDATE jobs SET status=?, result_json=?, error=?, updated_at=? WHERE id=?')
      .run(status, result ? JSON.stringify(result) : null, error ?? null, new Date().toISOString(), id);
  }

  getJob(id: string): StoredJob | undefined {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as Row | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id), request: JSON.parse(String(row.request_json)) as SearchRequest,
      status: row.status as StoredJob['status'], createdAt: String(row.created_at), updatedAt: String(row.updated_at),
      result: row.result_json ? JSON.parse(String(row.result_json)) as NormalizedSearchResult : undefined,
      error: row.error ? String(row.error) : undefined,
    };
  }

  addEvent(jobId: string, event: SearchEvent): void {
    this.db.prepare('INSERT OR REPLACE INTO job_events VALUES (?, ?, ?, ?, ?, ?)')
      .run(jobId, event.seq, event.at, event.phase, event.message, event.data === undefined ? null : JSON.stringify(event.data));
  }

  getEvents(jobId: string, after = 0): SearchEvent[] {
    const rows = this.db.prepare('SELECT * FROM job_events WHERE job_id=? AND seq>? ORDER BY seq').all(jobId, after) as Row[];
    return rows.map((row) => ({
      seq: Number(row.seq), at: String(row.at), phase: String(row.phase), message: String(row.message),
      data: row.data_json ? JSON.parse(String(row.data_json)) : undefined,
    }));
  }

  createCorpus(corpus: Corpus): void {
    this.db.prepare('INSERT INTO corpora(id,name,root_path,status,file_count,chunk_count,indexed_at,error) VALUES(?,?,?,?,?,?,?,?)')
      .run(corpus.id, corpus.name, corpus.rootPath, corpus.status, corpus.fileCount, corpus.chunkCount, corpus.indexedAt ?? null, corpus.error ?? null);
  }

  updateCorpus(corpus: Corpus): void {
    this.db.prepare('UPDATE corpora SET name=?, root_path=?, status=?, file_count=?, chunk_count=?, indexed_at=?, error=? WHERE id=?')
      .run(corpus.name, corpus.rootPath, corpus.status, corpus.fileCount, corpus.chunkCount, corpus.indexedAt ?? null, corpus.error ?? null, corpus.id);
  }

  listCorpora(): Corpus[] {
    const rows = this.db.prepare('SELECT * FROM corpora ORDER BY name').all() as Row[];
    return rows.map((row) => ({
      id: String(row.id), name: String(row.name), rootPath: String(row.root_path), status: row.status as Corpus['status'],
      fileCount: Number(row.file_count), chunkCount: Number(row.chunk_count),
      indexedAt: row.indexed_at ? String(row.indexed_at) : undefined, error: row.error ? String(row.error) : undefined,
    }));
  }

  getCorpus(id: string): Corpus | undefined { return this.listCorpora().find((row) => row.id === id); }

  deleteCorpus(id: string): void { this.db.prepare('DELETE FROM corpora WHERE id=?').run(id); }

  replaceDocument(input: {
    id: string; corpusId: string; path: string; title: string; sourceType: string; size: number; mtimeMs: number;
    contentHash: string; chunks: Array<{ ordinal: number; locator?: string; text: string; embedding?: Float32Array }>;
  }): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM documents WHERE corpus_id=? AND path=?').run(input.corpusId, input.path);
      this.db.prepare('INSERT INTO documents VALUES(?,?,?,?,?,?,?,?,?,NULL)')
        .run(input.id, input.corpusId, input.path, input.title, input.sourceType, input.size, input.mtimeMs, input.contentHash, new Date().toISOString());
      const stmt = this.db.prepare('INSERT INTO chunks(document_id,corpus_id,ordinal,locator,text,embedding) VALUES(?,?,?,?,?,?)');
      for (const chunk of input.chunks) {
        const embedding = chunk.embedding ? Buffer.from(chunk.embedding.buffer, chunk.embedding.byteOffset, chunk.embedding.byteLength) : null;
        stmt.run(input.id, input.corpusId, chunk.ordinal, chunk.locator ?? null, chunk.text, embedding);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK'); throw error;
    }
  }

  removeMissingDocuments(corpusId: string, presentPaths: string[]): void {
    const rows = this.db.prepare('SELECT path FROM documents WHERE corpus_id=?').all(corpusId) as Row[];
    const present = new Set(presentPaths.map((p) => p.toLocaleLowerCase()));
    const stmt = this.db.prepare('DELETE FROM documents WHERE corpus_id=? AND path=?');
    for (const row of rows) if (!present.has(String(row.path).toLocaleLowerCase())) stmt.run(corpusId, String(row.path));
  }

  documentFingerprint(corpusId: string, file: string): { size: number; mtimeMs: number; contentHash: string } | undefined {
    const row = this.db.prepare('SELECT size,mtime_ms,content_hash FROM documents WHERE corpus_id=? AND path=?').get(corpusId, file) as Row | undefined;
    return row ? { size: Number(row.size), mtimeMs: Number(row.mtime_ms), contentHash: String(row.content_hash) } : undefined;
  }

  searchFts(query: string, corpusIds: string[], limit = 40): Row[] {
    const words = query.match(/[\p{L}\p{N}_-]{2,}/gu)?.slice(0, 12) ?? [];
    if (!words.length) return [];
    const match = words.map((word) => `"${word.replaceAll('"', '""')}"`).join(' OR ');
    const where = corpusIds.length ? `AND c.corpus_id IN (${corpusIds.map(() => '?').join(',')})` : '';
    return this.db.prepare(`
      SELECT c.id,c.text,c.locator,c.embedding,d.path,d.title,d.source_type,bm25(chunks_fts) AS rank
      FROM chunks_fts JOIN chunks c ON c.id=chunks_fts.rowid JOIN documents d ON d.id=c.document_id
      WHERE chunks_fts MATCH ? ${where} ORDER BY rank LIMIT ?
    `).all(match, ...corpusIds, limit) as Row[];
  }

  allEmbeddedChunks(corpusIds: string[]): Row[] {
    const where = corpusIds.length ? `WHERE c.corpus_id IN (${corpusIds.map(() => '?').join(',')}) AND c.embedding IS NOT NULL` : 'WHERE c.embedding IS NOT NULL';
    return this.db.prepare(`SELECT c.id,c.text,c.locator,c.embedding,d.path,d.title,d.source_type FROM chunks c JOIN documents d ON d.id=c.document_id ${where}`)
      .all(...corpusIds) as Row[];
  }

  createChat(id: string, mode: string): void {
    const now = new Date().toISOString();
    this.db.prepare('INSERT INTO chats VALUES(?,?,?,?)').run(id, mode, now, now);
  }

  addMessage(chatId: string, role: string, content: string, jobId?: string): void {
    this.db.prepare('INSERT INTO messages(chat_id,role,content,job_id,created_at) VALUES(?,?,?,?,?)')
      .run(chatId, role, content, jobId ?? null, new Date().toISOString());
    this.db.prepare('UPDATE chats SET updated_at=? WHERE id=?').run(new Date().toISOString(), chatId);
  }

  close(): void { this.db.close(); }
}
