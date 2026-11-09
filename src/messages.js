import { normalizeLang } from './languages.js';

/**
 * Fixed customer-facing texts, written by hand per language (never machine translated,
 * so they work even when every translation engine is down). Missing language -> English.
 * {company}, {hours}, {lang}, {name} are filled in by t().
 */
export const CUSTOMER_TEXT = {
  EN: {
    welcome: 'Hi {name}! 👋 Welcome to {company} support.\nWrite your question in English, French or German and a member of our team will answer you in your language.',
    chooseLanguage: 'Which language do you prefer?',
    languageSet: '✅ We will answer you in English.',
    firstAck: 'Thanks! Your message has been passed on to our team. We usually reply within a few minutes ({hours}).',
    unsupported: 'Sorry, we can only answer in English, French or German. Please choose one:',
    translatedNote: '🌐 Translated automatically',
    untranslatedNote: '⚠️ Our translation service is temporarily unavailable, so here is the original message:',
    closed: 'This conversation has been closed. Thank you for contacting {company}! How would you rate our help?',
    thanksRating: 'Thank you for your feedback! 🙏 Write to us any time if you need anything else.',
    mediaReceived: '📎 File received, our team will have a look.',
  },
  FR: {
    welcome: 'Bonjour {name} ! 👋 Bienvenue au service client de {company}.\nÉcrivez votre question en français, en anglais ou en allemand : un membre de notre équipe vous répondra dans votre langue.',
    chooseLanguage: 'Quelle langue préférez-vous ?',
    languageSet: '✅ Nous vous répondrons en français.',
    firstAck: 'Merci ! Votre message a été transmis à notre équipe. Nous répondons généralement en quelques minutes ({hours}).',
    unsupported: 'Désolé, nous ne pouvons répondre qu’en français, en anglais ou en allemand. Veuillez choisir :',
    translatedNote: '🌐 Traduit automatiquement',
    untranslatedNote: '⚠️ Notre service de traduction est momentanément indisponible, voici le message original :',
    closed: 'Cette conversation est terminée. Merci d’avoir contacté {company} ! Comment évaluez-vous notre aide ?',
    thanksRating: 'Merci pour votre avis ! 🙏 N’hésitez pas à nous écrire si vous avez besoin d’autre chose.',
    mediaReceived: '📎 Fichier reçu, notre équipe va le consulter.',
  },
  DE: {
    welcome: 'Hallo {name}! 👋 Willkommen beim Kundenservice von {company}.\nSchreiben Sie Ihre Frage auf Deutsch, Englisch oder Französisch – unser Team antwortet Ihnen in Ihrer Sprache.',
    chooseLanguage: 'Welche Sprache bevorzugen Sie?',
    languageSet: '✅ Wir antworten Ihnen auf Deutsch.',
    firstAck: 'Danke! Ihre Nachricht wurde an unser Team weitergeleitet. Wir antworten normalerweise innerhalb weniger Minuten ({hours}).',
    unsupported: 'Leider können wir nur auf Deutsch, Englisch oder Französisch antworten. Bitte wählen Sie:',
    translatedNote: '🌐 Automatisch übersetzt',
    untranslatedNote: '⚠️ Unser Übersetzungsdienst ist vorübergehend nicht verfügbar, hier ist die Originalnachricht:',
    closed: 'Dieses Gespräch wurde beendet. Vielen Dank, dass Sie {company} kontaktiert haben! Wie bewerten Sie unsere Hilfe?',
    thanksRating: 'Vielen Dank für Ihr Feedback! 🙏 Schreiben Sie uns jederzeit, wenn Sie noch etwas brauchen.',
    mediaReceived: '📎 Datei erhalten, unser Team sieht sie sich an.',
  },
};

export function t(lang, key, vars = {}) {
  const L = normalizeLang(lang);
  const s = CUSTOMER_TEXT[L]?.[key] ?? CUSTOMER_TEXT.EN[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
}

export const STAFF_HELP = `<b>Support translator – agent commands</b>
Reply to any customer message (or write inside the customer's topic) and your text is translated into the customer's language and sent.

<code>// text</code> or <code>/note text</code> – internal note, not sent
<code>/m name</code> – send a saved reply (macro), translated
<code>/macros</code> – list saved replies
<code>/lang FR</code> – change the customer's language
<code>/close</code> – close the conversation and ask for a rating
<code>/transcript</code> – bilingual transcript of the conversation
<code>/list</code> – open conversations
<code>/t DE text</code> – translate something for yourself (not sent)
<code>/stats</code> – volume, languages, engines, ratings
<code>/whoami</code> – show this chat's id`;
