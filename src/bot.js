import { detectLanguage, langFlag, langLabel, langName, normalizeLang } from './languages.js';
import { STAFF_HELP, t } from './messages.js';
import { esc, keyboard, splitMessage } from './telegram/api.js';

/**
 * Translation relay between customers (private chats with the bot) and one staff group.
 *
 * Customer writes in FR/DE/EN -> staff group gets it in the agent language (+ original).
 * Agent replies to that message (or writes in the customer's forum topic) -> the reply is
 * translated into the customer's language and delivered by the bot.
 */
export function createBot({ config, tg, translator, store, logger }) {
  const staffChat = String(config.telegram.staffChatId || '');
  const agentLang = config.agentLanguage;
  const supported = config.supportedLanguages;
  const queues = new Map();
  let topicsResolved = null;

  // ---------------------------------------------------------------- helpers

  /** Run jobs one after another per key (ordered per chat, parallel across chats). */
  function enqueue(key, job) {
    const prev = queues.get(key) || Promise.resolve();
    const next = prev.then(job, job).catch((e) => logger.error(`update failed: ${e.stack || e.message}`));
    queues.set(key, next);
    next.finally(() => queues.get(key) === next && queues.delete(key));
    return next;
  }

  async function useTopics() {
    if (topicsResolved !== null) return topicsResolved;
    const mode = config.telegram.topics;
    if (mode === 'off' || !staffChat) return (topicsResolved = false);
    if (mode === 'on') return (topicsResolved = true);
    try {
      const chat = await tg.call('getChat', { chat_id: staffChat });
      topicsResolved = Boolean(chat?.is_forum);
    } catch (e) {
      logger.warn(`getChat(staff) failed: ${e.message}; using reply mode`);
      topicsResolved = false;
    }
    return topicsResolved;
  }

  const customerLang = (conv) => conv.lang || (supported.includes(normalizeLang(conv.clientLanguage)) ? normalizeLang(conv.clientLanguage) : config.fallbackCustomerLanguage);
  const vars = (conv, from) => ({ company: config.company, hours: config.supportHours, name: esc(from?.first_name || conv?.name || '') });
  const isAgent = (user) => !config.telegram.agentIds.length || config.telegram.agentIds.includes(String(user?.id));
  const agentName = (user) => [user?.first_name, user?.last_name].filter(Boolean).join(' ') || user?.username || 'Agent';
  const topicName = (conv) => `${conv.status === 'closed' ? '✅ ' : ''}${langFlag(customerLang(conv))} ${conv.name} #${conv.number}`.slice(0, 120);

  function langButtons() {
    return keyboard([supported.slice(0, 6).map((L) => [`${langFlag(L)} ${langName(L)}`, `lang:${L}`])]);
  }

  /** Last N messages of the conversation in the customer's language - sent to DeepL as `context`. */
  function contextFor(conv) {
    const n = config.contextMessages;
    if (!n) return undefined;
    const lines = conv.messages
      .filter((m) => m.dir === 'in' || m.dir === 'out')
      .slice(-n)
      .map((m) => (m.dir === 'in' ? m.original : m.translated))
      .filter(Boolean);
    return lines.length ? lines.join('\n') : undefined;
  }

  async function sendStaff(conv, text, extra = {}) {
    if (!staffChat) return null;
    const params = { chat_id: staffChat, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra };
    if (conv?.topicId) params.message_thread_id = conv.topicId;
    let res;
    try {
      res = await tg.call('sendMessage', params);
    } catch (e) {
      // Topic deleted by an admin: fall back to the main chat and forget the topic.
      if (conv?.topicId && /thread not found|TOPIC_(DELETED|CLOSED)/i.test(e.description || e.message)) {
        conv.topicId = null;
        delete params.message_thread_id;
        res = await tg.call('sendMessage', params);
      } else throw e;
    }
    if (conv) store.linkStaffMessage(res?.message_id, conv.id);
    return res;
  }

  async function sendCustomer(conv, text, extra = {}) {
    let last;
    for (const part of splitMessage(text)) last = await tg.call('sendMessage', { chat_id: conv.chatId, text: part, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
    return last;
  }

  async function ensureTopic(conv) {
    if (conv.topicId || !(await useTopics())) return;
    try {
      const topic = await tg.call('createForumTopic', { chat_id: staffChat, name: topicName(conv) });
      conv.topicId = topic.message_thread_id;
      store.linkTopic(conv.topicId, conv.id);
    } catch (e) {
      logger.warn(`createForumTopic failed (${e.message}); is the bot an admin with "Manage topics"? Using reply mode.`);
      topicsResolved = false;
    }
  }

  async function renameTopic(conv) {
    if (!conv.topicId) return;
    await tg.call('editForumTopic', { chat_id: staffChat, message_thread_id: conv.topicId, name: topicName(conv) }).catch(() => {});
  }

  // ---------------------------------------------------------------- customer side

  function updateLanguage(conv, detected, local) {
    const L = normalizeLang(detected);
    if (conv.langLocked) return 'locked';
    if (!L) return 'unknown';
    if (!supported.includes(L)) {
      if (!conv.lang) conv.lang = customerLang(conv);
      return 'unsupported';
    }
    // Short messages ("ok", "merci") are easy to misdetect: only switch on real evidence.
    if (!conv.lang || local.words >= 3 || local.lang === L) {
      const changed = conv.lang && conv.lang !== L;
      conv.lang = L;
      return changed ? 'changed' : 'same';
    }
    return 'kept';
  }

  async function onCustomerCommand(msg, cmd, arg) {
    const conv = store.upsertConversation(msg.chat, msg.from);
    if (cmd === '/start') {
      const m = /^lang_([a-z]{2})$/i.exec(arg || '');
      if (m && supported.includes(normalizeLang(m[1]))) Object.assign(conv, { lang: normalizeLang(m[1]), langLocked: true });
      const L = customerLang(conv);
      await sendCustomer(conv, t(L, 'welcome', vars(conv, msg.from)));
      if (!conv.langLocked) await sendCustomer(conv, t(L, 'chooseLanguage'), { reply_markup: langButtons() });
      return true;
    }
    if (cmd === '/language' || cmd === '/lang' || cmd === '/langue' || cmd === '/sprache') {
      await sendCustomer(conv, t(customerLang(conv), 'chooseLanguage'), { reply_markup: langButtons() });
      return true;
    }
    return false;
  }

  async function onCustomerMessage(msg) {
    const text = msg.text ?? msg.caption ?? '';
    const cmdMatch = /^(\/[a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text.trim());
    if (cmdMatch && (await onCustomerCommand(msg, cmdMatch[1].toLowerCase(), cmdMatch[2]?.trim()))) return;

    const isNew = !store.getConversation(msg.chat.id) || !store.getConversation(msg.chat.id).messages.length;
    const conv = store.upsertConversation(msg.chat, msg.from);
    const reopened = conv.status === 'closed';
    if (conv.status !== 'open') conv.status = 'open';

    let r = null;
    let langEvent = null;
    if (text.trim()) {
      const local = detectLanguage(text, { candidates: supported });
      const hint = local.confidence >= 0.6 && local.words >= 3 ? local.lang : undefined;
      r = await translator.translate({ text, to: agentLang, from: hint, context: contextFor(conv) });
      langEvent = updateLanguage(conv, r.from, local);
    }
    const L = customerLang(conv);

    await ensureTopic(conv);
    if (reopened) await renameTopic(conv);

    const head = `${isNew ? '🆕 ' : reopened ? '🔄 ' : ''}${langFlag(r?.from || L)} <b>${esc(conv.name)}</b>${conv.username ? ` @${esc(conv.username)}` : ''} · #${conv.number} · ${r ? `${normalizeLang(r.from) || '?'}→${agentLang}` : langLabel(L)}`;
    let body = '';
    if (r) {
      body = esc(r.text);
      if (config.showOriginalToAgent && r.engine !== 'none' && r.text.trim() !== text.trim()) body += `\n\n<i>${langFlag(r.from)} ${esc(text)}</i>`;
      if (r.untranslated) body += `\n\n⚠️ <i>Not translated – DeepL and AI fallback are unavailable.</i>`;
      else if (r.engine === 'ai') body += `\n<i>· AI fallback (${esc(r.model || 'model')})</i>`;
    }
    const hint = isNew && !conv.topicId ? '\n\n<i>↩️ Reply to this message to answer the customer.</i>' : '';
    const markup = isNew ? { reply_markup: keyboard([[['✅ Close', `close:${conv.id}`], ['📜 Transcript', `tr:${conv.id}`]]]) } : {};

    const hasMedia = Boolean(msg.photo || msg.document || msg.voice || msg.video || msg.audio || msg.sticker || msg.video_note || msg.animation);
    let staffMsg;
    if (staffChat && hasMedia) {
      // Copy the file itself, with the translated caption.
      const caption = `${head}${body ? `\n\n${body}` : ''}${hint}`.slice(0, 1024);
      const canCaption = !msg.sticker && !msg.video_note;
      staffMsg = await tg.call('copyMessage', {
        chat_id: staffChat,
        from_chat_id: msg.chat.id,
        message_id: msg.message_id,
        ...(conv.topicId ? { message_thread_id: conv.topicId } : {}),
        ...(canCaption ? { caption, parse_mode: 'HTML' } : {}),
        ...markup,
      });
      store.linkStaffMessage(staffMsg?.message_id, conv.id);
      if (!canCaption) staffMsg = await sendStaff(conv, `${head}\n<i>(sticker / video note)</i>${hint}`);
    } else if (staffChat) {
      staffMsg = await sendStaff(conv, `${head}\n\n${body || '<i>(empty message)</i>'}${hint}`, markup);
    }

    store.addMessage(conv, {
      dir: 'in',
      original: text,
      translated: r?.text ?? '',
      from: normalizeLang(r?.from) || null,
      to: agentLang,
      engine: r?.engine || 'none',
      media: hasMedia ? Object.keys(msg).find((k) => ['photo', 'document', 'voice', 'video', 'audio', 'sticker', 'video_note', 'animation'].includes(k)) : undefined,
      customerMessageId: msg.message_id,
      staffMessageId: staffMsg?.message_id,
    });

    if (langEvent === 'unsupported' && !conv.unsupportedNotified) {
      conv.unsupportedNotified = true;
      await sendCustomer(conv, t(L, 'unsupported'), { reply_markup: langButtons() });
    } else if ((isNew || reopened) && config.firstAck) {
      await sendCustomer(conv, t(L, 'firstAck', vars(conv, msg.from)));
    }
    if (langEvent === 'changed') await renameTopic(conv);
    store.save();
  }

  async function onCustomerCallback(cq) {
    const conv = store.upsertConversation(cq.message.chat, cq.from);
    const [kind, value] = String(cq.data || '').split(':');
    if (kind === 'lang' && supported.includes(normalizeLang(value))) {
      Object.assign(conv, { lang: normalizeLang(value), langLocked: true });
      await tg.call('answerCallbackQuery', { callback_query_id: cq.id, text: langName(value) });
      await sendCustomer(conv, t(conv.lang, 'languageSet'));
      if (conv.messages.length) await sendStaff(conv, `🌐 #${conv.number} ${esc(conv.name)} chose ${langLabel(conv.lang)} – replies will be sent in ${langName(conv.lang)}.`);
      await renameTopic(conv);
    } else if (kind === 'rate' && /^[1-5]$/.test(value)) {
      conv.rating = Number(value);
      await tg.call('answerCallbackQuery', { callback_query_id: cq.id, text: '⭐'.repeat(conv.rating) });
      await tg.call('editMessageReplyMarkup', { chat_id: conv.chatId, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
      await sendCustomer(conv, t(customerLang(conv), 'thanksRating'));
      await sendStaff(conv, `${'⭐'.repeat(conv.rating)} #${conv.number} ${esc(conv.name)} rated the support ${conv.rating}/5`);
    } else {
      await tg.call('answerCallbackQuery', { callback_query_id: cq.id });
    }
    store.save();
  }

  // ---------------------------------------------------------------- staff side

  function resolveConv(msg) {
    if (msg.message_thread_id && msg.is_topic_message) {
      const c = store.convByTopic(msg.message_thread_id);
      if (c) return c;
    }
    const reply = msg.reply_to_message;
    if (reply && !reply.forum_topic_created) return store.convByStaffMessage(reply.message_id);
    return null;
  }

  async function staffReply(msg, text, extra = {}) {
    return tg.call('sendMessage', {
      chat_id: msg.chat.id,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(msg.message_thread_id && msg.is_topic_message ? { message_thread_id: msg.message_thread_id } : {}),
      reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true },
      ...extra,
    });
  }

  /** Translate an agent's text into the customer's language and deliver it. */
  async function deliverAgentReply(conv, msg, text, { macro } = {}) {
    const target = customerLang(conv);
    tg.call('sendChatAction', { chat_id: conv.chatId, action: 'typing' }).catch(() => {});
    const local = detectLanguage(text);
    let hint;
    if (local.lang === agentLang && local.confidence >= 0.5) hint = agentLang;
    else if (local.lang && local.confidence >= 0.8 && local.words >= 3) hint = local.lang;

    const r = text.trim() ? await translator.translate({ text, to: target, from: hint, context: contextFor(conv) }) : { text: '', engine: 'none', from: target };
    const sameLanguage = r.engine === 'none' && !r.untranslated;
    let out;
    if (r.untranslated) out = `<i>${esc(t(target, 'untranslatedNote'))}</i>\n\n${esc(text)}`;
    else out = esc(r.text) + (config.translationNote && !sameLanguage && r.text ? `\n\n<i>${esc(t(target, 'translatedNote'))}</i>` : '');

    const hasMedia = Boolean(msg.photo || msg.document || msg.voice || msg.video || msg.audio || msg.animation);
    let delivered;
    try {
      if (hasMedia && !macro) {
        delivered = await tg.call('copyMessage', { chat_id: conv.chatId, from_chat_id: msg.chat.id, message_id: msg.message_id, ...(out ? { caption: out.slice(0, 1024), parse_mode: 'HTML' } : {}) });
      } else {
        delivered = await sendCustomer(conv, out);
      }
    } catch (e) {
      const blocked = e.status === 403;
      if (blocked) conv.status = 'blocked';
      await staffReply(msg, blocked ? `❌ Not delivered: ${esc(conv.name)} has blocked the bot.` : `❌ Not delivered: ${esc(e.message)}`);
      store.save();
      return { delivered: false, error: e.message };
    }
    if (conv.status !== 'open') conv.status = 'open';

    store.addMessage(conv, {
      dir: 'out',
      agent: agentName(msg.from),
      agentId: msg.from?.id,
      macro,
      original: text,
      translated: r.untranslated ? text : r.text,
      from: normalizeLang(r.from) || hint || null,
      to: target,
      engine: r.engine,
      staffMessageId: msg.message_id,
      customerMessageId: delivered?.message_id,
    });
    store.linkStaffMessage(msg.message_id, conv.id);

    const via = r.engine === 'ai' ? ` · AI fallback (${esc(r.model || '')})` : r.cached ? ' · cached' : '';
    const confirm = r.untranslated
      ? `⚠️ Sent <b>untranslated</b> to ${esc(conv.name)} (translation unavailable).`
      : sameLanguage
        ? `✅ Sent to ${esc(conv.name)}${macro ? ` (macro <code>${esc(macro)}</code>)` : ''} – no translation needed.`
        : `✅ Sent to ${esc(conv.name)} in ${langLabel(target)}${macro ? ` (macro <code>${esc(macro)}</code>)` : ''}${via}:\n<i>${esc(r.text)}</i>`;
    const c = await staffReply(msg, confirm);
    store.linkStaffMessage(c?.message_id, conv.id);
    return { delivered: true, translation: r };
  }

  async function closeConversation(conv, by) {
    conv.status = 'closed';
    conv.closedAt = new Date().toISOString();
    conv.closedBy = by;
    const L = customerLang(conv);
    try {
      await sendCustomer(conv, t(L, 'closed', vars(conv)), {
        reply_markup: keyboard([[1, 2, 3, 4, 5].map((n) => [`${n} ⭐`, `rate:${n}`])]),
      });
    } catch (e) {
      logger.warn(`close message to ${conv.chatId} failed: ${e.message}`);
    }
    await renameTopic(conv);
    store.save();
  }

  function transcriptText(conv, { html = true } = {}) {
    const e = html ? esc : (s) => String(s ?? '');
    const lines = [`${html ? '<b>' : ''}Transcript #${conv.number} – ${e(conv.name)} (${customerLang(conv)})${html ? '</b>' : ''}`];
    for (const m of conv.messages) {
      const time = m.at.slice(0, 16).replace('T', ' ');
      if (m.dir === 'in') lines.push(`[${time}] 👤 ${e(conv.name)} (${m.from || '?'}): ${e(m.original)}${m.translated && m.translated !== m.original ? `\n      → ${e(m.translated)}` : ''}`);
      else if (m.dir === 'out') lines.push(`[${time}] 🎧 ${e(m.agent)}: ${e(m.original)}${m.translated && m.translated !== m.original ? `\n      → (${m.to}) ${e(m.translated)}` : ''}`);
      else if (m.dir === 'note') lines.push(`[${time}] 📝 ${e(m.agent)} (internal): ${e(m.original)}`);
    }
    return lines.join('\n');
  }

  function stats() {
    const convs = store.list();
    const msgs = convs.flatMap((c) => c.messages);
    const byLang = {};
    for (const c of convs) byLang[customerLang(c)] = (byLang[customerLang(c)] || 0) + 1;
    const rated = convs.filter((c) => c.rating);
    return {
      conversations: convs.length,
      open: convs.filter((c) => c.status === 'open').length,
      closed: convs.filter((c) => c.status === 'closed').length,
      messagesIn: msgs.filter((m) => m.dir === 'in').length,
      messagesOut: msgs.filter((m) => m.dir === 'out').length,
      byLanguage: byLang,
      avgRating: rated.length ? Number((rated.reduce((s, c) => s + c.rating, 0) / rated.length).toFixed(2)) : null,
      ratings: rated.length,
      translation: translator.stats(),
    };
  }

  async function onStaffCommand(msg, cmd, arg) {
    const byRef = arg && /^#?\d+$/.test(arg.split(/\s+/)[0]) ? store.findConversation(arg.split(/\s+/)[0]) : null;
    const rest = byRef ? arg.split(/\s+/).slice(1).join(' ') : arg;
    const conv = byRef || resolveConv(msg);
    const need = async () => {
      await staffReply(msg, 'Reply to a customer message (or write in the customer\'s topic), or add the number: <code>/close 12</code>.');
      return true;
    };
    switch (cmd) {
      case '/help':
      case '/start':
        await staffReply(msg, STAFF_HELP);
        return true;
      case '/whoami':
        await staffReply(msg, `Chat id: <code>${msg.chat.id}</code>\nYour user id: <code>${msg.from?.id}</code>${msg.message_thread_id ? `\nTopic id: <code>${msg.message_thread_id}</code>` : ''}`);
        return true;
      case '/list': {
        const open = store.list({ status: 'open' });
        await staffReply(msg, open.length ? `<b>Open conversations (${open.length})</b>\n${open.slice(0, 30).map((c) => `#${c.number} ${langFlag(customerLang(c))} ${esc(c.name)} · ${c.messages.length} msgs · last ${c.lastAt.slice(11, 16)} UTC`).join('\n')}` : 'No open conversations. 🎉');
        return true;
      }
      case '/stats': {
        const s = stats();
        await staffReply(
          msg,
          `<b>Stats</b>\nConversations: ${s.conversations} (open ${s.open}, closed ${s.closed})\nMessages: ${s.messagesIn} in / ${s.messagesOut} out\nLanguages: ${Object.entries(s.byLanguage).map(([l, n]) => `${langFlag(l)} ${l} ${n}`).join(', ') || '-'}\nRating: ${s.avgRating ?? '-'} (${s.ratings})\nTranslations: DeepL ${s.translation.byEngine.deepl}, AI ${s.translation.byEngine.ai}, cache ${s.translation.byEngine.cache}, skipped ${s.translation.skipped}, failed ${s.translation.failures}\nDeepL characters: ${s.translation.chars.deepl}`,
        );
        return true;
      }
      case '/macros': {
        const names = Object.keys(config.macros);
        await staffReply(msg, names.length ? `<b>Saved replies</b>\n${names.map((n) => `<code>/m ${esc(n)}</code> – ${esc(config.macros[n].slice(0, 70))}…`).join('\n')}` : 'No macros configured (add "macros" to the profile file).');
        return true;
      }
      case '/t': {
        const m = /^([a-z]{2}(?:-[a-z]{2})?)\s+([\s\S]+)$/i.exec(arg || '');
        if (!m || !normalizeLang(m[1])) {
          await staffReply(msg, 'Usage: <code>/t FR text to translate</code>');
          return true;
        }
        const r = await translator.translate({ text: m[2], to: m[1] });
        await staffReply(msg, `${langLabel(m[1])} <i>(${r.engine}, not sent)</i>\n<code>${esc(r.text)}</code>`);
        return true;
      }
      case '/m': {
        if (!conv) return need();
        const name = (rest || '').trim().toLowerCase();
        const text = config.macros[name] ?? Object.entries(config.macros).find(([k]) => k.toLowerCase() === name)?.[1];
        if (!text) {
          await staffReply(msg, `Unknown macro "${esc(name)}". /macros lists them.`);
          return true;
        }
        await deliverAgentReply(conv, msg, text, { macro: name });
        return true;
      }
      case '/lang': {
        if (!conv) return need();
        const L = normalizeLang(rest);
        if (!L) {
          await staffReply(msg, `Customer language: ${langLabel(customerLang(conv))}. Change with <code>/lang DE</code>.`);
          return true;
        }
        Object.assign(conv, { lang: L, langLocked: true });
        await renameTopic(conv);
        store.save();
        await staffReply(msg, `🌐 Replies to ${esc(conv.name)} will now be sent in ${langLabel(L)}.`);
        return true;
      }
      case '/close': {
        if (!conv) return need();
        await closeConversation(conv, agentName(msg.from));
        await staffReply(msg, `✅ #${conv.number} ${esc(conv.name)} closed – rating request sent.`);
        return true;
      }
      case '/transcript': {
        if (!conv) return need();
        for (const part of splitMessage(transcriptText(conv))) await staffReply(msg, part);
        return true;
      }
      case '/note': {
        if (!conv) return need();
        store.addMessage(conv, { dir: 'note', agent: agentName(msg.from), original: rest || '' });
        await staffReply(msg, '📝 Internal note saved (not sent to the customer).');
        return true;
      }
      default:
        return false;
    }
  }

  async function onStaffMessage(msg) {
    const text = msg.text ?? msg.caption ?? '';
    const cmdMatch = /^(\/[a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text.trim());
    if (cmdMatch && (await onStaffCommand(msg, cmdMatch[1].toLowerCase(), cmdMatch[2]?.trim() || ''))) return;
    if (msg.from?.is_bot) return;
    const conv = resolveConv(msg);
    if (!conv) return; // normal team chat, not a reply to a customer
    if (!isAgent(msg.from)) return;
    if (text.trim().startsWith('//')) {
      store.addMessage(conv, { dir: 'note', agent: agentName(msg.from), original: text.trim().slice(2).trim() });
      // ✍ reaction = "saved as internal note, not sent"
      await tg.call('setMessageReaction', { chat_id: msg.chat.id, message_id: msg.message_id, reaction: [{ type: 'emoji', emoji: '✍' }] }).catch(() => {});
      return;
    }
    if (!text.trim() && !(msg.photo || msg.document || msg.voice || msg.video || msg.audio || msg.animation)) return;
    await deliverAgentReply(conv, msg, text);
  }

  async function onStaffCallback(cq) {
    const [kind, id] = String(cq.data || '').split(':');
    const conv = store.getConversation(id);
    if (!conv) return tg.call('answerCallbackQuery', { callback_query_id: cq.id, text: 'Conversation not found' });
    if (kind === 'close') {
      if (conv.status === 'closed') return tg.call('answerCallbackQuery', { callback_query_id: cq.id, text: 'Already closed' });
      await closeConversation(conv, agentName(cq.from));
      await tg.call('answerCallbackQuery', { callback_query_id: cq.id, text: `#${conv.number} closed` });
      await sendStaff(conv, `✅ #${conv.number} ${esc(conv.name)} closed by ${esc(agentName(cq.from))} – rating request sent.`);
    } else if (kind === 'tr') {
      await tg.call('answerCallbackQuery', { callback_query_id: cq.id });
      for (const part of splitMessage(transcriptText(conv))) await sendStaff(conv, part);
    } else {
      await tg.call('answerCallbackQuery', { callback_query_id: cq.id });
    }
  }

  // ---------------------------------------------------------------- entry points

  async function handleUpdate(update) {
    const msg = update.message || update.edited_message;
    if (msg) {
      if (staffChat && String(msg.chat.id) === staffChat) return onStaffMessage(msg);
      if (msg.chat.type === 'private') return onCustomerMessage(msg);
      // Other groups: only answer /whoami so the owner can find the staff chat id.
      if (/^\/whoami/.test(msg.text || '')) return staffReply(msg, `Chat id: <code>${msg.chat.id}</code> – set STAFF_CHAT_ID to this value.`);
      return;
    }
    const cq = update.callback_query;
    if (cq?.message) {
      if (staffChat && String(cq.message.chat.id) === staffChat) return onStaffCallback(cq);
      return onCustomerCallback(cq);
    }
  }

  function queueKey(update) {
    const msg = update.message || update.edited_message || update.callback_query?.message;
    if (!msg) return 'misc';
    if (staffChat && String(msg.chat.id) === staffChat) {
      if (update.callback_query) return `staff:cb:${update.callback_query.data}`;
      const conv = resolveConv(msg);
      return conv ? `conv:${conv.id}` : 'staff';
    }
    return `conv:${msg.chat.id}`;
  }

  /** Queue an update (ordered per conversation). Returns the job promise. */
  const dispatch = (update) => enqueue(queueKey(update), () => handleUpdate(update));

  /** Long polling loop. Stops when `signal` aborts. */
  async function poll({ signal, timeout = 30 } = {}) {
    await tg.call('deleteWebhook', { drop_pending_updates: false });
    let offset = 0;
    while (!signal?.aborted) {
      let updates = [];
      try {
        updates = await tg.call('getUpdates', { offset, timeout, allowed_updates: ['message', 'edited_message', 'callback_query'] }, { timeoutMs: (timeout + 10) * 1000 });
      } catch (e) {
        if (signal?.aborted) break;
        logger.warn(`getUpdates failed: ${e.message}; retrying in 3s`);
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      for (const u of updates || []) {
        offset = u.update_id + 1;
        dispatch(u);
      }
    }
  }

  return { handleUpdate, dispatch, poll, stats, transcriptText, closeConversation, deliverAgentReply, useTopics, idle: () => Promise.all([...queues.values()]) };
}
