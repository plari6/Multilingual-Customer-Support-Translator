# Multilingual Customer Support Translator

A Telegram bot that translates live support chats between **English, French and German** (or any DeepL language). Customers write to the bot in their own language. Your agents see every message in *their* language in one Telegram team group and just reply. The bot translates the reply back and delivers it.

**Stack:** Node.js 20+, Express, DeepL API, Telegram Bot API. When DeepL is unavailable, an AI fallback chain (Gemini → Groq → NVIDIA → OpenRouter → Ollama) takes over.

```
 Customer (FR) ──► bot ──► DeepL FR→EN ──► Staff group:  🇫🇷 Marie · #12 · FR→EN
   "Bonjour, ma commande #1042…"                          Hello, my order #1042 still hasn't arrived.
                                                          🇫🇷 Bonjour, ma commande #1042 n'est toujours…
 Customer (FR) ◄── bot ◄── DeepL EN→FR ◄── Agent replies (in English) to that message
   "Bonjour Marie, je suis désolé…  🌐 Traduit automatiquement"
```

## Features

- **Two-way live translation.** Customer messages reach agents in the agent language, with the original shown underneath. Agent replies go out in the customer's language.
- **Language handling.** Detected automatically by DeepL. The welcome message uses the customer's Telegram app language. Customers can pick a language with buttons (`/language`) and agents can set one with `/lang DE`. Short messages like "ok" or "merci" don't flip the language.
- **Nothing gets mistranslated.** Order numbers, tracking numbers, links, emails, `code` and brand names are masked before translation and restored afterwards.
- **Formal tone by default.** French and German replies use *vous* / *Sie* (DeepL `formality`). This is configurable per language.
- **Glossaries.** Your terms ("store credit" → "avoir" / "Gutschrift") are synced to DeepL glossaries, and the AI fallback is given them too.
- **Conversation context.** The last few messages are sent to DeepL as `context`, which gives better pronouns and less ambiguity.
- **Two staff group modes.** In *reply mode*, agents reply to the bot's message. In *forum topics* mode, each customer gets their own topic, renamed with a flag, and ✅ when closed.
- **Agent tools.** Saved replies (`/m returns`, translated automatically), internal notes (`// text`, never sent), `/close` with a 1–5 ⭐ rating request, `/transcript`, `/list`, `/stats`, `/t DE text` (translate for yourself) and a `/whoami` setup helper.
- **Files.** Photos, documents and voice notes are copied both ways, with translated captions.
- **It always delivers.** The order is cache → DeepL → AI fallback chain → the original text, clearly flagged, with a hand-written notice in the customer's language. DeepL errors (quota 456, 429, 5xx, bad key) pause DeepL for a while so chats don't wait on it.
- **HTTP API** for other channels (website chat, email, n8n/Make). It exposes `POST /api/translate`, conversation lists, bilingual transcripts and stats.
- **Storage.** A JSON file that keeps the bilingual history (useful for QA, disputes and training). Customer-facing texts are hand-written in EN/FR/DE.

## Quick start

```bash
npm install
node bin/support-translator.js --no-ai demo            # offline scripted demo (FR + DE customers, EN agent)
node bin/support-translator.js --no-ai demo --topics   # same, with one forum topic per customer
node bin/support-translator.js chat --mock             # play customer and agent in your terminal
npm test                                                # 50 tests, no network
```

### Go live (about 10 minutes)

1. Create a bot with **@BotFather** and copy the token.
2. Get a **DeepL API key** at https://www.deepl.com/pro-api. The free plan gives 500,000 characters a month, and free keys end in `:fx`.
3. Create a Telegram **group for your agents** and add the bot. Then either:
   - **Reply mode:** agents reply to the bot's messages. This works with privacy mode on.
   - **Topics mode (recommended):** turn on *Topics* in the group settings and make the bot an admin with *Manage topics*.
4. `cp .env.example .env` and fill in `TELEGRAM_BOT_TOKEN` and `DEEPL_API_KEY`. Run `start`, send `/whoami` in the group, put the id in `STAFF_CHAT_ID`, then restart.
5. `node bin/support-translator.js doctor --ping` checks the bot, staff group, DeepL quota and each AI model.
6. `node bin/support-translator.js start` uses long polling, so no server or public URL is needed.
   For production, use `serve` + `set-webhook` behind HTTPS (`PUBLIC_URL`, `TELEGRAM_WEBHOOK_SECRET`), or `docker build -t support-translator . && docker run --env-file .env -v st-data:/data -p 3000:3000 support-translator`.
7. Put the bot link (`https://t.me/<bot>`) on the website, in order emails and in the Instagram bio. `https://t.me/<bot>?start=lang_fr` opens the bot already set to French.

## CLI

```
support-translator start                     long polling
support-translator serve [--poll] [-p 3000]  Express: /telegram/webhook, /health, /api/*
support-translator set-webhook | delete-webhook
support-translator translate --to FR [--from EN] [--mock] [--json] <text>
support-translator detect <text>             offline language detection
support-translator usage | languages         DeepL quota / target languages
support-translator glossary sync|list|delete [id]
support-translator conversations [-s open] | transcript <n> [--json] | stats [--json]
support-translator doctor [--ping]
support-translator demo [--topics] [--live] | chat [--mock] [--topics]
global: --profile <file>  --no-ai  --simulate-outage deepl[,gemini]  --log-level debug
```

`--simulate-outage deepl` shows the fallback live in a demo: DeepL "goes down" and the AI chain or the flagged original takes over.

## Agent commands (staff group)

| Command | What it does |
|---|---|
| *reply to a customer message* / write in their topic | translated and sent to the customer |
| `// text` or `/note text` | internal note, saved to the transcript, not sent |
| `/m <name>` · `/macros` | send / list saved replies (translated) |
| `/lang FR` | set the customer's language |
| `/close` (or the ✅ button) | close and ask for a 1–5 ⭐ rating |
| `/transcript` · `/list` · `/stats` | bilingual transcript, open conversations, numbers |
| `/t DE text` | translate something for yourself |
| `/whoami` | chat / user / topic id for the setup |

Commands work as a reply, inside a topic, or with a number: `/close 12`.

## HTTP API

`/api/*` needs `API_KEY` (header `x-api-key: …` or `Authorization: Bearer …`).

```bash
curl -s localhost:3000/api/translate -H "x-api-key: $API_KEY" -H "content-type: application/json" \
  -d '{"text":"Où est ma commande #1042 ?","to":"EN"}'
# {"text":"Where is my order #1042?","from":"FR","to":"EN","engine":"deepl","cached":false,"untranslated":false,"ms":212}
```

| Route | |
|---|---|
| `GET /health` | DeepL state (ok / cooling / not configured), AI chain, counts |
| `POST /telegram/webhook` | Telegram updates (secret token checked) |
| `POST /api/translate` | `{text, to, from?, context?}`, using the same pipeline as the bot |
| `GET /api/conversations?status=open` | conversation list |
| `GET /api/conversations/:id/transcript[?format=json]` | bilingual transcript |
| `GET /api/stats` | volume, languages, ratings, translation engine counters |

## Customizing for a client

Copy `examples/profile.json` and point `PROFILE_FILE` at your copy:

```json
{
  "company": "Maison Nova",
  "supportHours": "Mon-Fri 9:00-18:00 CET",
  "agentLanguage": "EN",
  "supportedLanguages": ["EN", "FR", "DE"],
  "formality": { "FR": "prefer_more", "DE": "prefer_more" },
  "doNotTranslate": ["Maison Nova", "NovaPay"],
  "glossary": { "EN>FR": { "store credit": "avoir" }, "EN>DE": { "store credit": "Gutschrift" } },
  "macros": { "returns": "You can return any unworn item within 30 days…" }
}
```

Then run `glossary sync`. Agents who work in German? Set `"agentLanguage": "DE"`. Want more languages? Set `SUPPORTED_LANGUAGES=EN,FR,DE,ES,IT`, or `*` for all of them. The fixed customer texts live in `src/messages.js`.

## Project layout

```
bin/support-translator.js   CLI (commander)
src/bot.js                  relay logic: customers ⇄ staff group, commands, topics, ratings
src/translate/translator.js cache → DeepL → AI chain → original; masking; DeepL cooldown
src/translate/deepl.js      DeepL v2 client (translate, usage, languages, glossaries)
src/translate/ai.js         LLM translation prompt + JSON validation
src/translate/protect.js    masks order numbers / links / brand terms
src/translate/mock.js       offline translator for demo & tests
src/languages.js            language registry + offline detector
src/server.js               Express webhook + API
src/store.js                JSON storage
src/ai/                     multi-model fallback router
```

## License

MIT
