import { deeplTarget, detectLanguage, normalizeLang } from '../languages.js';
import { buildTermPattern, fromDeeplXml, mask, restore, toDeeplXml } from './protect.js';

/**
 * Translation pipeline used by the bot, the CLI and the HTTP API.
 *
 *   cache -> DeepL -> AI fallback chain (multi-model router) -> untranslated original
 *
 * Every step is optional; the last step always succeeds, so a chat message is never lost.
 * Protected spans (links, emails, order / tracking numbers, brand terms) are masked first.
 */

const COOLDOWN = { auth: 6 * 3600_000, quota: 3600_000, rate_limit: 30_000, overloaded: 30_000, timeout: 20_000, network: 15_000 };

export function createTranslator({
  deepl,
  ai,
  englishVariant = 'EN-US',
  formality = {}, // { FR: 'prefer_more', DE: 'prefer_more' }
  doNotTranslate = [],
  glossaries = {}, // { 'EN>FR': { 'gift card': 'carte cadeau' } }
  glossaryIds = {}, // { 'EN>FR': '<deepl glossary id>' } after `glossary sync`
  cacheSize = 2000,
  aiTimeoutMs = 15_000,
  now = () => Date.now(),
  onEvent = () => {},
} = {}) {
  const termPattern = buildTermPattern(doNotTranslate);
  const cache = new Map();
  const deeplState = { downUntil: 0, lastError: null, lastKind: null };
  const stats = { requests: 0, cacheHits: 0, skipped: 0, chars: { deepl: 0, ai: 0 }, byEngine: { deepl: 0, ai: 0, none: 0, cache: 0 }, fallbacks: 0, failures: 0 };

  const formalityFor = (to) => formality[normalizeLang(to)] || formality['*'] || undefined;
  const glossaryFor = (from, to) => (from ? glossaries[`${normalizeLang(from)}>${normalizeLang(to)}`] : undefined);

  function remember(k, v) {
    if (cache.size >= cacheSize) cache.delete(cache.keys().next().value);
    cache.set(k, v);
  }

  /**
   * translate({ text, to, from?, context? })
   * -> { text, original, from, to, engine: 'deepl'|'ai'|'none', model?, cached, untranslated, ms, error? }
   * `from` is a hint; DeepL's detected source language is returned when it is not given.
   */
  async function translate({ text, to, from, context } = {}) {
    const t0 = now();
    const original = String(text ?? '');
    const target = normalizeLang(to);
    if (!target) throw new Error(`Unsupported target language "${to}"`);
    const hint = normalizeLang(from);
    stats.requests++;
    const base = { original, to: target, cached: false, untranslated: false };

    if (!original.trim()) return { ...base, text: original, from: hint || target, engine: 'none', ms: 0 };
    if (hint && hint === target) {
      stats.skipped++;
      stats.byEngine.none++;
      return { ...base, text: original, from: hint, engine: 'none', ms: 0 };
    }
    // Clearly already in the target language: skip the API call (saves characters).
    if (!hint) {
      const d = detectLanguage(original);
      if (d.lang === target && d.confidence >= 0.8 && d.words >= 4) {
        stats.skipped++;
        stats.byEngine.none++;
        return { ...base, text: original, from: target, engine: 'none', ms: 0 };
      }
    }

    const form = formalityFor(target);
    const cacheKey = `${hint || '*'}>${target}|${form || ''}|${original}`;
    if (cache.has(cacheKey)) {
      stats.cacheHits++;
      stats.byEngine.cache++;
      return { ...cache.get(cacheKey), cached: true, ms: now() - t0 };
    }

    const { masked, values } = mask(original, { termPattern });
    const errors = [];

    // 1) DeepL
    if (deepl?.configured && now() >= deeplState.downUntil) {
      try {
        const glossaryId = hint ? glossaryIds[`${hint}>${target}`] : undefined;
        const [r] = await deepl.translate({
          texts: [toDeeplXml(masked)],
          target: deeplTarget(target, { englishVariant }),
          source: glossaryId ? hint : undefined,
          formality: form,
          glossaryId,
          context,
          xml: true,
        });
        deeplState.lastError = null;
        const out = { ...base, text: restore(fromDeeplXml(r.text), values), from: normalizeLang(r.detected) || hint || null, engine: 'deepl' };
        stats.chars.deepl += original.length;
        stats.byEngine.deepl++;
        remember(cacheKey, out);
        return { ...out, ms: now() - t0 };
      } catch (e) {
        const kind = e.kind || 'unknown';
        deeplState.lastError = e.message;
        deeplState.lastKind = kind;
        const cd = e.retryAfterMs || COOLDOWN[kind] || 0;
        if (cd) deeplState.downUntil = now() + cd;
        errors.push(`deepl: ${e.message}`);
        onEvent({ type: 'deepl_failure', kind, message: e.message, cooldownMs: cd });
      }
    }

    // 2) AI fallback chain
    if (ai?.configured) {
      try {
        const r = await ai.translate({
          text: masked,
          to: target,
          from: hint,
          formal: /more/.test(form || ''),
          glossary: glossaryFor(hint, target),
          context,
          timeoutMs: aiTimeoutMs,
        });
        const out = { ...base, text: restore(r.text, values), from: normalizeLang(r.detected) || hint || null, engine: 'ai', model: r.target };
        stats.chars.ai += original.length;
        stats.byEngine.ai++;
        if (errors.length) stats.fallbacks++;
        remember(cacheKey, out);
        onEvent({ type: 'ai_translation', model: r.target, afterDeeplError: errors.length > 0 });
        return { ...out, ms: now() - t0 };
      } catch (e) {
        errors.push(`ai: ${e.message}`);
        onEvent({ type: 'ai_failure', message: e.message });
      }
    }

    // 3) Last resort: deliver the original text, clearly flagged.
    stats.failures++;
    stats.byEngine.none++;
    const guess = hint || detectLanguage(original).lang || null;
    return { ...base, text: original, from: guess, engine: 'none', untranslated: guess !== target, error: errors.join(' | ') || 'no translation engine configured', ms: now() - t0 };
  }

  return {
    translate,
    stats: () => ({ ...stats, chars: { ...stats.chars }, byEngine: { ...stats.byEngine }, cacheSize: cache.size }),
    health: () => ({
      deepl: !deepl?.configured
        ? 'not configured'
        : now() < deeplState.downUntil
          ? `cooling (${deeplState.lastKind}) for ${Math.ceil((deeplState.downUntil - now()) / 1000)}s`
          : deeplState.lastError
            ? `ok (last error: ${deeplState.lastError})`
            : deepl.mock
              ? 'ok (mock)'
              : 'ok',
      ai: ai?.configured ? 'ready' : 'not configured',
    }),
    setGlossaryIds(ids) {
      Object.assign(glossaryIds, ids);
    },
    engines: { deepl, ai },
  };
}
