/**
 * Drives the bot with fake Telegram updates: customers in private chats and agents in the
 * staff group. Used by `demo`, `chat` and the tests. Works with createMockTelegram().
 */
export function createSimulator(app) {
  const { tg, store, config } = app;
  const staffChatId = Number(config.telegram.staffChatId) || config.telegram.staffChatId;
  const staffChat = { id: staffChatId, type: 'supergroup', title: 'Support team' };
  let updateId = 1;
  let incomingId = 1_000_000;
  const date = () => Math.floor(Date.now() / 1000);
  const run = (update) => app.bot.dispatch(update);

  /** Last bot message in the staff chat that belongs to this customer's conversation. */
  function lastStaffMessageFor(customerId) {
    const convId = String(customerId);
    const sends = tg.calls.filter((c) => c.message_id && String(c.params.chat_id) === String(staffChatId));
    for (let i = sends.length - 1; i >= 0; i--) if (store.data.staffIndex[String(sends[i].message_id)] === convId) return sends[i].message_id;
    return null;
  }

  function customer({ id, first_name = 'Customer', last_name, username, language_code } = {}) {
    const from = { id, is_bot: false, first_name, last_name, username, language_code };
    const chat = { id, type: 'private', first_name };
    const send = (extra) => {
      const message = { message_id: incomingId++, from, chat, date: date(), ...extra };
      return run({ update_id: updateId++, message }).then(() => message);
    };
    return {
      id,
      say: (text) => send({ text }),
      photo: (caption) => send({ photo: [{ file_id: 'demo-photo', width: 800, height: 600 }], ...(caption ? { caption } : {}) }),
      voice: () => send({ voice: { file_id: 'demo-voice', duration: 4 } }),
      /** Press a button from the last bot message that had one (data = callback_data). */
      press(data) {
        const withButtons = tg.calls.filter((c) => String(c.params.chat_id) === String(id) && c.params.reply_markup?.inline_keyboard?.length).at(-1);
        return run({
          update_id: updateId++,
          callback_query: { id: `cb${updateId}`, from, chat_instance: 'x', data, message: { message_id: withButtons?.message_id || 0, chat, date: date() } },
        });
      },
      inbox: () => tg.textsTo(id),
      last: () => tg.textsTo(id).at(-1),
    };
  }

  function agent({ id = 900, first_name = 'Alex', last_name } = {}) {
    const from = { id, is_bot: false, first_name, last_name };
    const send = (extra) => {
      const message = { message_id: incomingId++, from, chat: staffChat, date: date(), ...extra };
      return run({ update_id: updateId++, message }).then(() => message);
    };
    return {
      id,
      /** Reply to the last relayed message of customer `to` (reply mode). */
      reply(text, { to, media } = {}) {
        const target = lastStaffMessageFor(to);
        if (!target) throw new Error(`no staff message for customer ${to} to reply to`);
        return send({ ...(media ? { photo: [{ file_id: 'agent-photo' }], caption: text } : { text }), reply_to_message: { message_id: target, chat: staffChat, from: { id: 1, is_bot: true } } });
      },
      /** Write in the customer's forum topic (topic mode). */
      inTopic(text, { of }) {
        const conv = store.getConversation(of);
        if (!conv?.topicId) throw new Error(`customer ${of} has no topic`);
        return send({ text, message_thread_id: conv.topicId, is_topic_message: true, reply_to_message: { message_id: conv.topicId, forum_topic_created: { name: 'x' }, chat: staffChat } });
      },
      /** Plain message / command in the staff chat (no reply). */
      say: (text) => send({ text }),
      press(data) {
        return run({ update_id: updateId++, callback_query: { id: `cb${updateId}`, from, chat_instance: 'y', data, message: { message_id: 1, chat: staffChat, date: date() } } });
      },
    };
  }

  return { customer, agent, staffChatId, staffInbox: () => tg.textsTo(staffChatId), staffLast: () => tg.textsTo(staffChatId).at(-1), lastStaffMessageFor, idle: () => app.bot.idle() };
}
