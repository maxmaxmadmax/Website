/* ==========================================================================
   MESSAGES - turning a saved message into an email  (Max, 19 Oct 2026)

   A message is written in the admin Messages page as plain text with
   {{fields}} in it. This file fills the fields for one vendor, turns the
   text into the SoundzGood letterhead, and sends it. Never throws - the
   caller decides what to do with { sent }.

   KEEP IN STEP with renderBody() / fillFields() in js/messages.js, which
   draws the live preview in the admin page.

   Writing rules (the same ones the preview uses):
     - a blank line starts a new paragraph
     - a line starting "- " is a bullet point
     - {{business_name}} etc. are filled in for each vendor
   ========================================================================== */

const nodemailer = require('nodemailer');
const logger = require('firebase-functions/logger');

const SELLER = {
  name: 'SoundzGood Whitsundays',
  legal: process.env.SG_LEGAL_NAME || '',
  abn: process.env.SG_ABN || '',
  email: process.env.SG_FROM_EMAIL || 'bookings@soundzgood.com.au',
  site: 'www.soundzgood.com.au',
};
const OFFICE = process.env.SG_OFFICE_EMAIL || 'info@soundzgood.com.au';

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function transport() {
  const user = (process.env.SMTP_USER || '').trim();
  const pass = (process.env.SMTP_PASS || '').replace(/\s+/g, '');
  if (!user || !pass) return null;
  return nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user, pass } });
}

/*  The fields a message can use. Same list as FIELDS in js/messages.js. */
function fieldsFor(booking, event, guideLink) {
  const biz = booking.business || {};
  return {
    vendor_name: biz.contactName || biz.name || 'there',
    business_name: biz.name || '',
    site_number: booking.siteLabel || '',
    event_name: event.name || '',
    event_date: event.dateLabel || event.dateISO || '',
    event_venue: [event.venue, event.location].filter(Boolean).join(', '),
    guide_link: guideLink || '',
  };
}

function fill(text, values, clean) {
  return String(text || '').replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (whole, key) => {
    const v = values[key.toLowerCase()];
    return v === undefined ? whole : clean(v);
  });
}

/*  Plain text -> paragraphs and bullet lists, already filled in. */
function bodyHtml(body, values) {
  return String(body || '').replace(/\r/g, '').split(/\n\s*\n/).map((block) => {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) return '';
    if (lines.every((l) => /^\s*-\s+/.test(l))) {
      return '<ul style="margin:0 0 14px;padding-left:20px;">'
        + lines.map((l) => '<li style="margin:0 0 6px;">' + fill(esc(l.replace(/^\s*-\s+/, '')), values, esc) + '</li>').join('')
        + '</ul>';
    }
    return '<p style="margin:0 0 14px;">' + lines.map((l) => fill(esc(l), values, esc)).join('<br>') + '</p>';
  }).join('');
}

function html(msg, values, opts) {
  const button = values.guide_link
    ? `<p style="text-align:center;margin:22px 0 6px;">
        <a href="${esc(values.guide_link)}" style="display:inline-block;background:#ff6b00;color:#fff;text-decoration:none;font-weight:bold;font-size:15px;padding:13px 26px;border-radius:10px;">View your invoice &amp; event guide &rarr;</a>
      </p>` : '';
  const unsub = opts.unsubscribeLink
    ? `<br><a href="${esc(opts.unsubscribeLink)}" style="color:#999;">Unsubscribe from event news</a>` : '';
  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:600px;margin:auto;background:#fff;border-radius:10px;overflow:hidden;">
    <div style="background:#111;padding:20px 24px;">
      <p style="margin:0;color:#ff6b00;font-size:12px;letter-spacing:2px;text-transform:uppercase;">SoundzGood Whitsundays</p>
    </div>
    <div style="padding:24px;font-size:15px;line-height:1.6;color:#111;">
      ${bodyHtml(msg.body, values)}
      ${button}
    </div>
    <div style="padding:18px 24px;background:#fafafa;border-top:1px solid #eee;">
      <p style="margin:0;font-size:12px;color:#777;line-height:1.6;">
        ${esc(SELLER.name)}${SELLER.legal ? ' &middot; ' + esc(SELLER.legal) : ''}${SELLER.abn ? ' &middot; ABN ' + esc(SELLER.abn) : ''}<br>
        ${esc(SELLER.email)} &middot; ${esc(SELLER.site)}${unsub}
      </p>
    </div>
  </div>
</body></html>`;
}

function text(msg, values, opts) {
  const plain = fill(String(msg.body || ''), values, (v) => String(v));
  return [
    plain,
    values.guide_link ? '\nYour invoice & event guide: ' + values.guide_link : '',
    '',
    `${SELLER.name} - ${SELLER.email} - ${SELLER.site}`,
    opts.unsubscribeLink ? 'Unsubscribe from event news: ' + opts.unsubscribeLink : '',
  ].filter((l) => l !== '').join('\n');
}

/*  opts: { to, test, unsubscribeLink } */
async function sendMessageEmail(msg, values, opts) {
  const tx = transport();
  if (!tx) return { sent: false, reason: 'no-smtp' };
  if (!opts.to) return { sent: false, reason: 'no-address' };
  try {
    await tx.sendMail({
      kind: 'message',
      from: `${SELLER.name} <${SELLER.email}>`,
      to: opts.to,
      // a copy of every email goes to the office (Max, 20 Oct 2026)
      ...(opts.test ? {} : { bcc: OFFICE }),
      replyTo: OFFICE,
      subject: (opts.test ? '[TEST] ' : '') + fill(msg.subject, values, (v) => String(v)),
      text: text(msg, values, opts),
      html: html(msg, values, opts),
    });
    return { sent: true };
  } catch (err) {
    logger.error('message email failed', { to: opts.to, smtpError: err && err.message });
    return { sent: false, reason: 'smtp-error', error: err && err.message };
  }
}

module.exports = { sendMessageEmail, fieldsFor, bodyHtml, fill };
