import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as cheerio from 'cheerio';
import { fileTypeFromBuffer } from 'file-type';
import type { AppConfig, MediaCandidate } from './types.js';
import { WebClient } from './web.js';
import { safeFilename } from './security.js';
import { clip, sha256 } from './text.js';
import { runProcess } from './process.js';

const execFileAsync = promisify(execFile);

async function commandExists(name: string): Promise<boolean> {
  try { await execFileAsync('where.exe', [name], { windowsHide: true }); return true; } catch { return false; }
}

function addCandidate(rows: MediaCandidate[], candidate: MediaCandidate): void {
  try {
    const url = new URL(candidate.url);
    if (!['http:', 'https:'].includes(url.protocol) || rows.some((row) => row.url === url.href)) return;
    rows.push({ ...candidate, url: url.href });
  } catch {}
}

export class MediaService {
  constructor(private readonly config: AppConfig, private readonly client: WebClient) {}

  async inspect(value: string): Promise<{ url: string; title?: string; candidates: MediaCandidate[]; ytDlp?: unknown; warnings: string[] }> {
    const warnings: string[] = [];
    const response = await this.client.fetchBinary(value, 10 * 1024 * 1024);
    const type = response.headers.get('content-type') ?? '';
    if (/^image\//i.test(type)) return { url: response.url, title: path.basename(new URL(response.url).pathname), candidates: [{ kind: 'image', url: response.url, mime: type.split(';')[0], source: 'direct URL', estimatedBytes: Number(response.headers.get('content-length') ?? 0) || undefined }], warnings };
    if (/^(video|audio)\//i.test(type) || /mpegurl|dash\+xml/i.test(type)) return { url: response.url, candidates: [{ kind: /audio/i.test(type) ? 'audio' : /mpegurl|dash/i.test(type) ? 'manifest' : 'video', url: response.url, mime: type.split(';')[0], source: 'direct URL' }], warnings };
    const html = response.body.toString('utf8'); const $ = cheerio.load(html); const candidates: MediaCandidate[] = [];
    const title = $('meta[property="og:title"]').attr('content') ?? $('title').text().trim();
    $('img,source').each((_i, node) => {
      const element = $(node); const src = element.attr('src') ?? element.attr('data-src');
      if (src) addCandidate(candidates, { kind: node.tagName === 'source' && /video|audio/i.test(element.attr('type') ?? '') ? (/audio/i.test(element.attr('type') ?? '') ? 'audio' : 'video') : 'image', url: new URL(src, response.url).href, title: element.attr('alt'), mime: element.attr('type'), width: Number(element.attr('width')) || undefined, height: Number(element.attr('height')) || undefined, source: node.tagName });
      const srcset = element.attr('srcset');
      if (srcset) for (const item of srcset.split(',')) {
        const part = item.trim().split(/\s+/)[0]; if (part) addCandidate(candidates, { kind: 'image', url: new URL(part, response.url).href, source: 'srcset' });
      }
    });
    for (const [selector, kind] of [['meta[property="og:image"]', 'image'], ['meta[name="twitter:image"]', 'image'], ['meta[property="og:video"]', 'video'], ['meta[property="og:audio"]', 'audio']] as const) {
      const url = $(selector).attr('content'); if (url) addCandidate(candidates, { kind, url: new URL(url, response.url).href, source: selector });
    }
    $('video,audio,iframe').each((_i, node) => {
      const src = $(node).attr('src'); if (src) addCandidate(candidates, { kind: node.tagName === 'audio' ? 'audio' : node.tagName === 'iframe' ? 'embed' : 'video', url: new URL(src, response.url).href, source: node.tagName });
    });
    let ytDlp: unknown;
    if (await commandExists('yt-dlp')) {
      try {
        const result = await runProcess('yt-dlp', ['--dump-single-json', '--skip-download', '--no-playlist', '--', response.url], { timeoutMs: 45_000, maxBytes: 5 * 1024 * 1024 });
        if (result.code === 0) {
          const data = JSON.parse(result.stdout.toString('utf8'));
          ytDlp = { id: data.id, title: data.title, duration: data.duration, uploader: data.uploader, webpageUrl: data.webpage_url, thumbnail: data.thumbnail, formats: Array.isArray(data.formats) ? data.formats.slice(-20).map((f: any) => ({ formatId: f.format_id, ext: f.ext, resolution: f.resolution, filesize: f.filesize ?? f.filesize_approx, acodec: f.acodec, vcodec: f.vcodec })) : [] };
        } else warnings.push(`yt-dlp could not inspect this page: ${clip(result.stderr, 240)}`);
      } catch (error) { warnings.push(`yt-dlp inspection failed: ${error instanceof Error ? error.message : String(error)}`); }
    } else warnings.push('yt-dlp is not installed; direct page media was inspected only.');
    return { url: response.url, title, candidates: candidates.slice(0, 100), ytDlp, warnings };
  }

  async download(input: { url: string; filename?: string; useYtDlp?: boolean }): Promise<{ path: string; bytes: number; sha256: string }> {
    await fs.mkdir(this.config.downloadDirectory, { recursive: true });
    if (input.useYtDlp) {
      if (!await commandExists('yt-dlp')) throw new Error('yt-dlp is not installed.');
      const template = path.join(this.config.downloadDirectory, '%(title).160B [%(id)s].%(ext)s');
      const result = await runProcess('yt-dlp', ['--no-playlist', '--no-overwrites', '--restrict-filenames', '--print', 'after_move:filepath', '-o', template, '--', input.url], { timeoutMs: 30 * 60_000, maxBytes: 3 * 1024 * 1024 });
      if (result.code !== 0) throw new Error(`yt-dlp failed: ${clip(result.stderr, 400)}`);
      const target = result.stdout.toString('utf8').trim().split(/\r?\n/).at(-1);
      if (!target) throw new Error('yt-dlp did not report an output path.');
      const data = await fs.readFile(target); return { path: target, bytes: data.length, sha256: sha256(data) };
    }
    const response = await this.client.fetchBinary(input.url, 100 * 1024 * 1024);
    const detected = await fileTypeFromBuffer(response.body);
    const declared = response.headers.get('content-type')?.split(';')[0] ?? '';
    if (!detected && !/^(image|audio|video)\//i.test(declared)) throw new Error('Downloaded content is not recognized media.');
    const ext = detected?.ext ?? declared.split('/')[1]?.replace(/[^a-z0-9]/gi, '') ?? 'bin';
    const urlName = path.basename(new URL(response.url).pathname);
    let name = safeFilename(input.filename ?? (urlName || `media.${ext}`), `media.${ext}`);
    if (!path.extname(name)) name += `.${ext}`;
    const target = path.join(this.config.downloadDirectory, name);
    const temp = path.join(this.config.downloadDirectory, `.${crypto.randomUUID()}.tmp`);
    await fs.writeFile(temp, response.body, { flag: 'wx' });
    try { await fs.rename(temp, target); } catch (error) { await fs.rm(temp, { force: true }); throw error; }
    return { path: target, bytes: response.body.length, sha256: sha256(response.body) };
  }
}
