import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deeplTarget, detectLanguage, normalizeLang, parseLanguageList } from '../src/languages.js';
import { fromDeeplXml, mask, restore, toDeeplXml } from '../src/translate/protect.js';

describe('languages', () => {
  it('normalizes codes and maps DeepL targets', () => {
    assert.equal(normalizeLang('en-gb'), 'EN');
    assert.equal(normalizeLang('fr_CA'), 'FR');
    assert.equal(normalizeLang('xx'), null);
    assert.equal(deeplTarget('EN'), 'EN-US');
    assert.equal(deeplTarget('en', { englishVariant: 'EN-GB' }), 'EN-GB');
    assert.equal(deeplTarget('EN-GB'), 'EN-GB');
    assert.equal(deeplTarget('pt'), 'PT-PT');
    assert.equal(deeplTarget('de'), 'DE');
    assert.deepEqual(parseLanguageList('en, fr ,de,xx'), ['EN', 'FR', 'DE']);
    assert.ok(parseLanguageList('*').length > 10);
  });

  it('detects EN / FR / DE offline', () => {
    assert.equal(detectLanguage("Bonjour, ma commande n'est toujours pas arrivée").lang, 'FR');
    assert.equal(detectLanguage('Hallo, ich möchte eine Rückerstattung für meine Bestellung').lang, 'DE');
    assert.equal(detectLanguage('Hello, where is my order? It has not arrived yet').lang, 'EN');
    assert.equal(detectLanguage('Danke!').lang, 'DE');
    assert.equal(detectLanguage('ok').lang, null);
    assert.ok(detectLanguage('Bonjour, ma commande est où ? Merci pour votre aide').confidence >= 0.6);
  });

  it('ignores order numbers, links and emails when detecting', () => {
    assert.equal(detectLanguage('#1042 https://example.com/de/die/der a@b.de').lang, null);
  });
});

describe('protect', () => {
  it('masks links, emails, order and tracking numbers and brand terms', () => {
    const text = 'Order #1042 for marie@example.fr via Maison Nova: https://shop.example/t?id=1. Tracking 1Z999AA10123456784, code `ABC`';
    const { masked, values } = mask(text, { terms: ['Maison Nova'] });
    assert.deepEqual(values, ['#1042', 'marie@example.fr', 'Maison Nova', 'https://shop.example/t?id=1', '1Z999AA10123456784', '`ABC`']);
    assert.ok(!/1042|marie|Nova|https|1Z999/.test(masked));
    assert.equal(restore(masked, values), text);
  });

  it('appends tokens a translation engine dropped', () => {
    const { masked, values } = mask('See #77 and https://a.example/x');
    assert.equal(masked, 'See ⟦0⟧ and ⟦1⟧');
    assert.equal(restore('Voir ⟦0⟧', values), 'Voir #77 (https://a.example/x)');
    assert.equal(restore('Voir [[0]] et [[ 1 ]]', values), 'Voir #77 et https://a.example/x');
  });

  it('round-trips the DeepL XML form, escaping < > &', () => {
    const { masked, values } = mask('Price < 5 & > 2 for #12');
    const xml = toDeeplXml(masked);
    assert.equal(xml, 'Price &lt; 5 &amp; &gt; 2 for <x i="0"/>');
    assert.equal(restore(fromDeeplXml(xml), values), 'Price < 5 & > 2 for #12');
    assert.equal(fromDeeplXml('a <x i="0"></x> b'), 'a ⟦0⟧ b');
  });

  it('does not mask parts of words for brand terms', () => {
    const { values } = mask('NovaPayment vs NovaPay', { terms: ['NovaPay'] });
    assert.deepEqual(values, ['NovaPay']);
  });
});
