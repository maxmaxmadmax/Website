/* SOUNDZGOOD SERVER - tell
   Max's Telegram inbox for gig opportunities.
   Helpers shared with other features come from ../shared.js. */
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');

/* =========================================================================
   TELL - Max's Telegram inbox for gig opportunities (see lib/tell.js).
   ========================================================================= */
const TELEGRAM_TOKEN = defineSecret('TELEGRAM_TOKEN');
const tell = require('../lib/tell');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');

exports.tellBot = onRequest({ secrets: [TELEGRAM_TOKEN], cors: false }, async (req, res) => {
    const token = TELEGRAM_TOKEN.value();
    // one-off: GET ?setup=1 points the bot at this URL
    if (req.method === 'GET' && req.query.setup === '1' && req.query.key === tell.hookSecret(token)) {
        // the public address of this function (Cloud Run strips the /tellBot path from req.url, so it's fixed here)
        res.json(await tell.setup(token, 'https://australia-southeast1-soundzgood-8c86f.cloudfunctions.net/tellBot'));
        return;
    }
    // status: GET ?info=1 shows Telegram's delivery status (no secrets)
    if (req.method === 'GET' && req.query.info === '1' && req.query.key === tell.hookSecret(token)) {
        const r = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`)
            .then((x) => x.json())
            .catch(() => ({}));
        const i = r.result || {};
        res.json({
            url: i.url,
            pending: i.pending_update_count,
            lastError: i.last_error_message || '',
            lastErrorAt: i.last_error_date ? new Date(i.last_error_date * 1000).toISOString() : ''
        });
        return;
    }
    if (req.method !== 'POST' || req.get('X-Telegram-Bot-Api-Secret-Token') !== tell.hookSecret(token)) {
        logger.warn('tellBot rejected', { method: req.method, hasHeader: !!req.get('X-Telegram-Bot-Api-Secret-Token') });
        res.status(403).send('no');
        return;
    }
    try {
        await tell.handleUpdate(token, req.body || {});
    } catch (e) {
        logger.error('tellBot', e);
    }
    res.status(200).send('ok'); // always 200 so Telegram doesn't retry
});

exports.tellOutbox = onDocumentCreated({ document: 'tellOutbox/{id}', secrets: [TELEGRAM_TOKEN] }, async (event) => {
    if (event.data) await tell.sendOutbox(TELEGRAM_TOKEN.value(), event.data);
});
