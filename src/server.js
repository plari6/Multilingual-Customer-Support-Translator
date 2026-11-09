import crypto from 'node:crypto';
import express from 'express';
import { normalizeLang } from './languages.js';

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/**
 * HTTP layer:
 *   POST /telegram/webhook     Telegram updates (X-Telegram-Bot-Api-Secret-Token checked)
 *   GET  /health               translation engines + AI chain status
 *   POST /api/translate        { text, to, from? } -> translation (other channels: web chat, email, n8n)
 *   GET  /api/conversations    ?status=open|closed|blocked
 *   GET  /api/conversations/:id/transcript   ?format=text|json
 *   GET  /api/stats
 * /api/* needs API_KEY (header x-api-key or Bearer token).
 */
export function createServer(app) {
  const { config, bot, translator, store, router, logger } = app;
  const http = express();
  http.disable('x-powered-by');
  http.use(express.json({ limit: '1mb' }));

  http.get('/health', (_req, res) => {
    res.json({
      ok: true,
      translation: translator.health(),
      ai: router ? router.status().map((t) => ({ id: t.id, state: t.state, reason: t.disabledReason || undefined })) : [],
      conversations: store.list().length,
      languages: config.supportedLanguages,
      agentLanguage: config.agentLanguage,
    });
  });

  http.post('/telegram/webhook', (req, res) => {
    if (config.telegram.webhookSecret && !safeEqual(req.get('x-telegram-bot-api-secret-token'), config.telegram.webhookSecret)) {
      return res.status(401).json({ error: 'bad secret token' });
    }
    if (!req.body || typeof req.body !== 'object' || req.body.update_id === undefined) return res.status(400).json({ error: 'not a Telegram update' });
    // Answer Telegram at once; translation runs in the per-conversation queue.
    bot.dispatch(req.body);
    res.json({ ok: true });
  });

  const api = express.Router();
  api.use((req, res, next) => {
    if (!config.apiKey) return res.status(503).json({ error: 'API disabled: set API_KEY to enable /api routes' });
    const given = req.get('x-api-key') || (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!safeEqual(given, config.apiKey)) return res.status(401).json({ error: 'invalid API key' });
    next();
  });

  api.post('/translate', async (req, res) => {
    const { text, to, from, context } = req.body || {};
    if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: '"text" is required' });
    if (text.length > 20000) return res.status(413).json({ error: 'text too long (max 20000 characters)' });
    if (!normalizeLang(to)) return res.status(400).json({ error: '"to" must be a language code like EN, FR or DE' });
    try {
      const r = await translator.translate({ text, to, from, context });
      res.json({ text: r.text, from: r.from, to: r.to, engine: r.engine, model: r.model, cached: r.cached, untranslated: r.untranslated, ms: r.ms });
    } catch (e) {
      logger.error(`/api/translate: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });

  api.get('/conversations', (req, res) => {
    const status = ['open', 'closed', 'blocked'].includes(req.query.status) ? req.query.status : undefined;
    res.json(store.list({ status }).map(({ messages, ...c }) => ({ ...c, messageCount: messages.length, lastMessage: messages.at(-1)?.original?.slice(0, 200) })));
  });

  api.get('/conversations/:id/transcript', (req, res) => {
    const conv = store.findConversation(req.params.id);
    if (!conv) return res.status(404).json({ error: 'conversation not found' });
    if (req.query.format === 'json') return res.json(conv);
    res.type('text/plain; charset=utf-8').send(bot.transcriptText(conv, { html: false }));
  });

  api.get('/stats', (_req, res) => res.json(bot.stats()));

  http.use('/api', api);
  http.use((_req, res) => res.status(404).json({ error: 'not found' }));
  return http;
}
