/* ==========================================================================
   LEAD OUTREACH EMAIL

   One email goes out when Max presses Send in the admin panel's lead
   generator: a personal outreach message to a prospect, drafted in the panel
   and edited by hand first. NEVER auto-sends - it is always a human pressing
   the button.

   The body is plain text the admin wrote/edited, so we send it as-is (text)
   and also wrap it in the same dark letterhead as the other SoundzGood mail so
   it looks like it came from the business.

   SENDING NEVER THROWS to the caller beyond a returned { sent:false }.
   ========================================================================== */

const nodemailer = require('nodemailer');
const logger = require('firebase-functions/logger');

const SELLER = {
  name: 'SoundzGood Whitsundays',
  email: process.env.SG_FROM_EMAIL || 'bookings@soundzgood.com.au',
  site: 'www.soundzgood.com.au',
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

/*  The admin's plain-text message, wrapped in the letterhead. Line breaks
    become <br> so the paragraphing they typed survives.                   */
function leadHtml(body) {
  const safe = esc(body).replace(/\n/g, '<br>');
  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:600px;margin:auto;background:#fff;border-radius:10px;overflow:hidden;">
    <div style="background:#111;padding:20px 24px;">
      <p style="margin:0;color:#ff6b00;font-size:12px;letter-spacing:2px;text-transform:uppercase;">SoundzGood Whitsundays</p>
    </div>
    <div style="padding:24px;font-size:15px;color:#111;line-height:1.6;">${safe}</div>
    <div style="padding:16px 24px;background:#fafafa;border-top:1px solid #eee;">
      <p style="margin:0;font-size:12px;color:#777;">${esc(SELLER.name)} &middot; ${esc(SELLER.email)} &middot; ${esc(SELLER.site)}</p>
    </div>
  </div>
</body></html>`;
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
      from: `${SELLER.name} <${SELLER.email}>`,
      to,
      replyTo: OFFICE,
      subject: subject || 'SoundzGood Whitsundays',
      text: String(body || ''),
      html: leadHtml(body || ''),
    });
    return { sent: true };
  } catch (err) {
    logger.error('lead email failed', { to, smtpError: err && err.message, smtpCode: err && (err.code || err.responseCode) });
    return { sent: false, reason: 'smtp-error', error: err && err.message };
  }
}

module.exports = { sendLeadEmail };
