import { langName } from '../languages.js';

/**
 * LLM translation over the multi-model fallback router - used when DeepL is down,
 * rate limited, out of characters, or not configured.
 */

export function buildPrompt({ text, to, from, formal, glossary = {}, context }) {
  const terms = Object.entries(glossary);
  const system = [
    'You are a professional translator for a customer support team.',
    `Translate the user's message into ${langName(to)}${from ? ` (source language: ${langName(from)})` : ''}.`,
    formal ? 'Use the polite/formal form of address (vous / Sie).' : 'Use a friendly, natural tone.',
    'Keep the meaning, tone, emojis and line breaks. Do not add explanations, greetings or notes.',
    'Tokens like ⟦0⟧ ⟦1⟧ stand for order numbers, links or names: copy every token unchanged, in a natural position.',
    terms.length ? `Use these fixed term translations: ${terms.map(([a, b]) => `"${a}" -> "${b}"`).join('; ')}.` : '',
    'Reply with JSON only: {"translation": "...", "detected_language": "<ISO 639-1 code of the source text>"}',
  ]
    .filter(Boolean)
    .join('\n');
  const user = context ? `Earlier in the conversation (for context only, do not translate):\n${context}\n\nMessage to translate:\n${text}` : text;
  return { system, user };
}

export function parseAiTranslation(raw) {
  const cleaned = String(raw || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  const obj = JSON.parse(start >= 0 ? cleaned.slice(start, end + 1) : cleaned);
  if (typeof obj.translation !== 'string' || !obj.translation.trim()) throw new Error('missing "translation"');
  return { text: obj.translation.trim(), detected: obj.detected_language ? String(obj.detected_language).toUpperCase().slice(0, 2) : undefined };
}

export function createAiTranslator(router) {
  const configured = Boolean(router?.status?.().some((t) => t.state !== 'disabled'));
  return {
    name: 'ai',
    configured,
    async translate({ text, to, from, formal, glossary, context, timeoutMs }) {
      const { system, user } = buildPrompt({ text, to, from, formal, glossary, context });
      const r = await router.generate({
        system,
        messages: [{ role: 'user', content: user }],
        json: true,
        temperature: 0.1,
        maxTokens: 2048,
        totalBudgetMs: timeoutMs,
        parse: parseAiTranslation,
      });
      return { ...r.data, target: r.target };
    },
  };
}
