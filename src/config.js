import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeLang, parseLanguageList } from './languages.js';

export const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Load .env from the current folder, then from the project folder (unless SUPPORT_TRANSLATOR_SKIP_DOTENV=1). */
export async function loadDotenv() {
  if (process.env.SUPPORT_TRANSLATOR_SKIP_DOTENV === '1') return;
  const { config } = await import('dotenv');
  for (const p of [path.resolve('.env'), path.join(PROJECT_DIR, '.env')]) if (fs.existsSync(p)) config({ path: p, quiet: true });
}

export function loadProfile(file) {
  const p = file ? path.resolve(file) : path.join(PROJECT_DIR, 'examples', 'profile.json');
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`Cannot read profile ${p}: ${e.message}`);
  }
}

const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));
const list = (v) => String(v || '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);

/** Merge env + profile into one config object. Env wins over the profile. */
export function buildConfig(env = process.env, profileOverride) {
  const profile = profileOverride || loadProfile(env.PROFILE_FILE);
  const supported = parseLanguageList(env.SUPPORTED_LANGUAGES || (profile.supportedLanguages || []).join(','));
  const agentLanguage = normalizeLang(env.AGENT_LANGUAGE || profile.agentLanguage) || 'EN';
  const formality = { ...(profile.formality || {}) };
  if (env.FORMALITY) for (const L of supported) formality[L] = env.FORMALITY; // e.g. prefer_less for a casual brand
  return {
    company: env.COMPANY_NAME || profile.company || 'our',
    supportHours: env.SUPPORT_HOURS || profile.supportHours || '24/7',
    agentLanguage,
    supportedLanguages: supported,
    fallbackCustomerLanguage: normalizeLang(env.FALLBACK_CUSTOMER_LANGUAGE || profile.fallbackCustomerLanguage) || supported[0] || 'EN',
    formality,
    doNotTranslate: [...(profile.doNotTranslate || []), ...list(env.DO_NOT_TRANSLATE)],
    glossary: profile.glossary || {},
    macros: profile.macros || {},
    englishVariant: env.DEEPL_ENGLISH_VARIANT || 'EN-US',
    translationNote: bool(env.TRANSLATION_NOTE, true),
    showOriginalToAgent: bool(env.SHOW_ORIGINAL_TO_AGENT, true),
    firstAck: bool(env.FIRST_ACK, true),
    contextMessages: Number(env.CONTEXT_MESSAGES ?? 3),
    telegram: {
      token: env.TELEGRAM_BOT_TOKEN || '',
      staffChatId: env.STAFF_CHAT_ID || '',
      topics: (env.STAFF_TOPICS || 'auto').toLowerCase(), // auto | on | off
      agentIds: list(env.AGENT_USER_IDS),
      webhookSecret: env.TELEGRAM_WEBHOOK_SECRET || '',
      publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
    },
    deepl: { apiKey: env.DEEPL_API_KEY || '', baseUrl: env.DEEPL_API_URL || '' },
    port: Number(env.PORT) || 3000,
    apiKey: env.API_KEY || '',
    dataFile: env.DATA_FILE || path.resolve('data', 'support-translator.json'),
  };
}
