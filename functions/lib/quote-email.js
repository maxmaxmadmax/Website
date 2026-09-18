/* ==========================================================================
   QUOTE LEAD EMAIL

   One email goes out when a visitor finishes the estimate bot on the
   services page: a friendly auto-reply to THEM, with the range they were
   shown and a summary of what they asked for. Max chose this ("Auto-reply
   to them") - he watches the leads in the admin desk rather than getting a
   copy of every one by email.

   It reuses the same letterhead as the booking emails so an estimate and a
   later invoice look like they came from the same business.

   SENDING NEVER THROWS
   The lead is already saved before this runs. A mail server hiccup must not
   lose the lead, so every failure here is caught and reported, never thrown.
   ========================================================================== */

const nodemailer = require('nodemailer');
const logger = require('firebase-functions/logger');

const SELLER = {
  name: 'SoundzGood Whitsundays',
  email: process.env.SG_FROM_EMAIL || 'bookings@soundzgood.com.au',
  site: 'www.soundzgood.com.au',
};

/*  Where a reply from the visitor lands, and where the "book me in" nudge
    points. The office address, same as the booking mail.                 */
const OFFICE = process.env.SG_OFFICE_EMAIL || 'info@soundzgood.com.au';

const money = (cents) => '$' + Math.round((cents || 0) / 100).toLocaleString('en-AU');

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/*  Same SMTP as the booking mail - Google Workspace, app password with the
    spaces stripped. Returns null when the secret is not set, so the caller
    can say "saved, but no email went" rather than crash.                 */
function transport() {
  const user = (process.env.SMTP_USER || '').trim();
  const pass = (process.env.SMTP_PASS || '').replace(/\s+/g, '');
  if (!user || !pass) return null;

  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user, pass },
  });
}

function summaryRows(lead) {
  const rows = [];
  const add = (k, v) => { if (v) rows.push([k, v]); };

  add('Event', lead.eventTypeLabel);
  add('Where', lead.locationLabel);
  add('Size', lead.sizeLabel);
  add('Length', lead.durationLabel);
  add('Looking for', (lead.serviceLabels || []).join(', '));
  if (lead.eventDate) add('Your date', lead.eventDate);
  return rows;
}

function rangeText(lead) {
  const lo = money(lead.estimateLowCents);
  const hi = money(lead.estimateHighCents);
  return lo === hi ? lo : `${lo} - ${hi}`;
}

function leadHtml(lead) {
  const rows = summaryRows(lead);
  const row = (k, v) => `
    <tr>
      <td style="padding:7px 0;color:#555;font-size:14px;">${esc(k)}</td>
      <td style="padding:7px 0;text-align:right;font-size:14px;color:#111;">${esc(v)}</td>
    </tr>`;

  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:600px;margin:auto;background:#fff;border-radius:10px;overflow:hidden;">

    <div style="background:#111;padding:24px;">
      <p style="margin:0;color:#ff6b00;font-size:12px;letter-spacing:2px;text-transform:uppercase;">SoundzGood Whitsundays</p>
      <h1 style="margin:6px 0 0;color:#fff;font-size:22px;">Your estimate</h1>
    </div>

    <div style="padding:24px;">
      <p style="margin:0 0 16px;font-size:15px;color:#111;">
        Thanks ${esc(lead.name || 'there')} - here's the ballpark from our quick estimate,
        and a copy of what you told us.
      </p>

      <div style="background:#fff7ef;border:1px solid #ffd9b3;border-radius:10px;padding:18px 20px;margin:0 0 20px;text-align:center;">
        <p style="margin:0 0 4px;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#b25b00;">Estimated range</p>
        <p style="margin:0;font-size:28px;font-weight:bold;color:#111;">${esc(rangeText(lead))}</p>
      </div>

      ${rows.length ? `<table style="width:100%;border-collapse:collapse;border-top:1px solid #eee;margin:0 0 18px;">
        ${rows.map((r) => row(r[0], r[1])).join('')}
      </table>` : ''}

      <p style="margin:0 0 6px;font-size:14px;color:#111;"><strong>This is a guide, not a fixed quote.</strong></p>
      <p style="margin:0 0 18px;font-size:14px;color:#444;line-height:1.6;">
        Every event is different, so the final price depends on the details. Want us
        to put together an exact quote? Just reply to this email - we'll be in touch soon.
      </p>

      <p style="margin:0;font-size:14px;color:#444;line-height:1.6;">
        Cheers,<br>The SoundzGood team
      </p>
    </div>

    <div style="padding:18px 24px;background:#fafafa;border-top:1px solid #eee;">
      <p style="margin:0;font-size:12px;color:#777;">
        ${esc(SELLER.name)} &middot; ${esc(SELLER.email)} &middot; ${esc(SELLER.site)}
      </p>
    </div>
  </div>
</body></html>`;
}

function leadText(lead) {
  const rows = summaryRows(lead);
  return [
    'Your estimate - SoundzGood Whitsundays',
    '',
    `Thanks ${lead.name || 'there'} - here's the ballpark from our quick estimate.`,
    '',
    `ESTIMATED RANGE: ${rangeText(lead)}`,
    '',
    ...rows.map((r) => `${r[0]}: ${r[1]}`),
    '',
    'This is a guide, not a fixed quote. Every event is different, so the final',
    'price depends on the details. Want an exact quote? Just reply to this email.',
    '',
    'Cheers, The SoundzGood team',
    `${SELLER.name} - ${SELLER.email} - ${SELLER.site}`,
  ].filter((l) => l !== undefined).join('\n');
}

/*  Send the visitor their estimate. Returns { sent, reason?, error? };
    never throws.                                                         */
async function sendQuoteEmail(lead) {
  const tx = transport();
  if (!tx) {
    logger.warn('quote lead saved but SMTP not configured, no email sent');
    return { sent: false, reason: 'no-smtp' };
  }

  const to = lead.email;
  if (!to) return { sent: false, reason: 'no-address' };

  try {
    await tx.sendMail({
      from: `${SELLER.name} <${SELLER.email}>`,
      to,
      replyTo: OFFICE,
      subject: `Your SoundzGood estimate${lead.eventTypeLabel ? ' - ' + lead.eventTypeLabel : ''}`,
      text: leadText(lead),
      html: leadHtml(lead),
    });
    return { sent: true };
  } catch (err) {
    logger.error('quote lead email failed', {
      to,
      smtpError: err && err.message,
      smtpCode: err && (err.code || err.responseCode),
      smtpResponse: err && err.response,
    });
    return { sent: false, reason: 'smtp-error', error: err && err.message };
  }
}

module.exports = { sendQuoteEmail, __test: { leadHtml, leadText, rangeText } };
