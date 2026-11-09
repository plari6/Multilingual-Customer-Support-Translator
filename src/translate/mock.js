import { detectLanguage, normalizeLang } from '../languages.js';
import { DeeplError } from './deepl.js';

/**
 * Offline stand-in for DeepL with the same interface as createDeeplClient().
 * Knows the demo phrases in EN/FR/DE; anything else comes back as "[FR] original text".
 * Used by `demo`, `chat --mock`, tests, and when no translation engine is configured.
 */
export const PHRASEBOOK = [
  {
    EN: 'Hello, my order {0} still hasn\'t arrived.',
    FR: 'Bonjour, ma commande {0} n\'est toujours pas arrivée.',
    DE: 'Hallo, meine Bestellung {0} ist immer noch nicht angekommen.',
  },
  {
    EN: 'Hi Marie, I\'m sorry for the delay. Your package was shipped yesterday with tracking number {0}.',
    FR: 'Bonjour Marie, je suis désolé pour ce retard. Votre colis a été expédié hier avec le numéro de suivi {0}.',
    DE: 'Hallo Marie, es tut mir leid für die Verzögerung. Ihr Paket wurde gestern mit der Sendungsnummer {0} verschickt.',
  },
  {
    EN: 'Thank you very much! Can I change the delivery address?',
    FR: 'Merci beaucoup ! Est-ce que je peux changer l\'adresse de livraison ?',
    DE: 'Vielen Dank! Kann ich die Lieferadresse ändern?',
  },
  {
    EN: 'Yes, please send me the new address and I will update it right away.',
    FR: 'Oui, veuillez m\'envoyer la nouvelle adresse et je la mettrai à jour immédiatement.',
    DE: 'Ja, bitte senden Sie mir die neue Adresse und ich werde sie sofort aktualisieren.',
  },
  {
    EN: 'Hello, I would like a refund for my order {0}. The jacket is too small.',
    FR: 'Bonjour, je voudrais un remboursement pour ma commande {0}. La veste est trop petite.',
    DE: 'Hallo, ich möchte eine Rückerstattung für meine Bestellung {0}. Die Jacke ist zu klein.',
  },
  {
    EN: 'Of course. Your refund has been issued and will appear on your account within 5 business days.',
    FR: 'Bien sûr. Votre remboursement a été effectué et apparaîtra sur votre compte sous 5 jours ouvrés.',
    DE: 'Selbstverständlich. Ihre Rückerstattung wurde veranlasst und wird innerhalb von 5 Werktagen auf Ihrem Konto erscheinen.',
  },
  { EN: 'Thank you!', FR: 'Merci !', DE: 'Danke!' },
  { EN: 'Thanks', FR: 'Merci', DE: 'Danke' },
  {
    EN: 'You can return any unworn item within 30 days for a full refund. Start your return here: {0}',
    FR: 'Vous pouvez retourner tout article non porté dans un délai de 30 jours pour un remboursement complet. Commencez votre retour ici : {0}',
    DE: 'Sie können jeden ungetragenen Artikel innerhalb von 30 Tagen gegen volle Rückerstattung zurückgeben. Starten Sie Ihre Rücksendung hier: {0}',
  },
  {
    EN: 'Thank you for contacting {0}. Is there anything else I can help you with?',
    FR: 'Merci d\'avoir contacté {0}. Puis-je vous aider avec autre chose ?',
    DE: 'Vielen Dank, dass Sie {0} kontaktiert haben. Kann ich Ihnen noch bei etwas anderem helfen?',
  },
  { EN: 'No, that\'s all. Have a nice day!', FR: 'Non, c\'est tout. Bonne journée !', DE: 'Nein, das ist alles. Einen schönen Tag noch!' },
  {
    EN: 'Do you ship to Switzerland?',
    FR: 'Est-ce que vous livrez en Suisse ?',
    DE: 'Liefern Sie in die Schweiz?',
  },
  {
    EN: 'Yes, we ship to Switzerland. Delivery takes 3 to 5 business days.',
    FR: 'Oui, nous livrons en Suisse. La livraison prend de 3 à 5 jours ouvrés.',
    DE: 'Ja, wir liefern in die Schweiz. Die Lieferung dauert 3 bis 5 Werktage.',
  },
];

const TAG = /<x\s+i="(\d+)"\s*\/>|⟦(\d+)⟧/g;
const key = (s) =>
  String(s)
    .replace(TAG, '{0}')
    .toLowerCase()
    .replace(/[\s ]+/g, ' ')
    .replace(/[.!?,:;'’"\s]+$/g, '')
    .replace(/['’]/g, "'")
    .trim();

const INDEX = new Map();
for (const entry of PHRASEBOOK) for (const [lang, text] of Object.entries(entry)) INDEX.set(key(text), { entry, lang });

function render(template, original) {
  const tags = [...String(original).matchAll(TAG)].map((m) => m[0]);
  let i = 0;
  return template.replace(/\{0\}/g, () => tags[i++] ?? '');
}

export function createMockTranslator({ failWith, latencyMs = 0 } = {}) {
  const calls = [];
  const state = { failWith };
  return {
    name: 'deepl',
    mock: true,
    configured: true,
    base: 'mock://deepl',
    calls,
    /** make the next calls fail: 'quota' | 'overloaded' | 'auth' | null */
    fail(kind) {
      state.failWith = kind;
    },
    async translate({ texts, target, source }) {
      calls.push({ texts, target, source });
      if (latencyMs) await new Promise((r) => setTimeout(r, latencyMs));
      if (state.failWith) {
        const status = { quota: 456, overloaded: 503, auth: 403, rate_limit: 429 }[state.failWith] || 500;
        throw new DeeplError(`DeepL ${status} (mock)`, { status, kind: state.failWith });
      }
      const to = normalizeLang(target);
      return texts.map((t) => {
        const hit = INDEX.get(key(t));
        const detected = normalizeLang(source) || hit?.lang || detectLanguage(t.replace(TAG, ' ')).lang || 'EN';
        if (detected === to) return { text: t, detected };
        if (hit?.entry[to]) return { text: render(hit.entry[to], t), detected };
        return { text: `[${to}] ${t}`, detected };
      });
    },
    usage: async () => ({ character_count: calls.reduce((s, c) => s + c.texts.join('').length, 0), character_limit: 500000 }),
    languages: async () => ['EN-US', 'EN-GB', 'FR', 'DE'].map((language) => ({ language, name: language })),
    listGlossaries: async () => [],
    createGlossary: async ({ name, source, target, entries }) => ({ glossary_id: `mock-${source}-${target}`, name, entry_count: Object.keys(entries).length }),
    deleteGlossary: async () => null,
  };
}
