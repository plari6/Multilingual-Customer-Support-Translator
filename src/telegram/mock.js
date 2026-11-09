/**
 * Records Bot API calls instead of sending them. Used by `chat`, `demo` and tests.
 * `forum: true` makes the staff chat behave like a Telegram group with topics.
 */
export function createMockTelegram({ onSend, blocked = [], forum = false } = {}) {
  const calls = [];
  let messageId = 1000;
  let threadId = 500;
  const SENDS = ['sendMessage', 'sendPhoto', 'sendDocument', 'copyMessage'];
  const sent = () => calls.filter((c) => SENDS.includes(c.method));
  const api = {
    kind: 'mock',
    calls,
    forum,
    blocked: new Set(blocked.map(String)),
    async call(method, params = {}) {
      if (api.blocked.has(String(params.chat_id)) && SENDS.includes(method)) {
        throw Object.assign(new Error('Telegram sendMessage failed: 403 Forbidden: bot was blocked by the user'), { status: 403, description: 'Forbidden: bot was blocked by the user' });
      }
      const entry = { method, params };
      calls.push(entry);
      if (method === 'getMe') return { id: 1, is_bot: true, username: 'demo_support_bot', first_name: 'Support Translator' };
      if (method === 'getChat') return { id: params.chat_id, type: 'supergroup', title: 'Support team', is_forum: api.forum };
      if (method === 'createForumTopic') return { message_thread_id: ++threadId, name: params.name };
      if (SENDS.includes(method)) {
        entry.message_id = ++messageId;
        onSend?.(entry);
        return { message_id: entry.message_id, chat: { id: params.chat_id }, text: params.text };
      }
      return true;
    },
    textsTo(chatId) {
      return sent()
        .filter((c) => String(c.params.chat_id) === String(chatId))
        .map((c) => c.params.text ?? c.params.caption ?? '');
    },
    lastTo(chatId) {
      return sent()
        .filter((c) => String(c.params.chat_id) === String(chatId))
        .at(-1);
    },
    buttonsTo(chatId) {
      const m = api.lastTo(chatId);
      return (m?.params.reply_markup?.inline_keyboard || []).flat().map((b) => ({ text: b.text, data: b.callback_data, url: b.url }));
    },
    reset() {
      calls.length = 0;
    },
  };
  return api;
}
