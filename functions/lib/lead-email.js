/* ==========================================================================
   LEAD OUTREACH EMAIL

   One email goes out when Max presses Send in the admin panel's lead
   generator: a personal outreach message to a prospect, drafted in the panel
   and edited by hand first. NEVER auto-sends - it is always a human pressing
   the button.

   The body is plain text the admin wrote/edited, and it goes out as PLAIN
   TEXT ONLY - no letterhead, no colours - so it reads like a normal email
   Max typed himself (Max, 17 Nov 2026).

   SENDING NEVER THROWS to the caller beyond a returned { sent:false }.
   ========================================================================== */

const nodemailer = require('nodemailer');
const logger = require('firebase-functions/logger');

const SELLER = {
    name: 'SoundzGood Whitsundays',
    email: process.env.SG_FROM_EMAIL || 'bookings@soundzgood.com.au'
};
const OFFICE = process.env.SG_OFFICE_EMAIL || 'info@soundzgood.com.au';

function esc(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function transport() {
    const user = (process.env.SMTP_USER || '').trim();
    const pass = (process.env.SMTP_PASS || '').replace(/\s+/g, '');
    if (!user || !pass) return null;
    return nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user, pass } });
}

/*  Preview only (Messages page): the message as the reader sees plain text. */
function leadHtml(body) {
    return '<div style="white-space:pre-wrap;font-family:Arial,Helvetica,sans-serif;font-size:14px;">' + esc(body) + '</div>';
}

/*  Send one outreach email. Returns { sent, reason?, error? }. */
async function sendLeadEmail({ to, subject, body }) {
    const tx = transport();
    if (!tx) {
        logger.warn('lead email: SMTP not configured');
        return { sent: false, reason: 'no-smtp' };
    }
    if (!to) return { sent: false, reason: 'no-address' };

    try {
        await tx.sendMail({
            kind: 'lead',
            from: `${SELLER.name} <${SELLER.email}>`,
            to,
            replyTo: OFFICE,
            subject: subject || 'SoundzGood Whitsundays',
            text: String(body || '') // plain text only - no html, so no theming
        });
        return { sent: true };
    } catch (err) {
        logger.error('lead email failed', { to, smtpError: err && err.message, smtpCode: err && (err.code || err.responseCode) });
        return { sent: false, reason: 'smtp-error', error: err && err.message };
    }
}

module.exports = { sendLeadEmail, leadHtml };
