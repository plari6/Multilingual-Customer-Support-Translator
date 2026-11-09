/**
 * Language registry + a small offline language detector.
 *
 * Codes are DeepL base codes (EN, FR, DE, ...). DeepL wants a regional variant
 * for some *target* languages (EN-US/EN-GB, PT-PT/PT-BR); `deeplTarget` handles that.
 */

export const LANGUAGES = {
  EN: { name: 'English', native: 'English', flag: '🇬🇧' },
  FR: { name: 'French', native: 'Français', flag: '🇫🇷' },
  DE: { name: 'German', native: 'Deutsch', flag: '🇩🇪' },
  ES: { name: 'Spanish', native: 'Español', flag: '🇪🇸' },
  IT: { name: 'Italian', native: 'Italiano', flag: '🇮🇹' },
  NL: { name: 'Dutch', native: 'Nederlands', flag: '🇳🇱' },
  PT: { name: 'Portuguese', native: 'Português', flag: '🇵🇹' },
  PL: { name: 'Polish', native: 'Polski', flag: '🇵🇱' },
  SV: { name: 'Swedish', native: 'Svenska', flag: '🇸🇪' },
  DA: { name: 'Danish', native: 'Dansk', flag: '🇩🇰' },
  NB: { name: 'Norwegian', native: 'Norsk', flag: '🇳🇴' },
  FI: { name: 'Finnish', native: 'Suomi', flag: '🇫🇮' },
  CS: { name: 'Czech', native: 'Čeština', flag: '🇨🇿' },
  RO: { name: 'Romanian', native: 'Română', flag: '🇷🇴' },
  TR: { name: 'Turkish', native: 'Türkçe', flag: '🇹🇷' },
  RU: { name: 'Russian', native: 'Русский', flag: '🇷🇺' },
  UK: { name: 'Ukrainian', native: 'Українська', flag: '🇺🇦' },
  AR: { name: 'Arabic', native: 'العربية', flag: '🇸🇦' },
  JA: { name: 'Japanese', native: '日本語', flag: '🇯🇵' },
  ZH: { name: 'Chinese', native: '中文', flag: '🇨🇳' },
  KO: { name: 'Korean', native: '한국어', flag: '🇰🇷' },
};

/** "en", "en-gb", "EN_US", "fr-CA" -> "EN" / "FR"; unknown -> null */
export function normalizeLang(code) {
  if (!code) return null;
  const base = String(code).trim().toUpperCase().replace('_', '-').split('-')[0];
  return LANGUAGES[base] ? base : null;
}

export const langName = (code) => LANGUAGES[normalizeLang(code)]?.name || String(code || '?');
export const langFlag = (code) => LANGUAGES[normalizeLang(code)]?.flag || '🌐';
export const langLabel = (code) => `${langFlag(code)} ${normalizeLang(code) || code}`;

/** DeepL target code: EN -> EN-US (or EN-GB), PT -> PT-PT (or PT-BR). */
export function deeplTarget(code, { englishVariant = 'EN-US', portugueseVariant = 'PT-PT' } = {}) {
  const raw = String(code || '').toUpperCase();
  if (/^(EN-US|EN-GB|PT-PT|PT-BR|ZH-HANS|ZH-HANT)$/.test(raw)) return raw;
  const base = normalizeLang(code);
  if (base === 'EN') return englishVariant;
  if (base === 'PT') return portugueseVariant;
  return base;
}

/** "EN,FR,DE" -> ['EN','FR','DE']; "*" -> every registered language. */
export function parseLanguageList(spec, fallback = ['EN', 'FR', 'DE']) {
  if (!spec) return fallback;
  if (String(spec).trim() === '*') return Object.keys(LANGUAGES);
  const list = String(spec)
    .split(/[,\s]+/)
    .map(normalizeLang)
    .filter(Boolean);
  return list.length ? [...new Set(list)] : fallback;
}

// ---------------------------------------------------------------- offline detector

const STOPWORDS = {
  EN: 'the and is are was you your my i it to of in for on with this that have has not please thanks thank hello hi where when what why how can could would order help refund package delivery received yet still',
  FR: 'le la les et est sont je vous votre mon ma mes ne pas une un des du de pour avec sur dans que qui bonjour merci où quand comment pourquoi commande remboursement colis livraison reçu toujours encore svp suis ai',
  DE: 'der die das und ist sind ich sie ihr mein meine nicht ein eine einen mit für auf zu von den dem bitte danke hallo guten tag wo wann wie warum bestellung rückerstattung paket lieferung erhalten noch immer habe bin',
  ES: 'el la los las y es son yo usted su mi no un una de para con en que hola gracias dónde cuándo cómo pedido reembolso paquete',
  IT: 'il lo la gli le e è sono io lei suo mio non un una di per con che ciao grazie dove quando come ordine rimborso pacco',
  NL: 'de het een en is zijn ik u uw mijn niet met voor op van dat hallo dank bedankt waar wanneer hoe bestelling terugbetaling pakket',
};
const STOP = Object.fromEntries(Object.entries(STOPWORDS).map(([k, v]) => [k, new Set(v.split(' '))]));

const CHAR_HINTS = [
  [/[ßäöü]/i, 'DE', 2],
  [/[éèêëàâçœîïôûù]/i, 'FR', 1.5],
  [/[ñ¿¡áíóú]/i, 'ES', 1.5],
  [/[؀-ۿ]/, 'AR', 10],
  [/[Ѐ-ӿ]/, 'RU', 10],
  [/[぀-ヿ]/, 'JA', 10],
  [/[一-鿿]/, 'ZH', 8],
  [/[가-힯]/, 'KO', 10],
];

/**
 * Cheap offline detection (stopwords + accented characters).
 * -> { lang, confidence 0..1, words } ; lang is null when nothing matched.
 * Used to keep short messages ("ok", "merci") in the conversation's language and
 * as the detector when DeepL is unavailable.
 */
export function detectLanguage(text, { candidates } = {}) {
  const clean = String(text || '').toLowerCase().replace(/https?:\/\/\S+|\S+@\S+|#?\d[\d-]*/g, ' ');
  const words = clean.match(/[\p{L}']+/gu) || [];
  const scores = {};
  for (const w of words) {
    const parts = w.split("'").filter(Boolean); // l'adresse -> l, adresse
    for (const p of [w, ...parts]) {
      for (const [lang, set] of Object.entries(STOP)) if (set.has(p)) scores[lang] = (scores[lang] || 0) + 1;
    }
  }
  for (const [re, lang, weight] of CHAR_HINTS) if (re.test(clean)) scores[lang] = (scores[lang] || 0) + weight;
  let ranked = Object.entries(scores);
  if (candidates?.length) ranked = ranked.filter(([l]) => candidates.includes(l));
  ranked.sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return { lang: null, confidence: 0, words: words.length };
  const [best, top] = ranked[0];
  const second = ranked[1]?.[1] || 0;
  const total = ranked.reduce((s, [, v]) => s + v, 0);
  const confidence = Math.min(1, (top / total) * Math.min(1, top / 3) * (top > second ? 1 : 0.5));
  return { lang: best, confidence: Number(confidence.toFixed(2)), words: words.length };
}
