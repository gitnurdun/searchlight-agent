import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import type { AppConfig } from './types.js';

const blockedNames = new Set(['.git', 'node_modules', '.ssh', '.aws', '.codex', '.env', 'AppData', '$RECYCLE.BIN', 'System Volume Information']);

export function isPrivateIp(ip: string): boolean {
  const v = ip.toLowerCase();
  return v === '::1' || v === '0.0.0.0' || /^(fc|fd|fe80):/.test(v) || /^::ffff:/.test(v)
    || /^(0|10|127|169\.254|192\.168)\./.test(v) || /^172\.(1[6-9]|2\d|3[01])\./.test(v)
    || /^(22[4-9]|23\d|24\d|25[0-5])\./.test(v);
}

export async function assertPublicUrl(value: string): Promise<URL> {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only public HTTP/HTTPS URLs without embedded credentials are allowed.');
  if (url.port && !['80', '443'].includes(url.port)) throw new Error('Nonstandard web ports are not allowed.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addresses.length || addresses.some((row) => isPrivateIp(row.address))) throw new Error('Private, loopback and network-management addresses are blocked.');
  return url;
}

export async function resolveAllowedPath(config: AppConfig, candidate: string): Promise<string> {
  const requested = path.resolve(candidate);
  const real = await fs.realpath(requested);
  const allowed = await Promise.all(config.readRoots.map(async (root) => {
    try { return await fs.realpath(root); } catch { return path.resolve(root); }
  }));
  const inside = allowed.some((root) => real.toLocaleLowerCase() === root.toLocaleLowerCase()
    || real.toLocaleLowerCase().startsWith(`${root.toLocaleLowerCase()}${path.sep}`));
  if (!inside) throw new Error('Path is outside configured read roots.');
  const pieces = real.split(path.sep);
  if (pieces.some((piece) => blockedNames.has(piece) || piece.toLowerCase().startsWith('.env'))) throw new Error('Sensitive or excluded path.');
  return real;
}

export function isExcludedName(name: string): boolean {
  return blockedNames.has(name) || name.toLowerCase().startsWith('.env');
}

export function safeFilename(input: string, fallback = 'download'): string {
  const base = path.basename(input).normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/[. ]+$/g, '').slice(0, 160);
  return base && !/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(base) ? base : fallback;
}
