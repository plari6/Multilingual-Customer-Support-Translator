import fs from 'node:fs';
import path from 'node:path';

/**
 * Small JSON-file database: conversations, their bilingual message log, and the
 * mapping staff message id / forum topic -> conversation. Writes are debounced and atomic.
 * Pass file = null for an in-memory store (tests, demo).
 */
const MAX_MESSAGES = 500;

export function createStore(file, { debounceMs = 200 } = {}) {
  let data = { seq: 0, conversations: {}, staffIndex: {}, topicIndex: {}, glossaryIds: {} };
  if (file && fs.existsSync(file)) {
    try {
      data = { ...data, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch (e) {
      const bad = `${file}.corrupt-${Date.now()}`;
      fs.renameSync(file, bad);
      process.stderr.write(`store: could not parse ${file} (${e.message}); moved to ${bad}\n`);
    }
  }
  let timer = null;

  function flush() {
    if (!file) return;
    clearTimeout(timer);
    timer = null;
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
    fs.renameSync(tmp, file);
  }
  function save() {
    if (!file) return;
    if (!timer) timer = setTimeout(flush, debounceMs);
  }

  return {
    data,
    flush,
    save,
    getConversation: (id) => data.conversations[String(id)] || null,
    /** Conversation key = customer's Telegram chat id. */
    upsertConversation(chat, from = {}) {
      const id = String(chat.id);
      let c = data.conversations[id];
      if (!c) {
        c = data.conversations[id] = {
          id,
          number: ++data.seq,
          chatId: chat.id,
          name: [from.first_name, from.last_name].filter(Boolean).join(' ') || chat.title || 'Customer',
          username: from.username || null,
          clientLanguage: from.language_code || null,
          lang: null,
          langLocked: false,
          status: 'open',
          topicId: null,
          createdAt: new Date().toISOString(),
          lastAt: new Date().toISOString(),
          rating: null,
          messages: [],
        };
      }
      save();
      return c;
    },
    addMessage(conv, msg) {
      const m = { at: new Date().toISOString(), ...msg };
      conv.messages.push(m);
      if (conv.messages.length > MAX_MESSAGES) conv.messages.splice(0, conv.messages.length - MAX_MESSAGES);
      conv.lastAt = m.at;
      save();
      return m;
    },
    linkStaffMessage(messageId, convId) {
      if (messageId == null) return;
      data.staffIndex[String(messageId)] = String(convId);
      const keys = Object.keys(data.staffIndex);
      if (keys.length > 20000) for (const k of keys.slice(0, keys.length - 20000)) delete data.staffIndex[k];
      save();
    },
    convByStaffMessage: (messageId) => data.conversations[data.staffIndex[String(messageId)]] || null,
    linkTopic(topicId, convId) {
      data.topicIndex[String(topicId)] = String(convId);
      save();
    },
    convByTopic: (topicId) => data.conversations[data.topicIndex[String(topicId)]] || null,
    list({ status } = {}) {
      return Object.values(data.conversations)
        .filter((c) => !status || c.status === status)
        .sort((a, b) => b.lastAt.localeCompare(a.lastAt));
    },
    findConversation(ref) {
      const s = String(ref).replace(/^#/, '');
      return data.conversations[s] || Object.values(data.conversations).find((c) => String(c.number) === s) || null;
    },
  };
}
