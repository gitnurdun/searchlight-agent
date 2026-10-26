# Searchlight — Local Qwen Search Agent

Searchlight is a private, local-first research service for Windows. It has two explicit modes:

- **Web** discovers public sources, reads pages, removes boilerplate, records blocked sources, and asks local Qwen to write a cited answer.
- **Local files** indexes selected folders read-only and combines SQLite FTS5 with optional Qwen embeddings.

It also exposes REST/OpenAPI and MCP interfaces for other agents. It never uses paid search APIs, Docker, proxy rotation, CAPTCHA bypass, paywall bypass, DRM defeat, or automatic browser-cookie extraction.

## Quick start

Requirements: Node.js 24 or newer, Ollama with a local chat model, and the optional tools needed by your chosen features. The original environment used Node.js 26, Microsoft Edge, ripgrep, `pdftotext`, Pandoc, and qpdf.

```powershell
git clone https://github.com/gitnurdun/searchlight-agent.git
cd searchlight-agent
New-Item -ItemType Directory -Path workspace -Force
npm ci
npm run build
npm test
```

Then double-click **Start Search Agent.cmd**. The UI opens at <http://127.0.0.1:4321>. Double-click **Stop Search Agent.cmd** to stop Searchlight; Ollama is intentionally left running.

Searchlight starts the installed Ollama service when it is not already reachable. It never pulls a model automatically.

### Enable semantic local search

This is an explicit download of approximately 639 MB:

```powershell
npm run setup:embedding
```

Without it, local search continues with FTS5 and ripgrep-style lexical matching.

### Optional tools

- **Tesseract** enables OCR for scanned images and scanned PDFs converted to images.
- **yt-dlp** enables video/audio inspection and downloading from supported public sites.
- **FFmpeg** lets yt-dlp merge separately served audio and video formats.

Searchlight detects these tools on `PATH`; it does not install or update them. The System page reports exactly what is available.

## Configuration

Copy `config.example.json` to `config.json` to override defaults. Important settings:

- `readRoots`: folders under which the user may register local corpora.
- `downloadDirectory`: verified media download destination.
- `externalSearxngUrl`: optional external SearXNG instance; blank by default.
- `allowAgentIndexing`: permits MCP clients to register/index folders.
- `allowAgentDownloads`: permits MCP clients to create media downloads.

The server binds only to loopback. A random API token is stored in `.data/session-token`. The browser receives it from a loopback-only session endpoint. Runtime databases, caches, logs and tokens live under `.data/` and are ignored by Git.

## Search behavior

### Web acquisition

Searchlight uses isolated no-key discovery adapters: DuckDuckGo HTML, public news RSS, Wikipedia, direct URLs and an optional external SearXNG endpoint. It first performs an ordinary HTTP fetch, then tries canonical page extraction, and finally may render a public JavaScript-only page with the installed Edge browser. It respects `robots.txt` and applies per-host pacing, response limits, retry limits and public-IP checks.

When a source presents a 401/403/429, CAPTCHA, paywall, robots denial, oversized response, unsupported content type or network error, that reason is retained in the research record. Searchlight tries independent sources; it does not evade the restriction.

### Evidence washing

HTML cleaning, canonicalization, deduplication, Unicode normalization, metadata extraction and lexical scoring happen in deterministic code. Qwen then receives only bounded cleaned excerpts for query planning, evidence extraction, conflict reporting and synthesis. Page text is always labeled as untrusted data and cannot invoke tools.

### Local indexing

Supported formats include text, Markdown, HTML, JSON, CSV, logs, source code, PDF, EPUB, DOCX, ODT and RTF. Optional Tesseract covers common image formats. Files are chunked with their page/line locator, content hash and optional embedding. Incremental indexing skips unchanged files and removes stale index records without deleting source files.

Sensitive and noisy paths such as `.git`, `node_modules`, `.ssh`, `.aws`, `.env`, browser profiles and Windows system folders are excluded. Real-path checks prevent symlink and junction escapes.

## REST API

OpenAPI documentation is available at <http://127.0.0.1:4321/docs>.

The standard asynchronous flow is:

1. `POST /api/v1/searches` with `{ "query": "...", "mode": "web", "depth": "quick" }`.
2. Read progress from `GET /api/v1/searches/{id}/events` as server-sent events.
3. Read the final normalized result from `GET /api/v1/searches/{id}`.

Other endpoint groups cover chats, corpora, media, health and diagnostics. Protected requests use `X-Search-Agent-Token` with the value in `.data/session-token`.

Normalized results contain:

- `answer`, `confidence`, `warnings`, `conflicts` and `gaps`
- ranked `results` and citation-ready `citations`
- per-source fetch/block status and timing data

## MCP

For local agent clients, stdio is the simplest transport:

```json
{
  "command": "npm",
  "args": ["run", "mcp:stdio"],
  "cwd": "C:\\path\\to\\searchlight-agent"
}
```

The running web service also exposes stateless Streamable HTTP at `http://127.0.0.1:4321/mcp`; pass the local token in `X-Search-Agent-Token`.

Tools: `search_web`, `answer_web`, `search_local`, `answer_local`, `list_corpora`, `index_folder`, `inspect_media`, `download_media`, and `get_search_status`. Indexing and download tools remain disabled until their capability flags are enabled in `config.json`.

## Development and verification

```powershell
npm run dev       # server on 4321 and Vite on 5173
npm run check     # strict TypeScript
npm test          # deterministic tests
npm run build     # production server and UI
npm run doctor    # JSON capability report
```

The test suite covers text cleaning, multilingual chunking, vector math, private-network blocking, safe filenames, article extraction, SQLite persistence and FTS5 retrieval. Network and live-model behavior remain optional smoke tests because public providers and model timings vary.

## Deliberate limits

- General no-key web discovery can be blocked or changed by providers; results report this instead of pretending the search succeeded.
- Search snippets are not treated as equivalent to fully read pages.
- A 1.7B model is useful for bounded extraction and synthesis but can still make mistakes. Keep citations visible and inspect important evidence.
- Downloads are for public, user-authorized, non-DRM content. Users remain responsible for copyright and site terms.
