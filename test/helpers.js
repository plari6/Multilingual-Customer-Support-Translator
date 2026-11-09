import { createLLMRouter } from '../src/ai/index.js';
import { buildConfig } from '../src/config.js';
import { createApp } from '../src/index.js';
import { silentLogger } from '../src/logger.js';
import { createSimulator } from '../src/simulator.js';
import { createMockTelegram } from '../src/telegram/mock.js';
import { createMockTranslator } from '../src/translate/mock.js';

export const STAFF = '-100500';

export function testConfig(env = {}) {
  const cfg = buildConfig({ STAFF_CHAT_ID: STAFF, TELEGRAM_BOT_TOKEN: 'x', STAFF_TOPICS: 'off', API_KEY: 'secret', ...env });
  return cfg;
}

/** Fake AI router: `reply(req)` returns the model text (or throws). */
export function fakeRouter(reply) {
  const calls = [];
  const router = createLLMRouter({
    chain: [{ provider: 'fake', model: 'translator-1' }],
    providers: {
      fake: {
        configured: true,
        async complete(req) {
          calls.push(req);
          return { text: await reply(req) };
        },
      },
    },
    lastChance: false,
  });
  router.calls = calls;
  return router;
}

export function makeApp({ env = {}, topics = false, failWith, aiRouter, blocked = [] } = {}) {
  const config = testConfig({ STAFF_TOPICS: topics ? 'on' : 'off', ...env });
  const tg = createMockTelegram({ forum: topics, blocked });
  const deepl = createMockTranslator({ failWith });
  const app = createApp({ config, mockTelegram: tg, deepl, aiRouter, noAi: !aiRouter, logger: silentLogger, mock: true });
  const sim = createSimulator(app);
  return { app, tg, deepl, sim };
}
