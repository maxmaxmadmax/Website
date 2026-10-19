/* ==========================================================================
   VENDOR TAX INVOICE EMAIL  (Max, 19 Oct 2026)

   A short, friendly email with one big button. The invoice itself, the
   thank-you, the event details and the vendor instructions all live on the
   private page the button opens (/vendor-invoice?t=<token>), which prints
   as A4 pages.

   Same letterhead as the quote emails. Never throws - the caller decides
   what to do with { sent }.

   NOTHING SENDS BY ITSELF. This file only sends when index.js asks it to,
   and index.js only asks from the admin desk (test to Max, or a vendor
   after Max says go).
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

const money = (c) => '$' + (Math.round(c || 0) / 100).toLocaleString('en-AU',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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

function html(d) {
  const who = d.contactName || d.businessName || 'there';
  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:600px;margin:auto;background:#fff;border-radius:10px;overflow:hidden;">
    <div style="background:#111;padding:24px;">
      <p style="margin:0;color:#ff6b00;font-size:12px;letter-spacing:2px;text-transform:uppercase;">SoundzGood Whitsundays</p>
      <h1 style="margin:6px 0 0;color:#fff;font-size:22px;">Thank you &mdash; you&rsquo;re booked in</h1>
    </div>
    <div style="padding:24px;">
      <p style="margin:0 0 16px;font-size:15px;color:#111;line-height:1.6;">
        Hi ${esc(who)}, thank you for being part of <strong>${esc(d.eventName || 'Eatz & Beatz')}</strong>${d.eventDate ? ' on ' + esc(d.eventDate) : ''}.
        Your tax invoice, event details and vendor instructions are all in one place:
      </p>
      <div style="background:#fff7ef;border:1px solid #ffd9b3;border-radius:10px;padding:16px 20px;margin:0 0 20px;text-align:center;">
        <p style="margin:0 0 4px;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#b25b00;">Total paid (incl GST)</p>
        <p style="margin:0;font-size:28px;font-weight:bold;color:#111;">${esc(money(d.totalCents))}</p>
        <p style="margin:6px 0 0;font-size:13px;color:#666;">Invoice ${esc(d.invoiceNumber)}</p>
      </div>
      <p style="text-align:center;margin:0 0 22px;">
        <a href="${esc(d.link)}" style="display:inline-block;background:#ff6b00;color:#fff;text-decoration:none;font-weight:bold;font-size:15px;padding:13px 26px;border-radius:10px;">View your invoice &amp; event guide &rarr;</a>
      </p>
      <div style="background:#111;border-radius:10px;padding:16px 20px;margin:0 0 20px;">
        <p style="margin:0 0 6px;font-size:15px;font-weight:bold;color:#ff6b00;">Help us promote the event</p>
        <p style="margin:0;font-size:14px;color:#ddd;line-height:1.6;">
          A bigger crowd means more sales for every stall. Your guide includes the event poster, the A4 program
          and share links &mdash; please post them on your socials, share them with your customers and pop the poster up and help us advertise.
        </p>
      </div>
      <p style="margin:0;font-size:13px;color:#666;line-height:1.6;">
        You can print it or save it as a PDF from that page. Or paste this link into your browser:<br>
        <a href="${esc(d.link)}" style="color:#ff6b00;word-break:break-all;">${esc(d.link)}</a>
      </p>
    </div>
    <div style="padding:18px 24px;background:#fafafa;border-top:1px solid #eee;">
      <p style="margin:0;font-size:12px;color:#777;">
        ${esc(SELLER.name)}${SELLER.legal ? ' &middot; ' + esc(SELLER.legal) : ''}${SELLER.abn ? ' &middot; ABN ' + esc(SELLER.abn) : ''}<br>
        34a Williams St, Bowen QLD 4805<br>
        ${esc(SELLER.email)} &middot; ${esc(SELLER.site)}
      </p>
    </div>
  </div>
</body></html>`;
}

function text(d) {
  return [
    `Thank you - you're booked in (${d.eventName || 'Eatz & Beatz'})`,
    '',
    `Hi ${d.contactName || d.businessName || 'there'}, thank you for being part of ${d.eventName || 'Eatz & Beatz'}.`,
    `Total paid (incl GST): ${money(d.totalCents)}   Invoice ${d.invoiceNumber}`,
    '',
    `Your tax invoice, event details and vendor instructions: ${d.link}`,
    '',
    'HELP US PROMOTE THE EVENT - a bigger crowd means more sales for every stall. Your guide includes the event poster, the A4 program and share links. Please post them on your socials, share them with your customers and pop the poster up and help us advertise.',
    '',
    `${SELLER.name} - ${SELLER.email} - ${SELLER.site}`,
  ].join('\n');
}

/*  d: { to, link, invoiceNumber, totalCents, businessName, contactName,
         eventName, eventDate, test }                                    */
async function sendVendorInvoiceEmail(d) {
  const tx = transport();
  if (!tx) { logger.warn('vendor invoice email: SMTP not configured'); return { sent: false, reason: 'no-smtp' }; }
  if (!d.to) return { sent: false, reason: 'no-address' };

  try {
    await tx.sendMail({
      from: `${SELLER.name} <${SELLER.email}>`,
      to: d.to,
      replyTo: OFFICE,
      subject: (d.test ? '[TEST] ' : '') + `Your tax invoice & event guide - ${d.eventName || 'Eatz & Beatz'}`,
      text: text(d),
      html: html(d),
    });
    return { sent: true };
  } catch (err) {
    logger.error('vendor invoice email failed', { to: d.to, smtpError: err && err.message });
    return { sent: false, reason: 'smtp-error', error: err && err.message };
  }
}

module.exports = { sendVendorInvoiceEmail };
