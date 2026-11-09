import { createRouterFromEnv } from './ai/index.js';
import { createBot } from './bot.js';
import { buildConfig } from './config.js';
import { createLogger } from './logger.js';
import { createStore } from './store.js';
import { createTelegramApi } from './telegram/api.js';
import { createMockTelegram } from './telegram/mock.js';
import { createAiTranslator } from './translate/ai.js';
import { createDeeplClient } from './translate/deepl.js';
import { createMockTranslator } from './translate/mock.js';
import { createTranslator } from './translate/translator.js';

export { buildConfig, createBot, createStore, createTranslator, createDeeplClient, createMockTranslator, createMockTelegram };

/**
 * Build the translation pipeline from config/env.
 * mock: true -> offline DeepL stand-in (demo/tests). noAi: true -> skip the LLM fallback.
 * simulate: ['deepl', 'gemini', ...] -> those engines fail with 503 (demo of the fallback).
 */
export function createTranslationStack({ config, env = process.env, mock = false, noAi = false, simulate = [], logger, deepl, aiRouter, fetchImpl } = {}) {
  const log = logger || createLogger();
  const down = new Set(simulate.map((s) => s.toLowerCase()));
  let engine = deepl || (mock ? createMockTranslator() : createDeeplClient({ apiKey: config.deepl.apiKey, baseUrl: config.deepl.baseUrl, fetchImpl }));
  if (down.has('deepl')) engine = createMockTranslator({ failWith: 'overloaded' });
  const router =
    aiRouter ||
    (noAi
      ? null
      : createRouterFromEnv(env, {
          simulate: [...down].filter((s) => s !== 'deepl'),
          onEvent: (e) => e.type === 'failure' && log.warn(`[ai] ${e.target} ${e.kind} -> next model`),
        }));
  const ai = router ? createAiTranslator(router) : null;
  const translator = createTranslator({
    deepl: engine,
    ai,
    englishVariant: config.englishVariant,
    formality: config.formality,
    doNotTranslate: [config.company, ...config.doNotTranslate].filter((x) => x && x !== 'our'),
    glossaries: config.glossary,
    onEvent: (e) => {
      if (e.type === 'deepl_failure') log.warn(`[deepl] ${e.kind}: ${e.message} -> fallback${e.cooldownMs ? ` (paused ${Math.round(e.cooldownMs / 1000)}s)` : ''}`);
      if (e.type === 'ai_failure') log.warn(`[ai] all models failed: ${e.message}`);
    },
  });
  return { translator, deepl: engine, router, ai };
}

/** Everything the bot needs. `mock` replaces Telegram + DeepL with offline fakes. */
export function createApp({ env = process.env, config, mock = false, mockTelegram, noAi = false, simulate = [], logger, store, deepl, aiRouter, fetchImpl, onSend } = {}) {
  const cfg = config || buildConfig(env);
  const log = logger || createLogger();
  const stack = createTranslationStack({ config: cfg, env, mock, noAi, simulate, logger: log, deepl, aiRouter, fetchImpl });
  const tg = mockTelegram || (mock ? createMockTelegram({ onSend }) : createTelegramApi(cfg.telegram.token, { fetchImpl }));
  const db = store || createStore(mock ? null : cfg.dataFile);
  if (db.data.glossaryIds && Object.keys(db.data.glossaryIds).length) stack.translator.setGlossaryIds(db.data.glossaryIds);
  const bot = createBot({ config: cfg, tg, translator: stack.translator, store: db, logger: log });
  return { config: cfg, tg, store: db, bot, logger: log, ...stack };
}
