import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

type Mode = 'web' | 'local';
type Page = 'search' | 'library' | 'media' | 'system';
type Corpus = { id: string; name: string; rootPath: string; status: string; fileCount: number; chunkCount: number; indexedAt?: string; error?: string };
type Result = { id: string; title: string; url?: string; path?: string; locator?: string; excerpt: string; publishedAt?: string; fetchedAt?: string; sourceType?: string; score: number; status?: string };
type SearchResult = { answer: string; results: Result[]; citations: Result[]; conflicts: string[]; gaps: string[]; confidence: string; warnings: string[]; timings: Record<string, number>; sourceStatuses: Array<{ source: string; status: string; reason?: string }> };
type MediaResult = { title?: string; candidates: Array<{ kind: string; url: string; source: string; mime?: string; width?: number; height?: number }>; warnings: string[]; ytDlp?: unknown };

let token = '';
async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
  if (!token) token = (await fetch('/api/v1/session').then((r) => r.json())).token;
  const response = await fetch(url, { ...init, headers: { 'content-type': 'application/json', 'x-search-agent-token': token, ...(init.headers ?? {}) } });
  if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error ? (typeof data.error === 'string' ? data.error : JSON.stringify(data.error)) : `Request failed: ${response.status}`); }
  if (response.status === 204) return undefined as T;
  return response.json();
}

async function streamJob(id: string, onEvent: (event: any) => void): Promise<void> {
  const response = await fetch(`/api/v1/searches/${id}/events`, { headers: { 'x-search-agent-token': token } });
  if (!response.ok || !response.body) throw new Error('Could not stream search progress.');
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
  for (;;) {
    const { done, value } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n'); buffer = parts.pop() ?? '';
    for (const part of parts) { const line = part.split('\n').find((row) => row.startsWith('data: ')); if (line) onEvent(JSON.parse(line.slice(6))); }
  }
}

function Icon({ name }: { name: string }) {
  const icons: Record<string, React.ReactNode> = {
    search: <><circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/></>,
    library: <><path d="M4 4h5v16H4zM10 4h4v16h-4zM15 5l4-1 2 15-4 1z"/></>,
    media: <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m9 9 7 3-7 3z"/></>,
    system: <><circle cx="12" cy="12" r="3"/><path d="M19 12h3M2 12h3M12 2v3M12 19v3M17 7l2-2M5 19l2-2M17 17l2 2M5 5l2 2"/></>,
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true">{icons[name]}</svg>;
}

function AnswerText({ text, results }: { text: string; results: Result[] }) {
  const rows = text.split(/(\[S\d+\])/g);
  return <div className="answer-text">{rows.map((part, i) => {
    const match = part.match(/^\[(S\d+)\]$/); if (!match) return <React.Fragment key={i}>{part}</React.Fragment>;
    const source = results.find((row) => row.id === match[1]); return <a key={i} className="citation-pill" href={`#source-${match[1]}`} title={source?.title}>{match[1]}</a>;
  })}</div>;
}

function SearchPage({ corpora }: { corpora: Corpus[] }) {
  const [mode, setMode] = useState<Mode>('web'); const [depth, setDepth] = useState<'quick' | 'deep'>('quick');
  const [query, setQuery] = useState(''); const [selected, setSelected] = useState<string[]>([]); const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<any[]>([]); const [result, setResult] = useState<SearchResult | null>(null); const [error, setError] = useState('');
  const placeholder = mode === 'web' ? 'What’s new with DeepSeek?' : 'Why did the character make that decision?';
  async function run(event: React.FormEvent) {
    event.preventDefault(); if (!query.trim() || running) return; setRunning(true); setEvents([]); setResult(null); setError('');
    try {
      const job = await api<{ id: string }>('/api/v1/searches', { method: 'POST', body: JSON.stringify({ query, mode, depth, corpusIds: mode === 'local' ? selected : undefined }) });
      await streamJob(job.id, (entry) => { setEvents((rows) => [...rows, entry]); if (entry.phase === 'done') setResult(entry.data.result); if (entry.phase === 'error') setError(entry.message); });
      if (!result) { const final = await api<any>(`/api/v1/searches/${job.id}`); if (final.result) setResult(final.result); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setRunning(false); }
  }
  return <main className="page search-page">
    <section className="hero">
      <div className="eyebrow"><span className="pulse"/>LOCAL RESEARCH ENGINE</div>
      <h1>Search deeply.<br/><em>Keep the evidence.</em></h1>
      <p>Web discovery and private file research, washed by code and grounded by your local Qwen model.</p>
    </section>
    <form className="search-box" onSubmit={run}>
      <div className="mode-row">
        <div className="segmented" role="group" aria-label="Search mode">
          <button type="button" className={mode === 'web' ? 'active' : ''} onClick={() => setMode('web')}>Web</button>
          <button type="button" className={mode === 'local' ? 'active' : ''} onClick={() => setMode('local')}>Local files</button>
        </div>
        <label className="depth-switch"><span>Depth</span><select value={depth} onChange={(e) => setDepth(e.target.value as any)}><option value="quick">Quick</option><option value="deep">Deep</option></select></label>
      </div>
      <div className="query-row"><textarea value={query} onChange={(e) => setQuery(e.target.value)} placeholder={placeholder} rows={2}/><button className="run-button" disabled={running || !query.trim()}>{running ? <span className="spinner"/> : '→'}<span>{running ? 'Researching' : 'Search'}</span></button></div>
      {mode === 'local' && <div className="corpus-picker"><span>Search in</span>{corpora.length ? corpora.map((corpus) => <label key={corpus.id}><input type="checkbox" checked={selected.includes(corpus.id)} onChange={() => setSelected((ids) => ids.includes(corpus.id) ? ids.filter((id) => id !== corpus.id) : [...ids, corpus.id])}/><span>{corpus.name}</span></label>) : <small>Add and index a folder in Library first.</small>}</div>}
    </form>
    {(running || events.length > 0) && <section className="timeline panel"><div className="panel-head"><h2>Research trail</h2><span>{running ? 'LIVE' : 'COMPLETE'}</span></div><div className="event-list">{events.map((event, i) => <div className="event" key={`${event.seq}-${i}`}><i/><time>{new Date(event.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time><b>{event.phase}</b><p>{event.message}</p></div>)}</div></section>}
    {error && <div className="notice error">{error}</div>}
    {result && <section className="result-layout">
      <article className="answer panel"><div className="panel-head"><h2>Answer</h2><span className={`confidence ${result.confidence}`}>{result.confidence} confidence</span></div><AnswerText text={result.answer} results={result.results}/>
        {result.warnings.map((warning, i) => <div className="notice" key={i}>{warning}</div>)}
        {!!result.conflicts.length && <div className="conflicts"><h3>Conflicts</h3>{result.conflicts.map((row, i) => <p key={i}>{row}</p>)}</div>}
      </article>
      <aside className="sources"><div className="section-title"><h2>Evidence</h2><span>{result.results.length} sources</span></div>{result.results.map((row) => <article className="source-card" id={`source-${row.id}`} key={row.id}><div className="source-meta"><span>{row.id}</span><b>{row.sourceType ?? 'source'}</b><small>{Math.round(row.score * 100)}%</small></div><h3>{row.url ? <a href={row.url} target="_blank" rel="noreferrer">{row.title}</a> : row.title}</h3><p>{row.excerpt}</p><footer>{row.path && <code>{row.path}</code>}{row.locator && <span>{row.locator}</span>}{row.publishedAt && <span>{new Date(row.publishedAt).toLocaleDateString()}</span>}</footer></article>)}</aside>
    </section>}
  </main>;
}

function LibraryPage({ corpora, refresh }: { corpora: Corpus[]; refresh: () => void }) {
  const [folder, setFolder] = useState(''); const [message, setMessage] = useState('');
  async function add(event: React.FormEvent) { event.preventDefault(); try { const corpus = await api<Corpus>('/api/v1/corpora', { method: 'POST', body: JSON.stringify({ path: folder }) }); setFolder(''); setMessage(`Added ${corpus.name}.`); refresh(); } catch (e) { setMessage(e instanceof Error ? e.message : String(e)); } }
  async function index(id: string) { await api(`/api/v1/corpora/${id}/index`, { method: 'POST', body: '{}' }); setMessage('Indexing started. Refresh in a moment to see progress.'); refresh(); }
  async function remove(id: string) { await api(`/api/v1/corpora/${id}`, { method: 'DELETE' }); refresh(); }
  return <main className="page"><header className="page-header"><div className="eyebrow">LOCAL KNOWLEDGE</div><h1>Library</h1><p>Folders stay where they are. Searchlight stores only searchable text and vectors.</p></header>
    <form className="add-folder panel" onSubmit={add}><label><span>Folder path</span><input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="C:\Users\you\Documents\Books"/></label><button disabled={!folder.trim()}>Add folder</button></form>{message && <div className="notice">{message}</div>}
    <section className="corpus-grid">{corpora.map((corpus) => <article className="corpus-card panel" key={corpus.id}><div className="folder-icon">⌂</div><div><div className="status-row"><span className={`status-dot ${corpus.status}`}/><b>{corpus.status}</b></div><h2>{corpus.name}</h2><code>{corpus.rootPath}</code><dl><div><dt>Files</dt><dd>{corpus.fileCount}</dd></div><div><dt>Chunks</dt><dd>{corpus.chunkCount}</dd></div></dl>{corpus.error && <p className="error-text">{corpus.error}</p>}<div className="card-actions"><button onClick={() => index(corpus.id)} disabled={corpus.status === 'indexing'}>{corpus.status === 'indexing' ? 'Indexing…' : 'Index now'}</button><button className="ghost danger" onClick={() => remove(corpus.id)}>Remove index</button></div></div></article>)}</section>
  </main>;
}

function MediaPage() {
  const [url, setUrl] = useState(''); const [data, setData] = useState<MediaResult | null>(null); const [busy, setBusy] = useState(false); const [message, setMessage] = useState('');
  async function inspect(event: React.FormEvent) { event.preventDefault(); setBusy(true); setMessage(''); try { setData(await api('/api/v1/media/inspect', { method: 'POST', body: JSON.stringify({ url }) })); } catch (e) { setMessage(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } }
  async function download(candidate: any, useYtDlp = false) { setMessage('Downloading…'); try { const saved = await api<any>('/api/v1/media/download', { method: 'POST', body: JSON.stringify({ url: useYtDlp ? url : candidate.url, useYtDlp }) }); setMessage(`Saved ${saved.bytes.toLocaleString()} bytes to ${saved.path}`); } catch (e) { setMessage(e instanceof Error ? e.message : String(e)); } }
  return <main className="page"><header className="page-header"><div className="eyebrow">MEDIA INSPECTOR</div><h1>Find the real asset.</h1><p>Inspect public pages before downloading. DRM, paywalls and access controls stay off-limits.</p></header><form className="media-form panel" onSubmit={inspect}><input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/page-or-image"/><button disabled={!url || busy}>{busy ? 'Inspecting…' : 'Inspect URL'}</button></form>{message && <div className="notice">{message}</div>}
    {data && <><div className="section-title"><h2>{data.title || 'Media candidates'}</h2><span>{data.candidates.length} found</span></div>{data.warnings.map((w, i) => <div className="notice" key={i}>{w}</div>)}{data.ytDlp && <button className="wide-action" onClick={() => download(null, true)}>Download best video/audio with yt-dlp</button>}<section className="media-grid">{data.candidates.map((row, i) => <article className="media-card" key={`${row.url}-${i}`}>{row.kind === 'image' && <img src={row.url} alt="" loading="lazy"/>}<div><b>{row.kind}</b><p>{row.url}</p><small>{[row.mime, row.width && row.height ? `${row.width}×${row.height}` : ''].filter(Boolean).join(' · ')}</small><button onClick={() => download(row)}>Download</button></div></article>)}</section></>}
  </main>;
}

function SystemPage() {
  const [report, setReport] = useState<any>(null); const [error, setError] = useState('');
  useEffect(() => { api('/api/v1/doctor').then(setReport).catch((e) => setError(e.message)); }, []);
  return <main className="page"><header className="page-header"><div className="eyebrow">SYSTEM CHECK</div><h1>Doctor</h1><p>See what is ready, optional, or unavailable on this PC.</p></header>{error && <div className="notice error">{error}</div>}{report && <section className="doctor-grid"><article className="panel"><h2>Runtime</h2><Row label="Node" value={report.node}/><Row label="Server" value={report.bind}/><Row label="Edge rendering" value={report.edge ? 'Ready' : 'Unavailable'}/><Row label="Ollama" value={report.ollama.reachable ? 'Connected' : 'Offline'}/></article><article className="panel"><h2>Models</h2><Row label="Chat" value={report.chatModel}/><Row label="Embeddings" value={report.embeddingModel}/>{report.ollama.models?.map((m: any) => <Row key={m.name} label={m.name} value={`${m.sizeGB} GB`}/>)}</article><article className="panel tools-panel"><h2>Local tools</h2>{Object.entries(report.tools).map(([name, value]) => <Row key={name} label={name} value={value ? 'Ready' : 'Optional / missing'} state={!!value}/>)}</article></section>}
  </main>;
}
function Row({ label, value, state }: { label: string; value: any; state?: boolean }) { return <div className="doctor-row"><span>{label}</span><b className={state === false ? 'muted' : ''}>{String(value)}</b></div>; }

function App() {
  const [page, setPage] = useState<Page>('search'); const [corpora, setCorpora] = useState<Corpus[]>([]);
  const refresh = () => { void api<Corpus[]>('/api/v1/corpora').then(setCorpora).catch(() => {}); };
  useEffect(refresh, []);
  useEffect(() => {
    if (!corpora.some((corpus) => corpus.status === 'indexing')) return;
    const timer = window.setInterval(refresh, 1_500);
    return () => window.clearInterval(timer);
  }, [corpora]);
  const current = useMemo(() => page === 'search' ? <SearchPage corpora={corpora}/> : page === 'library' ? <LibraryPage corpora={corpora} refresh={refresh}/> : page === 'media' ? <MediaPage/> : <SystemPage/>, [page, corpora]);
  return <div className="shell"><aside className="sidebar"><div className="brand"><span>◈</span><div><b>SEARCHLIGHT</b><small>LOCAL QWEN</small></div></div><nav>{(['search', 'library', 'media', 'system'] as Page[]).map((item) => { const label = item === 'system' ? 'System' : item.charAt(0).toUpperCase() + item.slice(1); return <button key={item} aria-label={label} title={label} className={page === item ? 'active' : ''} onClick={() => setPage(item)}><Icon name={item}/><span>{label}</span></button>; })}</nav><footer><span className="online-dot"/>Private on this PC</footer></aside><div className="content"><header className="topbar"><div><span className="online-dot"/>LOCALHOST</div><span>QWEN 3 · 1.7B</span></header>{current}</div></div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
