#!/usr/bin/env node
import readline from 'node:readline';
import { Command } from 'commander';
import { buildConfig, loadDotenv } from '../src/config.js';
import { createApp, createTranslationStack } from '../src/index.js';
import { detectLanguage, langLabel, normalizeLang } from '../src/languages.js';
import { createLogger } from '../src/logger.js';
import { createServer } from '../src/server.js';
import { createSimulator } from '../src/simulator.js';
import { createMockTelegram } from '../src/telegram/mock.js';

await loadDotenv();

const program = new Command();
program
  .name('support-translator')
  .description('Translate live customer support chats (Telegram) between English, French and German with DeepL.')
  .version('1.0.0')
  .option('--profile <file>', 'client profile JSON (company, languages, glossary, macros)')
  .option('--no-ai', 'disable the AI fallback chain (DeepL only)')
  .option('--simulate-outage <engines>', 'make engines fail with 503, e.g. "deepl" or "deepl,gemini"', '')
  .option('--log-level <level>', 'debug | info | warn | error | silent', process.env.LOG_LEVEL || 'info');

const opts = () => program.opts();
const env = () => ({ ...process.env, ...(opts().profile ? { PROFILE_FILE: opts().profile } : {}) });
const simulate = () => String(opts().simulateOutage || '').split(',').map((s) => s.trim()).filter(Boolean);
const logger = () => createLogger(opts().logLevel);
const plain = (html) => String(html ?? '').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const indent = (s, pad = '      ') => s.split('\n').map((l) => pad + l).join('\n');
const C = process.stdout.isTTY && !process.env.NO_COLOR
  ? { dim: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m`, c: (s) => `\x1b[36m${s}\x1b[0m`, g: (s) => `\x1b[32m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m` }
  : { dim: String, b: String, c: String, g: String, y: String };

function liveApp() {
  const app = createApp({ env: env(), noAi: !opts().ai, simulate: simulate(), logger: logger() });
  if (!app.config.telegram.token) throw new Error('TELEGRAM_BOT_TOKEN is not set (see .env.example)');
  if (!app.config.telegram.staffChatId) app.logger.warn('STAFF_CHAT_ID is not set: add the bot to your team group, send /whoami there, and put the id in .env');
  if (!app.deepl.configured) app.logger.warn('DEEPL_API_KEY is not set: translations will use the AI fallback chain only');
  return app;
}

/** Offline app for demo/chat: mock Telegram (prints messages), mock or real translation. */
function offlineApp({ mock = true, topics = false, print } = {}) {
  const cfg = buildConfig(env());
  cfg.telegram.staffChatId = cfg.telegram.staffChatId || '-1001234567890';
  cfg.telegram.topics = topics ? 'on' : 'off';
  const tg = createMockTelegram({ forum: topics, onSend: print });
  const app = createApp({ env: env(), config: cfg, mock, mockTelegram: tg, noAi: !opts().ai, simulate: simulate(), logger: logger() });
  return app;
}

function printer(app, names = {}) {
  return (entry) => {
    const p = entry.params;
    const staff = String(p.chat_id) === String(app?.config?.telegram.staffChatId || '-1001234567890');
    const text = plain(p.text ?? p.caption ?? (entry.method === 'copyMessage' ? '(file)' : ''));
    const buttons = (p.reply_markup?.inline_keyboard || []).flat().map((b) => `[${b.text}]`).join(' ');
    const who = staff ? C.c(`  👥 staff group${p.message_thread_id ? ` (topic ${p.message_thread_id})` : ''} ◀ bot`) : C.g(`  📱 ${names[p.chat_id] || p.chat_id} ◀ bot`);
    console.log(`${who}\n${indent(text)}${buttons ? `\n${indent(C.dim(buttons))}` : ''}\n`);
  };
}

// ------------------------------------------------------------------ live

program
  .command('start')
  .description('run the bot with long polling (no public URL needed)')
  .action(async () => {
    const app = liveApp();
    const me = await app.tg.call('getMe');
    app.logger.info(`@${me.username} is running (long polling). Agent language ${app.config.agentLanguage}, customers ${app.config.supportedLanguages.join('/')}. Ctrl+C to stop.`);
    const ac = new AbortController();
    const stop = () => {
      ac.abort();
      app.store.flush();
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    await app.bot.poll({ signal: ac.signal });
  });

program
  .command('serve')
  .description('HTTP server: Telegram webhook, /health and the /api routes')
  .option('-p, --port <port>', 'port', (v) => Number(v))
  .option('--poll', 'also receive Telegram updates by long polling (no webhook)')
  .action(async (o) => {
    const app = liveApp();
    const port = o.port || app.config.port;
    const http = createServer(app);
    http.listen(port, () => app.logger.info(`listening on :${port}  POST /telegram/webhook  GET /health  /api/* ${app.config.apiKey ? '(API key set)' : '(disabled: set API_KEY)'}`));
    if (o.poll) app.bot.poll().catch((e) => app.logger.error(e.message));
    const stop = () => {
      app.store.flush();
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });

program
  .command('set-webhook')
  .description('point Telegram to PUBLIC_URL/telegram/webhook')
  .action(async () => {
    const app = liveApp();
    const url = `${app.config.telegram.publicUrl}/telegram/webhook`;
    if (!app.config.telegram.publicUrl) throw new Error('PUBLIC_URL is not set');
    await app.tg.call('setWebhook', { url, allowed_updates: ['message', 'edited_message', 'callback_query'], ...(app.config.telegram.webhookSecret ? { secret_token: app.config.telegram.webhookSecret } : {}) });
    console.log(`Webhook set: ${url}${app.config.telegram.webhookSecret ? ' (with secret token)' : ' (tip: set TELEGRAM_WEBHOOK_SECRET)'}`);
  });

program
  .command('delete-webhook')
  .description('remove the webhook (needed before `start`)')
  .action(async () => {
    const app = liveApp();
    await app.tg.call('deleteWebhook', { drop_pending_updates: false });
    console.log('Webhook removed.');
  });

// ------------------------------------------------------------------ translation tools

program
  .command('translate')
  .description('translate a text the way the bot would (DeepL -> AI fallback -> original)')
  .argument('<text...>')
  .requiredOption('-t, --to <lang>', 'target language (EN, FR, DE, ...)')
  .option('-f, --from <lang>', 'source language (default: auto-detect)')
  .option('--mock', 'use the offline demo translator')
  .option('--json', 'JSON output')
  .action(async (words, o) => {
    const config = buildConfig(env());
    const { translator } = createTranslationStack({ config, env: env(), mock: o.mock, noAi: !opts().ai, simulate: simulate(), logger: logger() });
    const r = await translator.translate({ text: words.join(' '), to: o.to, from: o.from });
    if (o.json) return console.log(JSON.stringify(r, null, 2));
    console.log(r.text);
    console.error(C.dim(`${r.from || '?'} → ${r.to} · ${r.engine}${r.model ? ` (${r.model})` : ''} · ${r.ms} ms${r.untranslated ? ` · NOT TRANSLATED: ${r.error}` : ''}`));
    if (r.untranslated) process.exitCode = 2;
  });

program
  .command('detect')
  .description('offline language detection (used for short messages and when DeepL is down)')
  .argument('<text...>')
  .action((words) => {
    const d = detectLanguage(words.join(' '));
    console.log(d.lang ? `${langLabel(d.lang)}  confidence ${d.confidence}  (${d.words} words)` : 'unknown');
  });

program
  .command('usage')
  .description('DeepL characters used this billing period')
  .action(async () => {
    const config = buildConfig(env());
    const { deepl } = createTranslationStack({ config, env: env(), noAi: true, logger: logger() });
    const u = await deepl.usage();
    const pct = u.character_limit ? ((u.character_count / u.character_limit) * 100).toFixed(1) : '?';
    console.log(`DeepL (${deepl.base}): ${u.character_count.toLocaleString()} / ${u.character_limit.toLocaleString()} characters (${pct}%)`);
  });

program
  .command('languages')
  .description('target languages available on your DeepL plan')
  .action(async () => {
    const config = buildConfig(env());
    const { deepl } = createTranslationStack({ config, env: env(), noAi: true, logger: logger() });
    for (const l of await deepl.languages('target')) console.log(`${l.language.padEnd(8)} ${l.name}${l.supports_formality ? '  (formality)' : ''}`);
  });

program
  .command('glossary')
  .description('DeepL glossaries from the profile "glossary" section: sync | list | delete <id>')
  .argument('<action>', 'sync | list | delete')
  .argument('[id]')
  .action(async (action, id) => {
    const app = createApp({ env: env(), noAi: true, logger: logger(), mockTelegram: createMockTelegram() });
    const { deepl, store, config } = app;
    if (action === 'list') {
      const list = await deepl.listGlossaries();
      if (!list.length) console.log('No glossaries on this DeepL account.');
      for (const g of list) console.log(`${g.glossary_id}  ${g.source_lang}>${g.target_lang}  ${g.entry_count} entries  ${g.name}`);
      return;
    }
    if (action === 'delete') {
      if (!id) throw new Error('usage: glossary delete <id>');
      await deepl.deleteGlossary(id);
      for (const [k, v] of Object.entries(store.data.glossaryIds)) if (v === id) delete store.data.glossaryIds[k];
      store.flush();
      return console.log(`Deleted ${id}`);
    }
    if (action !== 'sync') throw new Error('action must be sync, list or delete');
    const pairs = Object.entries(config.glossary);
    if (!pairs.length) return console.log('The profile has no "glossary" section.');
    // DeepL glossaries are immutable: replace the old one for each pair.
    for (const [pair, entries] of pairs) {
      const [src, tgt] = pair.split('>').map(normalizeLang);
      if (!src || !tgt || !Object.keys(entries).length) continue;
      const old = store.data.glossaryIds[`${src}>${tgt}`];
      if (old) await deepl.deleteGlossary(old).catch(() => {});
      const g = await deepl.createGlossary({ name: `${config.company} ${src}>${tgt}`, source: src, target: tgt, entries });
      store.data.glossaryIds[`${src}>${tgt}`] = g.glossary_id;
      console.log(`${src}>${tgt}: ${Object.keys(entries).length} terms -> ${g.glossary_id}`);
    }
    store.flush();
    console.log('Glossaries saved. They apply when the source language is known (customer/agent language detected).');
  });

// ------------------------------------------------------------------ data

program
  .command('conversations')
  .description('list conversations')
  .option('-s, --status <status>', 'open | closed | blocked')
  .option('--json', 'JSON output')
  .action((o) => {
    const app = createApp({ env: env(), noAi: true, logger: logger(), mockTelegram: createMockTelegram() });
    const list = app.store.list({ status: o.status });
    if (o.json) return console.log(JSON.stringify(list.map(({ messages, ...c }) => ({ ...c, messageCount: messages.length })), null, 2));
    if (!list.length) return console.log('No conversations yet.');
    for (const c of list) console.log(`#${String(c.number).padEnd(4)} ${c.status.padEnd(7)} ${langLabel(c.lang || '?')}  ${c.name.padEnd(22)} ${String(c.messages.length).padStart(3)} msgs  ${c.rating ? `${c.rating}⭐ ` : ''}last ${c.lastAt.slice(0, 16).replace('T', ' ')}`);
  });

program
  .command('transcript')
  .description('bilingual transcript of a conversation (number or chat id)')
  .argument('<id>')
  .option('--json', 'JSON output')
  .action((id, o) => {
    const app = createApp({ env: env(), noAi: true, logger: logger(), mockTelegram: createMockTelegram() });
    const conv = app.store.findConversation(id);
    if (!conv) throw new Error(`conversation ${id} not found`);
    console.log(o.json ? JSON.stringify(conv, null, 2) : app.bot.transcriptText(conv, { html: false }));
  });

program
  .command('stats')
  .description('volume, languages, ratings')
  .option('--json', 'JSON output')
  .action((o) => {
    const app = createApp({ env: env(), noAi: true, logger: logger(), mockTelegram: createMockTelegram() });
    const s = app.bot.stats();
    if (o.json) return console.log(JSON.stringify(s, null, 2));
    console.log(`Conversations ${s.conversations} (open ${s.open}, closed ${s.closed})\nMessages ${s.messagesIn} in / ${s.messagesOut} out\nLanguages ${Object.entries(s.byLanguage).map(([l, n]) => `${l} ${n}`).join(', ') || '-'}\nAverage rating ${s.avgRating ?? '-'} (${s.ratings} ratings)`);
  });

// ------------------------------------------------------------------ doctor

program
  .command('doctor')
  .description('check Telegram, staff group, DeepL and the AI fallback chain')
  .option('--ping', 'send a real test translation through DeepL and each AI model')
  .action(async (o) => {
    const config = buildConfig(env());
    const log = createLogger('silent');
    const ok = (s) => console.log(`  ${C.g('✔')} ${s}`);
    const bad = (s) => {
      console.log(`  ${C.y('✖')} ${s}`);
      process.exitCode = 1;
    };
    const info = (s) => console.log(`  ${C.dim('•')} ${s}`);
    console.log(C.b('Profile'));
    info(`${config.company} · agents write in ${langLabel(config.agentLanguage)} · customers ${config.supportedLanguages.join('/')} · ${Object.keys(config.macros).length} macros · ${Object.keys(config.glossary).length} glossary pairs`);

    console.log(C.b('Telegram'));
    if (!config.telegram.token) bad('TELEGRAM_BOT_TOKEN not set (create a bot with @BotFather)');
    else {
      const app = createApp({ env: env(), noAi: true, logger: log });
      try {
        const me = await app.tg.call('getMe');
        ok(`bot @${me.username}`);
        const wh = await app.tg.call('getWebhookInfo');
        info(wh.url ? `webhook ${wh.url}${wh.last_error_message ? ` (last error: ${wh.last_error_message})` : ''}` : 'no webhook (use `start` for long polling)');
        if (!config.telegram.staffChatId) bad('STAFF_CHAT_ID not set: add the bot to your team group and send /whoami');
        else {
          const chat = await app.tg.call('getChat', { chat_id: config.telegram.staffChatId });
          ok(`staff chat "${chat.title}" (${chat.type}${chat.is_forum ? ', topics on' : ''})`);
          const member = await app.tg.call('getChatMember', { chat_id: config.telegram.staffChatId, user_id: me.id });
          if (chat.is_forum && config.telegram.topics !== 'off' && !(member.status === 'administrator' && member.can_manage_topics)) bad('topics: make the bot an admin with "Manage topics" (or set STAFF_TOPICS=off)');
          if (!chat.is_forum && member.status !== 'administrator' && me.can_read_all_group_messages !== true) info('tip: agents must REPLY to bot messages (privacy mode on) – or make the bot an admin');
        }
      } catch (e) {
        bad(`Telegram: ${e.message}`);
      }
    }

    console.log(C.b('DeepL'));
    const { deepl, router, translator } = createTranslationStack({ config, env: env(), noAi: !opts().ai, logger: log });
    if (!deepl.configured) bad('DEEPL_API_KEY not set (free key: https://www.deepl.com/pro-api, 500,000 characters/month)');
    else {
      try {
        const u = await deepl.usage();
        ok(`${deepl.base} · ${u.character_count.toLocaleString()} / ${u.character_limit.toLocaleString()} characters used`);
        if (u.character_limit && u.character_count / u.character_limit > 0.9) bad('over 90% of the monthly DeepL quota used');
        if (o.ping) {
          const r = await deepl.translate({ texts: ['Where is my order?'], target: 'FR' });
          ok(`ping: "Where is my order?" -> "${r[0].text}"`);
        }
      } catch (e) {
        bad(`DeepL: ${e.message}`);
      }
    }

    console.log(C.b('AI fallback chain'));
    if (!router) info('disabled (--no-ai)');
    else {
      const targets = router.status();
      const usable = targets.filter((t) => t.state !== 'disabled');
      if (!usable.length) info('no AI keys set (GEMINI_API_KEY, GROQ_API_KEY, ...): if DeepL fails, messages are delivered untranslated');
      for (const t of targets) {
        if (t.state === 'disabled') continue;
        if (!o.ping) {
          info(`${t.id} ready`);
          continue;
        }
        try {
          const r = await router.generate({ only: t.id, system: 'Translate to French. Reply with the translation only.', messages: [{ role: 'user', content: 'Where is my order?' }], maxTokens: 1024, totalBudgetMs: 20000 });
          ok(`${t.id} -> "${r.text.trim().slice(0, 60)}"`);
        } catch (e) {
          bad(`${t.id}: ${e.message.slice(0, 120)}`);
        }
      }
    }
    if (o.ping) {
      const r = await translator.translate({ text: 'Bonjour, ma commande #1042 n\'est pas arrivée.', to: config.agentLanguage });
      console.log(C.b('Pipeline'));
      (r.untranslated ? bad : ok)(`"${r.text}" (${r.engine}${r.model ? ` ${r.model}` : ''}, ${r.ms} ms)`);
    }
  });

// ------------------------------------------------------------------ demo & chat

program
  .command('demo')
  .description('scripted conversation with two customers (FR, DE) and one English agent – offline')
  .option('--topics', 'staff group with one forum topic per customer')
  .option('--live', 'use your real DeepL / AI keys instead of the offline demo translator')
  .action(async (o) => {
    const names = { 7001: 'Marie (FR)', 7002: 'Lukas (DE)' };
    let app;
    const print = (e) => printer(app, names)(e);
    app = offlineApp({ mock: !o.live, topics: o.topics, print });
    const sim = createSimulator(app);
    const marie = sim.customer({ id: 7001, first_name: 'Marie', last_name: 'Dupont', language_code: 'fr' });
    const lukas = sim.customer({ id: 7002, first_name: 'Lukas', last_name: 'Becker', language_code: 'de' });
    const alex = sim.agent({ id: 900, first_name: 'Alex' });
    const step = async (who, text, fn) => {
      console.log(C.b(`▶ ${who}: `) + text);
      await fn();
      await sim.idle();
    };
    const reply = (text, to) => (o.topics ? alex.inTopic(text, { of: to }) : alex.reply(text, { to }));
    console.log(C.b(`\nDemo – ${app.config.company} support · agent writes ${app.config.agentLanguage} · ${o.live ? 'live translation' : 'offline demo translator'}${simulate().length ? ` · outage: ${simulate().join(',')}` : ''}\n`));

    await step('Marie (Telegram, French)', '/start', () => marie.say('/start'));
    await step('Marie', 'Bonjour, ma commande #1042 n\'est toujours pas arrivée.', () => marie.say('Bonjour, ma commande #1042 n\'est toujours pas arrivée.'));
    await step('Alex (agent, replies in English)', 'Hi Marie, I\'m sorry for the delay. Your package was shipped yesterday with tracking number 1Z999AA10123456784.', () =>
      reply('Hi Marie, I\'m sorry for the delay. Your package was shipped yesterday with tracking number 1Z999AA10123456784.', 7001),
    );
    await step('Lukas (Telegram, German)', 'Hallo, ich möchte eine Rückerstattung für meine Bestellung #2077. Die Jacke ist zu klein.', () =>
      lukas.say('Hallo, ich möchte eine Rückerstattung für meine Bestellung #2077. Die Jacke ist zu klein.'),
    );
    await step('Marie', 'Merci beaucoup ! Est-ce que je peux changer l\'adresse de livraison ?', () => marie.say('Merci beaucoup ! Est-ce que je peux changer l\'adresse de livraison ?'));
    await step('Alex → Marie', 'Yes, please send me the new address and I will update it right away.', () => reply('Yes, please send me the new address and I will update it right away.', 7001));
    await step('Alex → Lukas (saved reply)', '/m returns', () => reply('/m returns', 7002));
    await step('Alex → Lukas', '// internal note: refund approved by Sam', () => reply('// refund approved by Sam', 7002));
    await step('Alex → Lukas', 'Of course. Your refund has been issued and will appear on your account within 5 business days.', () =>
      reply('Of course. Your refund has been issued and will appear on your account within 5 business days.', 7002),
    );
    await step('Lukas', 'Danke!', () => lukas.say('Danke!'));
    await step('Alex → Lukas', '/close', () => reply('/close', 7002));
    await step('Lukas presses', '5 ⭐', () => lukas.press('rate:5'));
    await step('Alex', '/stats', () => alex.say('/stats'));
    console.log(C.b('Bilingual transcript #2 (Lukas):'));
    console.log(indent(app.bot.transcriptText(app.store.findConversation(2), { html: false })));
  });

program
  .command('chat')
  .description('interactive terminal chat: you play the customer and the agent')
  .option('--mock', 'force the offline demo translator (default: real DeepL/AI if keys are set)')
  .option('--topics', 'forum topic mode')
  .action(async (o) => {
    const config = buildConfig(env());
    const mock = o.mock || (!config.deepl.apiKey && !process.env.GEMINI_API_KEY && !process.env.GROQ_API_KEY);
    let app;
    const names = {};
    app = offlineApp({ mock, topics: o.topics, print: (e) => printer(app, names)(e) });
    app.logger.info = () => {};
    const sim = createSimulator(app);
    let nextId = 8001;
    const customers = {};
    const use = (name) => {
      const key = name.toLowerCase();
      if (!customers[key]) {
        const id = nextId++;
        names[id] = name;
        customers[key] = sim.customer({ id, first_name: name });
      }
      return customers[key];
    };
    let current = use('Customer');
    const agent = sim.agent({ id: 900, first_name: 'Agent' });
    console.log(`${C.b('Terminal chat')} – translation: ${mock ? 'offline demo translator (unknown sentences show as "[FR] text")' : 'live DeepL / AI'}
  text            customer message (as ${names[current.id]})
  > text          agent reply to the current customer (also: > /m returns, > /close, > /lang DE, > // note)
  /as <name>      switch customer      /press <data>  press a button (e.g. lang:FR, rate:5)
  /staff <cmd>    staff command (e.g. /staff /list)      /quit\n`);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '› ' });
    rl.prompt();
    for await (const line of rl) {
      const s = line.trim();
      try {
        if (!s) {
          // nothing
        } else if (s === '/quit' || s === '/exit') break;
        else if (s.startsWith('/as ')) {
          current = use(s.slice(4).trim());
          console.log(C.dim(`now writing as ${names[current.id]}`));
        } else if (s.startsWith('/press ')) await current.press(s.slice(7).trim());
        else if (s.startsWith('/staff ')) await agent.say(s.slice(7).trim());
        else if (s.startsWith('>')) {
          const text = s.slice(1).trim();
          o.topics ? await agent.inTopic(text, { of: current.id }) : await agent.reply(text, { to: current.id });
        } else await current.say(s);
        await sim.idle();
      } catch (e) {
        console.log(C.y(e.message));
      }
      rl.prompt();
    }
    rl.close();
  });

program.parseAsync().catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
