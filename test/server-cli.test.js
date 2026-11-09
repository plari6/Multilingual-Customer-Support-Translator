import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from '../src/server.js';
import { makeApp } from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'support-translator.js');

function listen(app) {
  return new Promise((resolve) => {
    const s = createServer(app).listen(0, () => resolve(s));
  });
}

describe('HTTP server', () => {
  let server;
  let base;
  let ctx;
  before(async () => {
    ctx = makeApp({ env: { TELEGRAM_WEBHOOK_SECRET: 'whsec' } });
    server = await listen(ctx.app);
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  it('GET /health', async () => {
    const r = await (await fetch(`${base}/health`)).json();
    assert.equal(r.ok, true);
    assert.equal(r.translation.deepl, 'ok (mock)');
    assert.deepEqual(r.languages, ['EN', 'FR', 'DE']);
  });

  it('POST /api/translate needs the API key', async () => {
    const body = JSON.stringify({ text: 'Thank you!', to: 'fr' });
    const no = await fetch(`${base}/api/translate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal(no.status, 401);
    const ok = await fetch(`${base}/api/translate`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'secret' }, body });
    const r = await ok.json();
    assert.equal(r.text, 'Merci !');
    assert.equal(r.engine, 'deepl');
    const bad = await fetch(`${base}/api/translate`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer secret' }, body: JSON.stringify({ text: 'x', to: 'zz' }) });
    assert.equal(bad.status, 400);
  });

  it('webhook checks the secret and processes updates', async () => {
    const update = { update_id: 1, message: { message_id: 1, date: 0, chat: { id: 4242, type: 'private' }, from: { id: 4242, first_name: 'Lena' }, text: 'Hallo, ich möchte eine Rückerstattung für meine Bestellung #2077. Die Jacke ist zu klein.' } };
    const denied = await fetch(`${base}/telegram/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(update) });
    assert.equal(denied.status, 401);
    const res = await fetch(`${base}/telegram/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'whsec' }, body: JSON.stringify(update) });
    assert.equal(res.status, 200);
    await ctx.app.bot.idle();
    assert.match(ctx.sim.staffLast(), /I would like a refund for my order #2077/);

    const list = await (await fetch(`${base}/api/conversations?status=open`, { headers: { 'x-api-key': 'secret' } })).json();
    assert.equal(list[0].name, 'Lena');
    const tr = await (await fetch(`${base}/api/conversations/1/transcript`, { headers: { 'x-api-key': 'secret' } })).text();
    assert.match(tr, /Lena \(DE\): Hallo[\s\S]*→ Hello, I would like a refund/);
  });

  it('/api is disabled without API_KEY', async () => {
    const c = makeApp({ env: { API_KEY: '' } });
    const s = await listen(c.app);
    const r = await fetch(`http://127.0.0.1:${s.address().port}/api/stats`);
    s.close();
    assert.equal(r.status, 503);
  });
});

describe('CLI', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  const env = { ...process.env, SUPPORT_TRANSLATOR_SKIP_DOTENV: '1', DATA_FILE: path.join(tmp, 'db.json'), NO_COLOR: '1', DEEPL_API_KEY: '', GEMINI_API_KEY: '', GROQ_API_KEY: '', NVIDIA_API_KEY: '', OPENROUTER_API_KEY: '', OLLAMA_BASE_URL: '' };
  const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', timeout: 30_000 });

  it('translate --mock', () => {
    const r = run('--no-ai', 'translate', '--mock', '--to', 'de', 'Thank you very much! Can I change the delivery address?');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'Vielen Dank! Kann ich die Lieferadresse ändern?');
    assert.match(r.stderr, /EN → DE · deepl/);
  });

  it('translate without any engine exits 2 and prints the original', () => {
    const r = run('translate', '--to', 'fr', 'Where is my parcel?');
    assert.equal(r.status, 2);
    assert.equal(r.stdout.trim(), 'Where is my parcel?');
    assert.match(r.stderr, /NOT TRANSLATED/);
  });

  it('detect', () => {
    const r = run('detect', 'Bonjour, où est ma commande ?');
    assert.match(r.stdout, /FR/);
  });

  it('demo runs offline', () => {
    const r = run('--no-ai', '--log-level', 'silent', 'demo');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Traduit automatiquement/);
    assert.match(r.stdout, /Automatisch übersetzt/);
    assert.match(r.stdout, /rated the support 5\/5/);
  });
});
