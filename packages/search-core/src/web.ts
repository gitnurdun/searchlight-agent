import crypto from 'node:crypto';
import { Readability } from '@mozilla/readability';
import * as cheerio from 'cheerio';
import { XMLParser } from 'fast-xml-parser';
import { parseHTML } from 'linkedom';
import robotsParser from 'robots-parser';
import { chromium } from 'playwright-core';
import type { AppConfig, DiscoveredLink, ExtractedDocument, SearchDepth } from './types.js';
import { assertPublicUrl } from './security.js';
import { clip, normalizeText, sha256 } from './text.js';

const USER_AGENT = 'LocalQwenSearchAgent/1.0 (+local personal research; respects robots.txt)';
const challengePattern = /captcha|cf-chl-|cloudflare.*challenge|unusual traffic|verify you are human|access denied|bot detection/i;
const paywallPattern = /subscribe to continue|already a subscriber|subscription required|sign in to continue reading|paywall/i;

type FetchResult = { url: string; status: number; headers: Headers; body: Buffer };
type RobotRules = { isAllowed(url: string, userAgent?: string): boolean | undefined };
const parseRobots = robotsParser as unknown as (url: string, text: string) => RobotRules;

class HostLimiter {
  private readonly last = new Map<string, number>();
  private active = 0;
  async run<T>(url: URL, fn: () => Promise<T>): Promise<T> {
    while (this.active >= 4) await new Promise((resolve) => setTimeout(resolve, 25));
    this.active++;
    try {
      const previous = this.last.get(url.hostname) ?? 0;
      const delay = Math.max(0, 900 - (Date.now() - previous));
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      this.last.set(url.hostname, Date.now());
      return await fn();
    } finally { this.active--; }
  }
}

async function boundedBody(response: Response, maxBytes = 5 * 1024 * 1024): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const chunks: Buffer[] = []; let size = 0; const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    const chunk = Buffer.from(value); size += chunk.length;
    if (size > maxBytes) { await reader.cancel().catch(() => {}); throw new Error('response_too_large'); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function classifyHttpStatus(status: number): string {
  if (status === 401) return 'authentication_required';
  if (status === 403) return 'blocked_403';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  return `http_${status}`;
}

function decodeHtml(buffer: Buffer, contentType: string): string {
  const match = contentType.match(/charset=([^;\s]+)/i);
  const encoding = match?.[1]?.replace(/["']/g, '').toLowerCase() ?? 'utf-8';
  try { return new TextDecoder(encoding).decode(buffer); }
  catch { return buffer.toString('utf8'); }
}

export class WebClient {
  private readonly limiter = new HostLimiter();
  private readonly robotsCache = new Map<string, { expires: number; parser: RobotRules }>();
  private readonly pageCache = new Map<string, { expires: number; value: FetchResult }>();
  constructor(private readonly config: AppConfig) {}

  private async rawFetch(value: string, maxBytes = 5 * 1024 * 1024): Promise<FetchResult> {
    let url = await assertPublicUrl(value);
    const cached = this.pageCache.get(url.href);
    if (cached && cached.expires > Date.now()) return cached.value;
    for (let hop = 0; hop < 5; hop++) {
      const result = await this.limiter.run(url, async () => {
        let lastError: unknown;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const response = await fetch(url, {
              redirect: 'manual', headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,application/xml,text/plain,application/json;q=0.9,*/*;q=0.2' },
              signal: AbortSignal.timeout(20_000),
            });
            if ((response.status === 429 || response.status >= 500) && attempt < 2) {
              const retry = Number(response.headers.get('retry-after') ?? 0);
              await response.body?.cancel().catch(() => {});
              await new Promise((resolve) => setTimeout(resolve, retry ? Math.min(retry * 1000, 10_000) : 500 * 2 ** attempt));
              continue;
            }
            return { url: url.href, status: response.status, headers: response.headers, body: await boundedBody(response, maxBytes) };
          } catch (error) { lastError = error; if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt)); }
        }
        throw lastError instanceof Error ? lastError : new Error('network_error');
      });
      if ([301, 302, 303, 307, 308].includes(result.status)) {
        const location = result.headers.get('location');
        if (!location) throw new Error('redirect_without_location');
        url = await assertPublicUrl(new URL(location, url).href);
        continue;
      }
      this.pageCache.set(url.href, { expires: Date.now() + 24 * 60 * 60 * 1000, value: result });
      return result;
    }
    throw new Error('too_many_redirects');
  }

  private async allowedByRobots(url: URL): Promise<boolean> {
    const origin = url.origin;
    let cached = this.robotsCache.get(origin);
    if (!cached || cached.expires <= Date.now()) {
      try {
        const robotsUrl = `${origin}/robots.txt`;
        const response = await this.rawFetch(robotsUrl, 512 * 1024);
        const text = response.status === 200 ? response.body.toString('utf8') : '';
        cached = { expires: Date.now() + 6 * 60 * 60 * 1000, parser: parseRobots(robotsUrl, text) };
      } catch {
        cached = { expires: Date.now() + 15 * 60 * 1000, parser: parseRobots(`${origin}/robots.txt`, '') };
      }
      this.robotsCache.set(origin, cached);
    }
    return cached.parser.isAllowed(url.href, USER_AGENT) !== false;
  }

  async fetchPublicPage(value: string): Promise<FetchResult> {
    const url = await assertPublicUrl(value);
    if (!await this.allowedByRobots(url)) throw new Error('robots_denied');
    const response = await this.rawFetch(url.href);
    if (response.status < 200 || response.status >= 300) throw new Error(classifyHttpStatus(response.status));
    const type = response.headers.get('content-type') ?? '';
    if (!/(html|xhtml|xml|json|text)/i.test(type)) throw new Error('unsupported_content_type');
    return response;
  }

  async fetchBinary(value: string, maxBytes = 100 * 1024 * 1024): Promise<FetchResult> {
    const url = await assertPublicUrl(value);
    if (!await this.allowedByRobots(url)) throw new Error('robots_denied');
    const response = await this.rawFetch(url.href, maxBytes);
    if (response.status < 200 || response.status >= 300) throw new Error(classifyHttpStatus(response.status));
    return response;
  }

  async renderWithEdge(value: string): Promise<string> {
    const url = await assertPublicUrl(value);
    if (!await this.allowedByRobots(url)) throw new Error('robots_denied');
    const executablePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
      const context = await browser.newContext({ userAgent: USER_AGENT, javaScriptEnabled: true });
      const page = await context.newPage();
      await page.route('**/*', async (route) => {
        const target = new URL(route.request().url());
        const type = route.request().resourceType();
        if (!['http:', 'https:'].includes(target.protocol) || ['font', 'media'].includes(type)) return route.abort();
        return route.continue();
      });
      await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 25_000 });
      await page.waitForTimeout(1000);
      return await page.content();
    } finally { await browser.close(); }
  }

  async extract(value: string): Promise<ExtractedDocument> {
    const response = await this.fetchPublicPage(value);
    const type = response.headers.get('content-type') ?? '';
    let html = decodeHtml(response.body, type);
    let extracted = extractHtml(html, response.url);
    if (extracted.text.length < 300 && /html/i.test(type)) {
      try { html = await this.renderWithEdge(response.url); extracted = extractHtml(html, response.url); }
      catch {}
    }
    if (challengePattern.test(html.slice(0, 50_000))) throw new Error('captcha_or_bot_challenge');
    if (paywallPattern.test(html.slice(0, 100_000)) && extracted.text.length < 1000) throw new Error('paywall');
    if (!extracted.text) throw new Error('empty_extraction');
    return { ...extracted, url: response.url, fetchedAt: new Date().toISOString(), contentHash: sha256(extracted.text) };
  }
}

export function extractHtml(html: string, url: string): Omit<ExtractedDocument, 'contentHash'> {
  const $ = cheerio.load(html);
  $('script,style,noscript,template,form,nav,footer,aside,[hidden],[aria-hidden="true"],.advertisement,.ads,.cookie-banner').remove();
  const title = normalizeText($('meta[property="og:title"]').attr('content') ?? $('title').first().text() ?? new URL(url).hostname);
  const canonicalUrl = $('link[rel="canonical"]').attr('href');
  const author = $('meta[name="author"]').attr('content') ?? $('meta[property="article:author"]').attr('content');
  const publishedAt = $('meta[property="article:published_time"]').attr('content')
    ?? $('time[datetime]').first().attr('datetime') ?? $('meta[name="date"]').attr('content');
  let text = '';
  try {
    const { document } = parseHTML($.html());
    text = normalizeText(new Readability(document as unknown as Document, { charThreshold: 100 }).parse()?.textContent ?? '');
  } catch {}
  if (text.length < 200) text = normalizeText($('main,article,[role="main"]').first().text() || $('body').text());
  return { title: title || new URL(url).hostname, text, sourceType: classifySource(url, html), canonicalUrl: canonicalUrl ? new URL(canonicalUrl, url).href : undefined, author, publishedAt };
}

function classifySource(url: string, html = ''): string {
  const host = new URL(url).hostname;
  if (/github\.com|gitlab\.com/.test(host)) return 'code';
  if (/arxiv\.org|doi\.org|crossref|openalex/.test(host) || /citation_(?:title|author)/i.test(html)) return 'paper';
  if (/news|article:published_time|NewsArticle/i.test(`${host} ${html.slice(0, 50_000)}`)) return 'news';
  if (/docs?\.|developer|documentation/i.test(host)) return 'documentation';
  if (/youtube|vimeo|dailymotion/i.test(host)) return 'media';
  return 'web';
}

function parseDuckDuckGo(html: string): DiscoveredLink[] {
  const $ = cheerio.load(html); const rows: DiscoveredLink[] = [];
  $('.result').each((_i, element) => {
    const link = $(element).find('.result__a').first();
    let href = link.attr('href') ?? '';
    try { const parsed = new URL(href, 'https://duckduckgo.com'); href = parsed.searchParams.get('uddg') ?? parsed.href; } catch { return; }
    if (!/^https?:\/\//i.test(href)) return;
    rows.push({ title: normalizeText(link.text()), url: href, snippet: normalizeText($(element).find('.result__snippet').text()), sourceType: 'web' });
  });
  if (!rows.length && challengePattern.test(html)) throw new Error('search_provider_challenge');
  return rows;
}

function parseNewsRss(xml: string): DiscoveredLink[] {
  const data = new XMLParser({ ignoreAttributes: false }).parse(xml) as any;
  const items = data?.rss?.channel?.item ?? [];
  return (Array.isArray(items) ? items : [items]).filter(Boolean).map((item: any) => ({
    title: normalizeText(String(item.title ?? '')), url: String(item.link ?? ''),
    snippet: normalizeText(String(item.description ?? '').replace(/<[^>]+>/g, ' ')), publishedAt: item.pubDate ? new Date(item.pubDate).toISOString() : undefined, sourceType: 'news',
  })).filter((row: DiscoveredLink) => /^https?:\/\//.test(row.url));
}

function uniqueLinks(rows: DiscoveredLink[]): DiscoveredLink[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    try {
      const url = new URL(row.url); url.hash = ''; for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid|gclid)/i.test(key)) url.searchParams.delete(key);
      const normalized = url.href; if (seen.has(normalized)) return false; seen.add(normalized); row.url = normalized; return true;
    } catch { return false; }
  });
}

export class WebDiscovery {
  constructor(private readonly config: AppConfig, private readonly client: WebClient) {}

  async search(queries: string[], depth: SearchDepth): Promise<{ links: DiscoveredLink[]; statuses: Array<{ source: string; status: string; reason?: string }> }> {
    const statuses: Array<{ source: string; status: string; reason?: string }> = [];
    const collected: DiscoveredLink[] = [];
    const max = depth === 'deep' ? 40 : 15;
    const tasks: Promise<void>[] = [];
    for (const query of queries) {
      if (/^https?:\/\//i.test(query.trim())) { collected.push({ title: query, url: query.trim(), sourceType: 'direct' }); continue; }
      const duck = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      tasks.push((async () => { try {
        const response = await this.client.fetchPublicPage(duck);
        collected.push(...parseDuckDuckGo(response.body.toString('utf8')));
        statuses.push({ source: 'DuckDuckGo HTML', status: 'ok' });
      } catch (error) { statuses.push({ source: 'DuckDuckGo HTML', status: 'blocked', reason: error instanceof Error ? error.message : String(error) }); } })());
      tasks.push((async () => { try {
        const news = await this.client.fetchPublicPage(`https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`);
        collected.push(...parseNewsRss(news.body.toString('utf8')));
        statuses.push({ source: 'News RSS', status: 'ok' });
      } catch (error) { statuses.push({ source: 'News RSS', status: 'unavailable', reason: error instanceof Error ? error.message : String(error) }); } })());
      tasks.push((async () => { try {
        const wikiUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&origin=*`;
        const wiki = await this.client.fetchPublicPage(wikiUrl);
        const data = JSON.parse(wiki.body.toString('utf8'));
        const hits = Array.isArray(data?.query?.search) ? data.query.search.slice(0, 3) : [];
        collected.push(...hits.map((hit: any) => ({ title: String(hit.title), url: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(hit.title).replaceAll(' ', '_'))}`, snippet: normalizeText(String(hit.snippet ?? '').replace(/<[^>]+>/g, ' ')), sourceType: 'reference' })));
        statuses.push({ source: 'Wikipedia', status: 'ok' });
      } catch (error) { statuses.push({ source: 'Wikipedia', status: 'unavailable', reason: error instanceof Error ? error.message : String(error) }); } })());
      if (this.config.externalSearxngUrl) {
        tasks.push((async () => { try {
          const target = new URL('/search', this.config.externalSearxngUrl); target.searchParams.set('q', query); target.searchParams.set('format', 'json');
          const response = await this.client.fetchPublicPage(target.href); const data = JSON.parse(response.body.toString('utf8'));
          collected.push(...(data.results ?? []).map((row: any) => ({ title: String(row.title ?? ''), url: String(row.url ?? ''), snippet: String(row.content ?? ''), sourceType: 'web' })));
          statuses.push({ source: 'SearXNG', status: 'ok' });
        } catch (error) { statuses.push({ source: 'SearXNG', status: 'unavailable', reason: error instanceof Error ? error.message : String(error) }); } })());
      }
    }
    const budgetMs = depth === 'deep' ? 50_000 : 18_000;
    let budgetExpired = false;
    let budgetTimer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled(tasks),
      new Promise<void>((resolve) => { budgetTimer = setTimeout(() => { budgetExpired = true; resolve(); }, budgetMs); }),
    ]);
    if (budgetTimer) clearTimeout(budgetTimer);
    if (budgetExpired) statuses.push({ source: 'Discovery budget', status: 'limited', reason: `Discovery stopped after ${Math.round(budgetMs / 1000)} seconds; completed providers were retained.` });
    return { links: uniqueLinks(collected).slice(0, max), statuses: [...statuses] };
  }
}

export function sourceId(url: string): string { return crypto.createHash('sha1').update(url).digest('hex').slice(0, 12); }
