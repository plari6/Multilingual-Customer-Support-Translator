import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { STAFF, fakeRouter, makeApp } from './helpers.js';

const FR_ORDER = "Bonjour, ma commande #1042 n'est toujours pas arrivée.";
const EN_REPLY = "Hi Marie, I'm sorry for the delay. Your package was shipped yesterday with tracking number 1Z999AA10123456784.";

async function frenchConversation(opts) {
  const ctx = makeApp(opts);
  const marie = ctx.sim.customer({ id: 7001, first_name: 'Marie', last_name: 'Dupont', language_code: 'fr' });
  const alex = ctx.sim.agent({ id: 900, first_name: 'Alex' });
  return { ...ctx, marie, alex };
}

describe('customer -> staff', () => {
  it('relays a French message to the staff group in English with the original', async () => {
    const { app, sim, marie } = await frenchConversation();
    await marie.say(FR_ORDER);
    const staff = sim.staffLast();
    assert.match(staff, /🆕 🇫🇷 <b>Marie Dupont<\/b> · #1 · FR→EN/);
    assert.match(staff, /Hello, my order #1042 still hasn't arrived\./);
    assert.match(staff, /<i>🇫🇷 Bonjour, ma commande #1042/);
    assert.match(staff, /Reply to this message/);
    assert.match(marie.last(), /Votre message a été transmis/);
    const conv = app.store.getConversation(7001);
    assert.equal(conv.lang, 'FR');
    assert.equal(conv.messages[0].dir, 'in');
    assert.equal(conv.messages[0].translated, "Hello, my order #1042 still hasn't arrived.");
  });

  it('welcomes in the Telegram app language and offers language buttons', async () => {
    const { tg, marie } = await frenchConversation();
    await marie.say('/start');
    assert.match(marie.inbox()[0], /Bienvenue au service client de Maison Nova/);
    assert.deepEqual(
      tg.buttonsTo(7001).map((b) => b.data),
      ['lang:EN', 'lang:FR', 'lang:DE'],
    );
  });

  it('keeps the conversation language for short messages', async () => {
    const { app, marie } = await frenchConversation();
    await marie.say(FR_ORDER);
    await marie.say('ok');
    assert.equal(app.store.getConversation(7001).lang, 'FR');
  });

  it('switches language when the customer really writes in another one', async () => {
    const { app, marie } = await frenchConversation();
    await marie.say(FR_ORDER);
    await marie.say('Hallo, meine Bestellung #1042 ist immer noch nicht angekommen.');
    assert.equal(app.store.getConversation(7001).lang, 'DE');
  });

  it('a language button locks the reply language', async () => {
    const { app, marie, alex, tg } = await frenchConversation();
    await marie.say(FR_ORDER);
    await marie.press('lang:DE');
    assert.match(marie.last(), /auf Deutsch/);
    await marie.say('Thanks');
    assert.equal(app.store.getConversation(7001).lang, 'DE');
    await alex.reply('Yes, we ship to Switzerland. Delivery takes 3 to 5 business days.', { to: 7001 });
    assert.match(tg.textsTo(7001).at(-1), /Ja, wir liefern in die Schweiz/);
  });

  it('asks customers writing an unsupported language to pick a supported one', async () => {
    const { tg, sim } = makeApp();
    const pablo = sim.customer({ id: 7005, first_name: 'Pablo' });
    await pablo.say('Hola, ¿dónde está mi pedido? Gracias');
    assert.match(sim.staffLast(), /Pablo/);
    assert.match(pablo.last(), /only answer in English, French or German/);
    assert.deepEqual(tg.buttonsTo(7005).map((b) => b.data), ['lang:EN', 'lang:FR', 'lang:DE']);
  });

  it('copies photos to the staff group with a translated caption', async () => {
    const { tg, marie } = await frenchConversation();
    await marie.photo('Merci beaucoup ! Est-ce que je peux changer l\'adresse de livraison ?');
    const copy = tg.calls.find((c) => c.method === 'copyMessage');
    assert.equal(copy.params.chat_id, STAFF);
    assert.equal(copy.params.from_chat_id, 7001);
    assert.match(copy.params.caption, /Can I change the delivery address\?/);
  });
});

describe('agent -> customer', () => {
  it('translates the agent reply into French and confirms in the staff group', async () => {
    const { app, sim, marie, alex } = await frenchConversation();
    await marie.say(FR_ORDER);
    await alex.reply(EN_REPLY, { to: 7001 });
    assert.match(marie.last(), /^Bonjour Marie, je suis désolé pour ce retard\. Votre colis a été expédié hier avec le numéro de suivi 1Z999AA10123456784\.\n\n<i>🌐 Traduit automatiquement<\/i>$/);
    assert.match(sim.staffLast(), /✅ Sent to Marie Dupont in 🇫🇷 FR/);
    const out = app.store.getConversation(7001).messages.at(-1);
    assert.equal(out.dir, 'out');
    assert.equal(out.agent, 'Alex');
    assert.equal(out.to, 'FR');
  });

  it('replying to the bot confirmation keeps working (thread continues)', async () => {
    const { sim, marie, alex } = await frenchConversation();
    await marie.say(FR_ORDER);
    await alex.reply(EN_REPLY, { to: 7001 });
    // lastStaffMessageFor now points at the confirmation message
    await alex.reply('Yes, please send me the new address and I will update it right away.', { to: 7001 });
    assert.match(marie.last(), /veuillez m'envoyer la nouvelle adresse/);
    assert.match(sim.staffLast(), /Sent to Marie/);
  });

  it('can turn the translation note off', async () => {
    const { marie, alex } = await frenchConversation({ env: { TRANSLATION_NOTE: 'false' } });
    await marie.say(FR_ORDER);
    await alex.reply(EN_REPLY, { to: 7001 });
    assert.doesNotMatch(marie.last(), /Traduit/);
  });

  it('does not send internal notes', async () => {
    const { app, tg, marie, alex } = await frenchConversation();
    await marie.say(FR_ORDER);
    const before = tg.textsTo(7001).length;
    await alex.reply('// customer is VIP, offer free shipping', { to: 7001 });
    await alex.reply('/note check stock first', { to: 7001 });
    assert.equal(tg.textsTo(7001).length, before);
    const notes = app.store.getConversation(7001).messages.filter((m) => m.dir === 'note');
    assert.deepEqual(notes.map((n) => n.original), ['customer is VIP, offer free shipping', 'check stock first']);
    assert.ok(tg.calls.some((c) => c.method === 'setMessageReaction'));
  });

  it('sends translated macros', async () => {
    const { sim, marie, alex } = await frenchConversation();
    await marie.say(FR_ORDER);
    await alex.reply('/m returns', { to: 7001 });
    assert.match(marie.last(), /Vous pouvez retourner tout article non porté .* https:\/\/maisonnova\.example\/returns/);
    assert.match(sim.staffLast(), /macro <code>returns<\/code>/);
    await alex.reply('/m nope', { to: 7001 });
    assert.match(sim.staffLast(), /Unknown macro/);
  });

  it('keeps the brand name untranslated', async () => {
    const { marie, alex, deepl } = await frenchConversation();
    await marie.say(FR_ORDER);
    await alex.reply('/m bye', { to: 7001 });
    assert.match(marie.last(), /Merci d'avoir contacté Maison Nova/);
    assert.ok(deepl.calls.at(-1).texts[0].includes('<x i="0"/>'));
  });

  it('/lang changes the reply language', async () => {
    const { tg, marie, alex } = await frenchConversation();
    await marie.say(FR_ORDER);
    await alex.reply('/lang DE', { to: 7001 });
    await alex.reply('Thank you!', { to: 7001 });
    assert.match(tg.textsTo(7001).at(-1), /^Danke!/);
  });

  it('close asks for a rating that shows up in the stats', async () => {
    const { app, sim, marie, alex } = await frenchConversation();
    await marie.say(FR_ORDER);
    await alex.reply('/close', { to: 7001 });
    assert.match(marie.last(), /Cette conversation est terminée/);
    await marie.press('rate:4');
    assert.match(sim.staffLast(), /rated the support 4\/5/);
    const s = app.bot.stats();
    assert.equal(s.closed, 1);
    assert.equal(s.avgRating, 4);
    // writing again reopens it
    await marie.say('Merci !');
    assert.equal(app.store.getConversation(7001).status, 'open');
    assert.match(sim.staffLast(), /🔄/);
  });

  it('close button in the staff group works too', async () => {
    const { app, alex, marie } = await frenchConversation();
    await marie.say(FR_ORDER);
    await alex.press('close:7001');
    assert.equal(app.store.getConversation(7001).status, 'closed');
  });

  it('reports customers who blocked the bot', async () => {
    const { sim, tg, marie, alex } = await frenchConversation();
    await marie.say(FR_ORDER);
    tg.blocked.add('7001');
    await alex.reply(EN_REPLY, { to: 7001 });
    assert.match(sim.staffLast(), /has blocked the bot/);
  });

  it('only listed agents can reply when AGENT_USER_IDS is set', async () => {
    const { tg, marie, sim } = await frenchConversation({ env: { AGENT_USER_IDS: '900' } });
    await marie.say(FR_ORDER);
    const intern = sim.agent({ id: 901, first_name: 'Intern' });
    const before = tg.textsTo(7001).length;
    await intern.reply(EN_REPLY, { to: 7001 });
    assert.equal(tg.textsTo(7001).length, before);
  });

  it('ignores normal team chat that is not a reply', async () => {
    const { tg, alex, marie } = await frenchConversation();
    await marie.say(FR_ORDER);
    const n = tg.calls.length;
    await alex.say('lunch at 1?');
    assert.equal(tg.calls.length, n);
  });

  it('staff tools: /whoami, /list, /t, /transcript', async () => {
    const { sim, marie, alex } = await frenchConversation();
    await marie.say(FR_ORDER);
    await alex.say('/whoami');
    assert.match(sim.staffLast(), /Chat id: <code>-100500<\/code>/);
    await alex.say('/list');
    assert.match(sim.staffLast(), /#1 🇫🇷 Marie Dupont/);
    await alex.say('/t DE Thank you!');
    assert.match(sim.staffLast(), /Danke!.*not sent|not sent[\s\S]*Danke!/);
    await alex.say('/transcript 1');
    assert.match(sim.staffLast(), /Transcript #1[\s\S]*Bonjour, ma commande[\s\S]*→ Hello, my order/);
    await alex.say('/close');
    assert.match(sim.staffLast(), /Reply to a customer message/);
  });
});

describe('forum topics', () => {
  it('opens one topic per customer and replies from inside the topic', async () => {
    const { app, tg, marie, alex } = await frenchConversation({ topics: true });
    await marie.say(FR_ORDER);
    const created = tg.calls.find((c) => c.method === 'createForumTopic');
    assert.equal(created.params.name, '🇫🇷 Marie Dupont #1');
    const conv = app.store.getConversation(7001);
    assert.equal(tg.lastTo(STAFF).params.message_thread_id, conv.topicId);
    await alex.inTopic(EN_REPLY, { of: 7001 });
    assert.match(marie.last(), /Bonjour Marie, je suis désolé/);
    await alex.inTopic('/close', { of: 7001 });
    assert.ok(tg.calls.some((c) => c.method === 'editForumTopic' && c.params.name.startsWith('✅')));
  });
});

describe('outages', () => {
  it('uses the AI fallback when DeepL is down and says so to the agent', async () => {
    const router = fakeRouter(() => '{"translation":"Hello, my order ⟦0⟧ has still not arrived.","detected_language":"fr"}');
    const { sim, marie } = await frenchConversation({ failWith: 'overloaded', aiRouter: router });
    await marie.say(FR_ORDER);
    assert.match(sim.staffLast(), /Hello, my order #1042 has still not arrived\./);
    assert.match(sim.staffLast(), /AI fallback \(fake:translator-1\)/);
  });

  it('delivers untranslated text with a localized notice when nothing works', async () => {
    const { sim, marie, alex } = await frenchConversation({ failWith: 'overloaded' });
    await marie.say(FR_ORDER);
    assert.match(sim.staffLast(), /Not translated/);
    assert.match(sim.staffLast(), /Bonjour, ma commande #1042/);
    await alex.reply(EN_REPLY, { to: 7001 });
    assert.match(marie.last(), /service de traduction est momentanément indisponible[\s\S]*Hi Marie/);
    assert.match(sim.staffLast(), /Sent <b>untranslated<\/b>/);
  });
});
