/* =========================================================================
   TELL - Max's Telegram inbox for gig opportunities.

   Max shares a screenshot, link or note to his SoundzGood Tell bot. This
   receiver (a Telegram webhook) saves it to Firestore `tellInbox` (photos to
   Storage tell/...) and replies "Got it" at once. The Tell routine on Max's
   computer turns the inbox into leads at 7am and 2pm, and queues replies in
   `tellOutbox`, which the second function sends back to Telegram.

   Security: the bot token lives only in the TELEGRAM_TOKEN secret (Max set it
   himself). Telegram signs every webhook call with a secret derived from the
   token, so nobody else can post to this URL. Only ONE chat is ever served:
   the first person to send /start (Max) becomes the owner; everyone else is
   ignored.
   ========================================================================= */
const crypto = require('crypto');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const logger = require('firebase-functions/logger');

const hookSecret = (token) => crypto.createHash('sha256').update('tell-webhook:' + token).digest('hex').slice(0, 48);

async function tg(token, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) logger.warn('telegram ' + method + ' failed', { description: j.description });
  return j;
}

/*  One-off setup: GET <url>?setup=1 points the bot's webhook at this function. */
async function setup(token, selfUrl) {
  const set = await tg(token, 'setWebhook', { url: selfUrl, secret_token: hookSecret(token), allowed_updates: ['message', 'edited_message'] });
  const me = await tg(token, 'getMe');
  return { webhook: !!set.ok, bot: me.result ? '@' + me.result.username : '?' };
}

async function handleUpdate(token, update) {
  const db = getFirestore();
  const msg = update.message || update.edited_message;
  if (!msg || !msg.chat) return;
  const chatId = String(msg.chat.id);
  const cfgRef = db.collection('tell').doc('config');
  const cfg = (await cfgRef.get()).data() || {};
  const text = String(msg.text || msg.caption || '').trim();

  // the first /start claims the bot for Max; nobody else is ever served
  if (!cfg.ownerChatId) {
    if (/^\/start\b/.test(text)) {
      await cfgRef.set({ ownerChatId: chatId, ownerName: [msg.from && msg.from.first_name, msg.from && msg.from.last_name].filter(Boolean).join(' '), claimedAt: Date.now() }, { merge: true });
      await tg(token, 'sendMessage', { chat_id: chatId, text: "Hi Max 👋 I'm Tell. Send me any gig opportunity you spot: a screenshot, a link or a quick note. I'll add it to your leads at 7am and 2pm, and Phil will fill it in." });
    }
    return;
  }
  if (chatId !== String(cfg.ownerChatId)) return;   // not Max - ignore quietly
  if (/^\/start\b/.test(text)) { await tg(token, 'sendMessage', { chat_id: chatId, text: 'Ready 👍 Send me anything you find.' }); return; }

  // save photos (biggest size) to Storage so the routine can read them
  const photos = [];
  const sizes = msg.photo || [];
  const doc = msg.document && /^image\//.test(msg.document.mime_type || '') ? msg.document : null;
  const fileId = sizes.length ? sizes[sizes.length - 1].file_id : doc ? doc.file_id : '';
  if (fileId) {
    try {
      const f = await tg(token, 'getFile', { file_id: fileId });
      if (f.ok) {
        const r = await fetch(`https://api.telegram.org/file/bot${token}/${f.result.file_path}`);
        const buf = Buffer.from(await r.arrayBuffer());
        const ext = (f.result.file_path.split('.').pop() || 'jpg').toLowerCase().slice(0, 5);
        const path = `tell/${Date.now()}-${msg.message_id}.${ext}`;
        await getStorage().bucket().file(path).save(buf, { contentType: 'image/' + (ext === 'png' ? 'png' : 'jpeg') });
        photos.push(path);
      }
    } catch (e) { logger.error('tell photo', e); }
  }
  const links = [...new Set((text.match(/https?:\/\/\S+/g) || []).concat(
    (msg.entities || msg.caption_entities || []).filter((e) => e.type === 'text_link').map((e) => e.url)))];
  if (!text && !photos.length) { await tg(token, 'sendMessage', { chat_id: chatId, text: 'Send me a screenshot, a link or a note about the event.' }); return; }

  await db.collection('tellInbox').add({
    at: Date.now(), chatId, messageId: msg.message_id, text: text.slice(0, 4000), photos, links, status: 'new',
    forwardedFrom: msg.forward_origin ? JSON.stringify(msg.forward_origin).slice(0, 300) : '',
  });
  await tg(token, 'sendMessage', { chat_id: chatId, reply_to_message_id: msg.message_id,
    text: "Got it 👍 I'll look at it at the next run (7am or 2pm) and add it to your leads." });
}

async function sendOutbox(token, snap) {
  const d = snap.data() || {};
  if (!d.text) return;
  const cfg = (await getFirestore().collection('tell').doc('config').get()).data() || {};
  const chatId = d.chatId || cfg.ownerChatId;
  if (!chatId) return;
  const res = await tg(token, 'sendMessage', { chat_id: chatId, text: String(d.text).slice(0, 4000), reply_to_message_id: d.replyTo || undefined, allow_sending_without_reply: true });
  await snap.ref.set({ sent: !!res.ok, sentAt: Date.now() }, { merge: true });
}

module.exports = { hookSecret, setup, handleUpdate, sendOutbox, FieldValue };
