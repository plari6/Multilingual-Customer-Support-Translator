/**
 * Protect spans that must never be translated: URLs, emails, order / tracking numbers,
 * @usernames, `code`, prices with currency and brand terms ("do not translate" list).
 *
 * mask() swaps them for numbered tokens ⟦0⟧ ⟦1⟧ ...; restore() puts the originals back
 * and appends any token a translation engine dropped, so no order number is ever lost.
 */

const BUILTIN = [
  /https?:\/\/[^\s<>"]+[^\s<>".,;:!?)]/g, // URLs
  /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, // emails
  /`[^`\n]+`/g, // inline code
  /@[A-Za-z0-9_]{4,}/g, // telegram usernames
  /#[A-Za-z0-9-]*\d[A-Za-z0-9-]*/g, // #1001, #A-77
  /\b(?=[A-Z0-9-]*\d)(?=[A-Z0-9-]*[A-Z])[A-Z0-9][A-Z0-9-]{5,}\b/g, // ORD-123456, 1Z999AA10123456784
];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function buildTermPattern(terms = []) {
  const list = [...new Set(terms.map((t) => String(t).trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!list.length) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${list.map(esc).join('|')})(?![\\p{L}\\p{N}])`, 'gu');
}

export function mask(text, { terms = [], termPattern } = {}) {
  const values = [];
  const spans = [];
  const patterns = [...BUILTIN];
  const tp = termPattern === undefined ? buildTermPattern(terms) : termPattern;
  if (tp) patterns.push(tp);
  for (const re of patterns) {
    re.lastIndex = 0;
    for (const m of String(text).matchAll(re)) spans.push([m.index, m.index + m[0].length]);
  }
  // keep the longest non-overlapping spans, left to right
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let out = '';
  let pos = 0;
  for (const [s, e] of spans) {
    if (s < pos) continue;
    out += text.slice(pos, s) + `⟦${values.length}⟧`;
    values.push(text.slice(s, e));
    pos = e;
  }
  out += String(text).slice(pos);
  return { masked: out, values };
}

export function restore(text, values) {
  if (!values?.length) return text;
  const used = new Set();
  let out = String(text).replace(/⟦\s*(\d+)\s*⟧|\[\[\s*(\d+)\s*\]\]/g, (m, a, b) => {
    const i = Number(a ?? b);
    if (values[i] === undefined) return m;
    used.add(i);
    return values[i];
  });
  const missing = values.filter((_, i) => !used.has(i));
  if (missing.length) out = `${out.trimEnd()} (${missing.join(', ')})`;
  return out;
}

/** For DeepL tag_handling=xml: escape the text and turn tokens into ignored <x/> tags. */
export function toDeeplXml(masked) {
  return masked
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/⟦(\d+)⟧/g, '<x i="$1"/>');
}

export function fromDeeplXml(xml) {
  return String(xml)
    .replace(/<x\s+i="(\d+)"\s*\/>|<x\s+i="(\d+)"\s*><\/x>/g, (_, a, b) => `⟦${a ?? b}⟧`)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
