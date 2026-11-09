import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createAiTranslator, parseAiTranslation } from '../src/translate/ai.js';
import { createDeeplClient, deeplBaseUrl } from '../src/translate/deepl.js';
import { createMockTranslator } from '../src/translate/mock.js';
import { createTranslator } from '../src/translate/translator.js';
import { fakeRouter } from './helpers.js';

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const r = typeof responses === 'function' ? responses(calls.length, calls.at(-1)) : responses.shift();
    if (r instanceof Error) throw r;
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status || 200, headers: r.headers || {} });
  };
  fn.calls = calls;
  return fn;
}

describe('DeepL client', () => {
  it('picks the free or pro endpoint from the key', () => {
    assert.equal(deeplBaseUrl('abc:fx'), 'https://api-free.deepl.com');
    assert.equal(deeplBaseUrl('abc'), 'https://api.deepl.com');
    assert.equal(deeplBaseUrl('abc', 'http://localhost:9/'), 'http://localhost:9');
  });

  it('sends a well-formed translate request', async () => {
    const f = fakeFetch([{ body: { translations: [{ detected_source_language: 'FR', text: 'Hello <x i="0"/>' }] } }]);
    const d = createDeeplClient({ apiKey: 'k:fx', fetchImpl: f });
    const out = await d.translate({ texts: ['Bonjour <x i="0"/>'], target: 'EN-US', formality: 'prefer_more', context: 'earlier', xml: true });
    assert.deepEqual(out, [{ text: 'Hello <x i="0"/>', detected: 'FR' }]);
    const c = f.calls[0];
    assert.equal(c.url, 'https://api-free.deepl.com/v2/translate');
    assert.equal(c.init.headers.Authorization, 'DeepL-Auth-Key k:fx');
    assert.deepEqual(c.body, { text: ['Bonjour <x i="0"/>'], target_lang: 'EN-US', formality: 'prefer_more', context: 'earlier', tag_handling: 'xml', ignore_tags: ['x'] });
  });

  it('only sends a glossary together with source_lang', async () => {
    const f = fakeFetch(() => ({ body: { translations: [{ detected_source_language: 'EN', text: 'x' }] } }));
    const d = createDeeplClient({ apiKey: 'k', fetchImpl: f });
    await d.translate({ texts: ['a'], target: 'FR', glossaryId: 'g1' });
    await d.translate({ texts: ['a'], target: 'FR', glossaryId: 'g1', source: 'EN' });
    assert.equal(f.calls[0].body.glossary_id, undefined);
    assert.equal(f.calls[1].body.glossary_id, 'g1');
  });

  it('maps 456 to quota without retrying, retries 503 once', async () => {
    const f1 = fakeFetch([{ status: 456, body: { message: 'Quota exceeded' } }]);
    await assert.rejects(createDeeplClient({ apiKey: 'k', fetchImpl: f1 }).translate({ texts: ['a'], target: 'FR' }), (e) => e.kind === 'quota' && e.status === 456);
    assert.equal(f1.calls.length, 1);

    const f2 = fakeFetch([{ status: 503, body: {} }, { body: { translations: [{ detected_source_language: 'EN', text: 'b' }] } }]);
    const out = await createDeeplClient({ apiKey: 'k', fetchImpl: f2, wait: async () => {} }).translate({ texts: ['a'], target: 'FR' });
    assert.equal(out[0].text, 'b');
    assert.equal(f2.calls.length, 2);

    const f3 = fakeFetch([{ status: 403, body: { message: 'Wrong key' } }]);
    await assert.rejects(createDeeplClient({ apiKey: 'k', fetchImpl: f3 }).translate({ texts: ['a'], target: 'FR' }), (e) => e.kind === 'auth');
  });

  it('creates glossaries as TSV', async () => {
    const f = fakeFetch([{ body: { glossary_id: 'g9', entry_count: 2 } }]);
    const g = await createDeeplClient({ apiKey: 'k', fetchImpl: f }).createGlossary({ name: 'n', source: 'EN', target: 'FR', entries: { 'gift card': 'carte cadeau', 'store\tcredit': 'avoir' } });
    assert.equal(g.glossary_id, 'g9');
    assert.deepEqual(f.calls[0].body, { name: 'n', source_lang: 'en', target_lang: 'fr', entries: 'gift card\tcarte cadeau\nstore credit\tavoir', entries_format: 'tsv' });
  });
});

describe('translation pipeline', () => {
  it('translates with DeepL, keeps order numbers and caches', async () => {
    const deepl = createMockTranslator();
    const tr = createTranslator({ deepl });
    const r = await tr.translate({ text: "Bonjour, ma commande #1042 n'est toujours pas arrivée.", to: 'EN' });
    assert.equal(r.text, "Hello, my order #1042 still hasn't arrived.");
    assert.equal(r.from, 'FR');
    assert.equal(r.engine, 'deepl');
    const again = await tr.translate({ text: "Bonjour, ma commande #1042 n'est toujours pas arrivée.", to: 'EN' });
    assert.equal(again.cached, true);
    assert.equal(deepl.calls.length, 1);
    assert.equal(deepl.calls[0].target, 'EN-US');
    assert.match(deepl.calls[0].texts[0], /<x i="0"\/>/);
  });

  it('skips the API when the text is already in the target language', async () => {
    const deepl = createMockTranslator();
    const tr = createTranslator({ deepl });
    assert.equal((await tr.translate({ text: 'Hallo', to: 'DE', from: 'DE' })).engine, 'none');
    assert.equal((await tr.translate({ text: 'Hello, where is my order? It has not arrived yet.', to: 'EN' })).engine, 'none');
    assert.equal(deepl.calls.length, 0);
    assert.equal(tr.stats().skipped, 2);
  });

  it('passes formality per target language', async () => {
    const calls = [];
    const deepl = { configured: true, translate: async (a) => (calls.push(a), [{ text: 'x', detected: 'EN' }]) };
    const tr = createTranslator({ deepl, formality: { FR: 'prefer_more' } });
    await tr.translate({ text: 'Thanks a lot for your patience', to: 'FR' });
    await tr.translate({ text: 'Thanks a lot for your patience', to: 'NL' });
    assert.equal(calls[0].formality, 'prefer_more');
    assert.equal(calls[1].formality, undefined);
  });

  it('falls back to the AI chain when DeepL is out of quota, then pauses DeepL', async () => {
    const deepl = createMockTranslator({ failWith: 'quota' });
    const router = fakeRouter((req) => {
      assert.match(req.system, /French/);
      assert.match(req.system, /vous \/ Sie/);
      assert.match(req.messages[0].content, /⟦0⟧/);
      return '```json\n{"translation": "Votre commande ⟦0⟧ est en route.", "detected_language": "en"}\n```';
    });
    let t = 1000;
    const events = [];
    const tr = createTranslator({ deepl, ai: createAiTranslator(router), formality: { FR: 'prefer_more' }, now: () => t, onEvent: (e) => events.push(e.type) });
    const r = await tr.translate({ text: 'Your order #55 is on its way.', to: 'FR' });
    assert.equal(r.engine, 'ai');
    assert.equal(r.text, 'Votre commande #55 est en route.');
    assert.equal(r.from, 'EN');
    assert.equal(r.model, 'fake:translator-1');
    assert.deepEqual(events, ['deepl_failure', 'ai_translation']);
    await tr.translate({ text: 'Another message entirely here.', to: 'FR' });
    assert.equal(deepl.calls.length, 1, 'DeepL is paused after a quota error');
    assert.match(tr.health().deepl, /cooling \(quota\)/);
    t += 3600_001;
    await tr.translate({ text: 'Third message for the test.', to: 'FR' });
    assert.equal(deepl.calls.length, 2, 'DeepL is tried again after the pause');
  });

  it('returns the original text, flagged, when every engine fails', async () => {
    const deepl = createMockTranslator({ failWith: 'overloaded' });
    const router = fakeRouter(() => {
      throw Object.assign(new Error('503 overloaded'), { status: 503 });
    });
    const tr = createTranslator({ deepl, ai: createAiTranslator(router) });
    const r = await tr.translate({ text: 'Guten Tag, wo ist meine Bestellung?', to: 'EN' });
    assert.equal(r.engine, 'none');
    assert.equal(r.untranslated, true);
    assert.equal(r.text, 'Guten Tag, wo ist meine Bestellung?');
    assert.equal(r.from, 'DE');
    assert.match(r.error, /deepl: .*\| ai: /);
    assert.equal(tr.stats().failures, 1);
  });

  it('rejects bad AI output so the next model is tried', () => {
    assert.throws(() => parseAiTranslation('Sure! Here is the translation: Bonjour'));
    assert.throws(() => parseAiTranslation('{"translation": ""}'));
    assert.deepEqual(parseAiTranslation('{"translation":"Hallo","detected_language":"en"}'), { text: 'Hallo', detected: 'EN' });
  });

  it('hands glossary terms to the AI prompt', async () => {
    const router = fakeRouter((req) => {
      assert.match(req.system, /"store credit" -> "avoir"/);
      return '{"translation":"Vous avez un avoir.","detected_language":"EN"}';
    });
    const tr = createTranslator({ ai: createAiTranslator(router), glossaries: { 'EN>FR': { 'store credit': 'avoir' } } });
    const r = await tr.translate({ text: 'You have store credit.', to: 'FR', from: 'EN' });
    assert.equal(r.text, 'Vous avez un avoir.');
  });
});
