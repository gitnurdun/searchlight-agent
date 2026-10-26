import crypto from 'node:crypto';

export const clip = (value: unknown, max = 1200): string => {
  const text = String(value ?? '').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
};

export const normalizeText = (value: string): string => value
  .normalize('NFKC')
  .replace(/[\u200B-\u200D\uFEFF]/g, '')
  .replace(/\r\n?/g, '\n')
  .replace(/[ \t]+/g, ' ')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

export const sha256 = (value: string | Buffer): string => crypto.createHash('sha256').update(value).digest('hex');

export function chunkText(text: string, maxChars = 2400, overlap = 240): Array<{ text: string; ordinal: number }> {
  const clean = normalizeText(text);
  if (!clean) return [];
  const blocks = clean.split(/\n\s*\n/).filter(Boolean);
  const chunks: string[] = [];
  let current = '';
  for (const block of blocks) {
    if (current && current.length + block.length + 2 > maxChars) {
      chunks.push(current.trim());
      current = `${current.slice(-overlap)}\n\n${block}`;
    } else current += `${current ? '\n\n' : ''}${block}`;
    while (current.length > maxChars * 1.5) {
      chunks.push(current.slice(0, maxChars).trim());
      current = current.slice(maxChars - overlap);
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(Boolean).map((chunk, ordinal) => ({ text: chunk, ordinal }));
}

export function tokenize(text: string): string[] {
  const normalized = text.toLocaleLowerCase().normalize('NFKC');
  const words = normalized.match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
  const han = [...normalized.matchAll(/[\p{Script=Han}]+/gu)].flatMap((m) => {
    const chars = [...m[0]];
    return chars.length === 1 ? chars : chars.slice(0, -1).map((c, i) => c + chars[i + 1]);
  });
  return [...new Set([...words, ...han])];
}

export function lexicalScore(query: string, text: string): number {
  const terms = tokenize(query);
  if (!terms.length) return 0;
  const hay = text.toLocaleLowerCase().normalize('NFKC');
  return terms.reduce((sum, term) => sum + (hay.includes(term) ? 1 : 0), 0) / terms.length;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0; let aa = 0; let bb = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0; const bv = b[i] ?? 0;
    dot += av * bv; aa += av * av; bb += bv * bv;
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}
