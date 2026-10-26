export type SearchMode = 'web' | 'local';
export type SearchDepth = 'quick' | 'deep';
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed';
export type Confidence = 'high' | 'medium' | 'low';

export interface SearchRequest {
  query: string;
  mode: SearchMode;
  depth?: SearchDepth;
  corpusIds?: string[];
  filters?: { domains?: string[]; dateFrom?: string; dateTo?: string };
}

export interface SearchEvent {
  seq: number;
  at: string;
  phase: string;
  message: string;
  data?: unknown;
}

export interface SearchResultItem {
  id: string;
  title: string;
  url?: string;
  path?: string;
  locator?: string;
  excerpt: string;
  publishedAt?: string;
  fetchedAt?: string;
  sourceType?: string;
  score: number;
  status?: string;
  contentHash?: string;
}

export interface Citation {
  id: string;
  title: string;
  url?: string;
  path?: string;
  locator?: string;
  excerpt: string;
  publishedAt?: string;
  fetchedAt?: string;
  contentHash?: string;
}

export interface NormalizedSearchResult {
  answer: string;
  results: SearchResultItem[];
  citations: Citation[];
  conflicts: string[];
  gaps: string[];
  confidence: Confidence;
  warnings: string[];
  timings: Record<string, number>;
  sourceStatuses: Array<{ source: string; status: string; reason?: string }>;
}

export interface StoredJob {
  id: string;
  request: SearchRequest;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  result?: NormalizedSearchResult;
  error?: string;
}

export interface Corpus {
  id: string;
  name: string;
  rootPath: string;
  status: 'new' | 'indexing' | 'ready' | 'error';
  fileCount: number;
  chunkCount: number;
  indexedAt?: string;
  error?: string;
}

export interface AppConfig {
  root: string;
  dataDir: string;
  host: string;
  port: number;
  ollamaUrl: string;
  chatModel: string;
  embeddingModel: string;
  downloadDirectory: string;
  externalSearxngUrl: string;
  allowAgentIndexing: boolean;
  allowAgentDownloads: boolean;
  readRoots: string[];
  token: string;
}

export interface ExtractedDocument {
  title: string;
  text: string;
  sourceType: string;
  url?: string;
  path?: string;
  publishedAt?: string;
  fetchedAt?: string;
  author?: string;
  canonicalUrl?: string;
  locator?: string;
  contentHash: string;
}

export interface DiscoveredLink {
  title: string;
  url: string;
  snippet?: string;
  publishedAt?: string;
  sourceType?: string;
}

export interface MediaCandidate {
  kind: 'image' | 'video' | 'audio' | 'manifest' | 'embed';
  url: string;
  title?: string;
  mime?: string;
  width?: number;
  height?: number;
  estimatedBytes?: number;
  source: string;
  license?: string;
}
