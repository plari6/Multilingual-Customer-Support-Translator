/**
 * DeepL API v2 over fetch (no SDK).
 * Free keys end with ":fx" and use api-free.deepl.com; Pro keys use api.deepl.com.
 */

export class DeeplError extends Error {
  constructor(message, { status, kind, retryAfterMs } = {}) {
    super(message);
    this.name = 'DeeplError';
    this.status = status;
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}

export function deeplKind(status) {
  if (status === 403 || status === 401) return 'auth';
  if (status === 456) return 'quota'; // monthly character limit reached
  if (status === 429) return 'rate_limit';
  if (status === 404) return 'not_found';
  if (status === 400 || status === 413 || status === 414) return 'bad_request';
  if (status >= 500) return 'overloaded';
  return 'unknown';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function deeplBaseUrl(apiKey, override) {
  if (override) return override.replace(/\/+$/, '');
  return String(apiKey || '').trim().endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
}

export function createDeeplClient({ apiKey, baseUrl, fetchImpl = fetch, timeoutMs = 8000, retries = 1, wait = sleep } = {}) {
  const configured = Boolean(apiKey);
  const base = deeplBaseUrl(apiKey, baseUrl);

  async function request(method, path, body, attempt = 0) {
    if (!configured) throw new DeeplError('DEEPL_API_KEY is not set', { kind: 'auth', status: 0 });
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          Authorization: `DeepL-Auth-Key ${apiKey}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          'User-Agent': 'multilingual-support-translator/1.0',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const kind = e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timeout' : 'network';
      if (attempt < retries) return request(method, path, body, attempt + 1);
      throw new DeeplError(`DeepL ${kind}: ${e.message}`, { kind, status: 0 });
    }
    if (res.status === 204) return null;
    const raw = await res.text();
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = raw;
    }
    if (res.ok) return data;
    const kind = deeplKind(res.status);
    const ra = Number(res.headers?.get?.('retry-after'));
    const retryAfterMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined;
    if ((kind === 'rate_limit' || kind === 'overloaded') && attempt < retries) {
      await wait(Math.min(retryAfterMs || 800 * (attempt + 1), 3000));
      return request(method, path, body, attempt + 1);
    }
    const msg = (data && (data.message || data.detail)) || (typeof data === 'string' ? data.slice(0, 200) : '');
    throw new DeeplError(`DeepL ${res.status}${msg ? `: ${msg}` : ''}`, { status: res.status, kind, retryAfterMs });
  }

  return {
    name: 'deepl',
    configured,
    base,
    /**
     * texts: string[]; target: DeepL target code (EN-US, FR, DE...).
     * -> [{ text, detected }]
     */
    async translate({ texts, target, source, formality, glossaryId, context, xml = false }) {
      const body = { text: texts, target_lang: target };
      if (source) body.source_lang = source;
      if (formality && formality !== 'default') body.formality = formality;
      if (glossaryId && source) body.glossary_id = glossaryId; // DeepL requires source_lang with a glossary
      if (context) body.context = String(context).slice(0, 4000);
      if (xml) Object.assign(body, { tag_handling: 'xml', ignore_tags: ['x'] });
      const data = await request('POST', '/v2/translate', body);
      const list = data?.translations;
      if (!Array.isArray(list) || list.length !== texts.length) throw new DeeplError('DeepL returned an unexpected response', { kind: 'bad_output', status: 200 });
      return list.map((t) => ({ text: t.text, detected: t.detected_source_language }));
    },
    usage: () => request('GET', '/v2/usage'),
    languages: (type = 'target') => request('GET', `/v2/languages?type=${type}`),
    listGlossaries: async () => (await request('GET', '/v2/glossaries'))?.glossaries || [],
    createGlossary: ({ name, source, target, entries }) =>
      request('POST', '/v2/glossaries', {
        name,
        source_lang: source.toLowerCase(),
        target_lang: target.toLowerCase(),
        entries: Object.entries(entries)
          .map(([a, b]) => `${String(a).replace(/[\t\n]/g, ' ')}\t${String(b).replace(/[\t\n]/g, ' ')}`)
          .join('\n'),
        entries_format: 'tsv',
      }),
    deleteGlossary: (id) => request('DELETE', `/v2/glossaries/${encodeURIComponent(id)}`),
  };
}
