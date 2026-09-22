/* ==========================================================================
   QUOTE / INVOICE EMAIL

   Sends the customer the link to view and accept their quote (or to see an
   invoice). Same letterhead as the other mail. Never throws - the caller
   decides what to do with { sent }.
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

const money = (c) => '$' + (Math.round(c || 0) / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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

function docLabel(q) {
  return q.kind === 'invoice' ? 'invoice' : 'quote';
}

function html(q, link) {
  const isInvoice = q.kind === 'invoice';
  const ref = isInvoice ? (q.invoiceNumber || q.number) : q.number;
  const who = (q.customer && q.customer.name) || 'there';
  const verb = isInvoice ? 'View your invoice' : 'View &amp; accept your quote';

  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:600px;margin:auto;background:#fff;border-radius:10px;overflow:hidden;">
    <div style="background:#111;padding:24px;">
      <p style="margin:0;color:#ff6b00;font-size:12px;letter-spacing:2px;text-transform:uppercase;">SoundzGood Whitsundays</p>
      <h1 style="margin:6px 0 0;color:#fff;font-size:22px;">Your ${esc(docLabel(q))} is ready</h1>
    </div>
    <div style="padding:24px;">
      <p style="margin:0 0 16px;font-size:15px;color:#111;">
        Hi ${esc(who)}, here's your ${esc(docLabel(q))}
        <strong>${esc(ref)}</strong>${q.customer && q.customer.eventName ? ' for ' + esc(q.customer.eventName) : ''}.
      </p>
      <div style="background:#fff7ef;border:1px solid #ffd9b3;border-radius:10px;padding:16px 20px;margin:0 0 20px;text-align:center;">
        <p style="margin:0 0 4px;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#b25b00;">Total (incl GST)</p>
        <p style="margin:0;font-size:28px;font-weight:bold;color:#111;">${esc(money(q.totalCents))}</p>
      </div>
      <p style="text-align:center;margin:0 0 22px;">
        <a href="${esc(link)}" style="display:inline-block;background:#ff6b00;color:#fff;text-decoration:none;font-weight:bold;font-size:15px;padding:13px 26px;border-radius:10px;">${verb} &rarr;</a>
      </p>
      <p style="margin:0;font-size:13px;color:#666;line-height:1.6;">
        Or paste this link into your browser:<br>
        <a href="${esc(link)}" style="color:#ff6b00;word-break:break-all;">${esc(link)}</a>
      </p>
    </div>
    <div style="padding:18px 24px;background:#fafafa;border-top:1px solid #eee;">
      <p style="margin:0;font-size:12px;color:#777;">
        ${esc(SELLER.name)}${SELLER.legal ? ' &middot; ' + esc(SELLER.legal) : ''}${SELLER.abn ? ' &middot; ABN ' + esc(SELLER.abn) : ''}<br>
        ${esc(SELLER.email)} &middot; ${esc(SELLER.site)}
      </p>
    </div>
  </div>
</body></html>`;
}

function text(q, link) {
  const ref = q.kind === 'invoice' ? (q.invoiceNumber || q.number) : q.number;
  return [
    `Your ${docLabel(q)} ${ref} - SoundzGood Whitsundays`,
    '',
    `Hi ${(q.customer && q.customer.name) || 'there'}, here's your ${docLabel(q)}.`,
    `Total (incl GST): ${money(q.totalCents)}`,
    '',
    `View it here: ${link}`,
    '',
    `${SELLER.name} - ${SELLER.email} - ${SELLER.site}`,
  ].join('\n');
}

async function sendQuoteLinkEmail(q, link) {
  const tx = transport();
  if (!tx) { logger.warn('quote email: SMTP not configured'); return { sent: false, reason: 'no-smtp' }; }
  const to = q.customer && q.customer.email;
  if (!to) return { sent: false, reason: 'no-address' };

  try {
    await tx.sendMail({
      from: `${SELLER.name} <${SELLER.email}>`,
      to,
      replyTo: OFFICE,
      subject: `Your ${docLabel(q)} ${q.kind === 'invoice' ? (q.invoiceNumber || q.number) : q.number} from SoundzGood`,
      text: text(q, link),
      html: html(q, link),
    });
    return { sent: true };
  } catch (err) {
    logger.error('quote email failed', { to, smtpError: err && err.message });
    return { sent: false, reason: 'smtp-error', error: err && err.message };
  }
}

module.exports = { sendQuoteLinkEmail };
