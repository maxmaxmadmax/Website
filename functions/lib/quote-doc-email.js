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
    site: 'www.soundzgood.com.au'
};
const OFFICE = process.env.SG_OFFICE_EMAIL || 'info@soundzgood.com.au';

const money = (c) => '$' + (Math.round(c || 0) / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function esc(v) {
    return String(v == null ? '' : v)
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

/*  Production jobs (not DJ bookings): the customer can share the gear list
    (no prices) with their band, tour manager or tech from their quote page. */

function docLabel(q) {
    return q.kind === 'invoice' ? 'invoice' : 'quote';
}

/*  The words Max can change in Preview & send: subject, heading and message.
    opts.updated: it went out before, so the wording says "updated".
    opts.subject / opts.heading / opts.message: his edits (plain text) win. */
function wording(q, opts = {}) {
    const ref = q.kind === 'invoice' ? q.invoiceNumber || q.number : q.number;
    const who = (q.customer && q.customer.name) || 'there';
    const ev = q.customer && q.customer.eventName ? ' for ' + q.customer.eventName : '';
    const pick = (v, d, max) =>
        String(v || '')
            .trim()
            .slice(0, max) || d;
    return {
        subject: pick(opts.subject, `Your ${opts.updated ? 'updated ' : ''}${docLabel(q)} ${ref} from SoundzGood`, 200),
        heading: pick(opts.heading, `Your ${docLabel(q)} ${opts.updated ? 'has been updated' : 'is ready'}`, 120),
        message: pick(
            opts.message,
            `Hi ${who},

Here's your ${opts.updated ? 'updated ' : ''}${docLabel(q)}${ev} (${ref}).`,
            3000
        )
    };
}

/*  How to accept: quotes not yet accepted only. Pay-in-full quotes skip the deposit words. */
function acceptSteps(q) {
    if (q.kind === 'invoice' || q.acceptedAt) return null;
    return {
        steps: [
            'Tap <b>View &amp; accept your quote</b> above.',
            'Scroll to <b>Accept &amp; secure your booking</b> at the bottom.',
            q.payFull
                ? 'Choose how you&rsquo;d like to pay: bank transfer or card.'
                : 'Choose how you&rsquo;d like to pay: bank transfer or card, deposit or in full.',
            'Agree to the <b>Terms &amp; Conditions</b>, then press <b>Accept</b>.'
        ],
        after: 'Your date is secured once you accept your quote. Please pay by the due dates on your invoice to avoid late fees.'
    };
}
const plain = (h) =>
    h
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&rsquo;/g, "'");

function html(q, link, opts = {}) {
    const verb = q.kind === 'invoice' ? 'View your invoice' : 'View &amp; accept your quote';
    const w = wording(q, opts);
    const how = acceptSteps(q);

    return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:600px;margin:auto;background:#fff;border-radius:10px;overflow:hidden;">
    <div style="background:#111;padding:24px;">
      <p style="margin:0;color:#ff6b00;font-size:12px;letter-spacing:2px;text-transform:uppercase;">SoundzGood Whitsundays</p>
      <h1 style="margin:6px 0 0;color:#fff;font-size:22px;">${esc(w.heading)}</h1>
    </div>
    <div style="padding:24px;">
      <p style="margin:0 0 16px;font-size:15px;color:#111;line-height:1.6;white-space:pre-wrap;">${esc(w.message)}</p>
      <div style="background:#fff7ef;border:1px solid #ffd9b3;border-radius:10px;padding:16px 20px;margin:0 0 20px;text-align:center;">
        <p style="margin:0 0 4px;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#b25b00;">Total (incl GST)</p>
        <p style="margin:0;font-size:28px;font-weight:bold;color:#111;">${esc(money(q.totalCents))}</p>
      </div>
      <p style="text-align:center;margin:0 0 22px;">
        <a href="${esc(link)}" style="display:inline-block;background:#ff6b00;color:#fff;text-decoration:none;font-weight:bold;font-size:15px;padding:13px 26px;border-radius:10px;">${verb} &rarr;</a>
      </p>
      ${
          how
              ? `<p style="margin:0 0 6px;font-size:15px;font-weight:bold;color:#111;">To accept your quote:</p>
      <ol style="margin:0 0 10px;padding-left:22px;font-size:14px;color:#111;line-height:1.7;">${how.steps.map((t) => '<li>' + t + '</li>').join('')}</ol>
      <p style="margin:0 0 20px;font-size:14px;color:#555;line-height:1.6;">${how.after}</p>`
              : ''
      }
      <div style="border:1px solid #eee;border-radius:10px;padding:14px 18px;margin:0 0 20px;">
        <p style="margin:0 0 4px;font-size:15px;font-weight:bold;color:#111;">Share the itemised gear list</p>
        <p style="margin:0 0 10px;font-size:13px;color:#555;line-height:1.5;">It lists the exact make and model of everything we&rsquo;re supplying &mdash; amps, in-ears, microphones and cables. Add your venue manager, event coordinator, band or tech and we&rsquo;ll email it to them when you accept your quote, and again 3 days before your event.</p>
        <a href="${esc(link)}#qp-team" style="color:#ff6b00;font-weight:bold;font-size:14px;text-decoration:none;">Add your team &rarr;</a>
      </div>
      <p style="margin:0 0 20px;font-size:15px;color:#111;line-height:1.6;">
        Any questions, just reply to this email.<br><br>
        Cheers,<br>Max<br>SoundzGood Whitsundays &middot; 0422 393 022
      </p>
      <p style="margin:0;font-size:13px;color:#666;line-height:1.6;">
        Or paste this link into your browser:<br>
        <a href="${esc(link)}" style="color:#ff6b00;word-break:break-all;">${esc(link)}</a>
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

function text(q, link, opts = {}) {
    const w = wording(q, opts);
    const how = acceptSteps(q);
    return [
        w.heading + ' - SoundzGood Whitsundays',
        '',
        w.message,
        '',
        `Total (incl GST): ${money(q.totalCents)}`,
        '',
        `View it here: ${link}`,
        '',
        ...(how ? ['To accept your quote:', ...how.steps.map((t, i) => i + 1 + '. ' + plain(t)), '', plain(how.after), ''] : []),
        `Share the itemised gear list (exact make and model of everything we're supplying) with your venue manager, event coordinator, band or tech: ${link}#qp-team`,
        '',
        'Any questions, just reply to this email.',
        '',
        'Cheers,',
        'Max',
        'SoundzGood Whitsundays - 0422 393 022',
        '',
        `${SELLER.name} - ${SELLER.email} - ${SELLER.site}`
    ].join('\n');
}

async function sendQuoteLinkEmail(q, link, opts = {}) {
    const tx = transport();
    if (!tx) {
        logger.warn('quote email: SMTP not configured');
        return { sent: false, reason: 'no-smtp' };
    }
    const to = q.customer && q.customer.email;
    if (!to) return { sent: false, reason: 'no-address' };

    try {
        await tx.sendMail({
            kind: 'quote',
            from: `${SELLER.name} <${SELLER.email}>`,
            to,
            // the customer's CC addresses (comma separated, e.g. their accounts team)
            // get a copy; never the main address twice
            ...(() => {
                const cc = String((q.customer && q.customer.ccEmail) || '')
                    .split(/[,;\s]+/)
                    .map((e) => e.trim())
                    .filter((e) => e && e.toLowerCase() !== String(to).toLowerCase());
                return cc.length ? { cc: cc.join(', ') } : {};
            })(),
            // a copy of every email goes to the office
            bcc: OFFICE,
            replyTo: OFFICE,
            subject: wording(q, opts).subject,
            text: text(q, link, opts),
            html: html(q, link, opts)
        });
        return { sent: true };
    } catch (err) {
        logger.error('quote email failed', { to, smtpError: err && err.message });
        return { sent: false, reason: 'smtp-error', error: err && err.message };
    }
}

/* --------------------------------------------------------------------------
   PAYMENT REMINDER - Messages > Reminders, or "Send reminder" beside View
   in the Sales Pipeline. Only sent when an admin presses the button.
   info = { dueCents, dueLabel, isDeposit, balanceDue }
   -------------------------------------------------------------------------- */
function reminderHtml(q, link, info) {
    const isInvoice = q.kind === 'invoice';
    const ref = isInvoice ? q.invoiceNumber || q.number : q.number;
    const who = String((q.customer && q.customer.name) || '').split(' ')[0] || 'there';
    const what = q.customer && q.customer.eventName ? ' for ' + esc(q.customer.eventName) : '';
    return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:600px;margin:auto;background:#fff;border-radius:10px;overflow:hidden;">
    <div style="background:#111;padding:24px;">
      <p style="margin:0;color:#ff6b00;font-size:12px;letter-spacing:2px;text-transform:uppercase;">SoundzGood Whitsundays</p>
      <h1 style="margin:6px 0 0;color:#fff;font-size:22px;">A friendly payment reminder</h1>
    </div>
    <div style="padding:24px;">
      <p style="margin:0 0 16px;font-size:15px;color:#111;line-height:1.6;">
        Hi ${esc(who)}, just a quick reminder about your ${esc(docLabel(q))} <strong>${esc(ref)}</strong>${what}.
        ${info.isDeposit ? 'Your date is held once the deposit is received.' : 'Payment is now due.'}
      </p>
      <div style="background:#fff7ef;border:1px solid #ffd9b3;border-radius:10px;padding:16px 20px;margin:0 0 20px;text-align:center;">
        <p style="margin:0 0 4px;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#b25b00;">${esc(info.dueLabel)}</p>
        <p style="margin:0;font-size:28px;font-weight:bold;color:#111;">${esc(money(info.dueCents))}</p>
        ${info.balanceDue ? '<p style="margin:6px 0 0;font-size:13px;color:#666;">Balance due ' + esc(info.balanceDue) + '</p>' : ''}
      </div>
      <p style="text-align:center;margin:0 0 22px;">
        <a href="${esc(link)}" style="display:inline-block;background:#ff6b00;color:#fff;text-decoration:none;font-weight:bold;font-size:15px;padding:13px 26px;border-radius:10px;">View &amp; pay &rarr;</a>
      </p>
      <p style="margin:0 0 12px;font-size:13px;color:#666;line-height:1.6;">You can pay by bank transfer or card on that page. If you've already paid, thank you, and please ignore this email.</p>
      <p style="margin:0;font-size:13px;color:#666;line-height:1.6;">
        Questions? Just reply to this email or call Max on 0422 393 022.<br>
        <a href="${esc(link)}" style="color:#ff6b00;word-break:break-all;">${esc(link)}</a>
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
function reminderSubject(q) {
    return 'Payment reminder - ' + (q.kind === 'invoice' ? q.invoiceNumber || q.number : q.number) + ' from SoundzGood';
}
async function sendPaymentReminderEmail(q, link, info) {
    const tx = transport();
    if (!tx) return { sent: false, reason: 'no-smtp' };
    const to = q.customer && q.customer.email;
    if (!to) return { sent: false, reason: 'no-address' };
    const cc = String((q.customer && q.customer.ccEmail) || '')
        .split(/[,;\s]+/)
        .map((e) => e.trim())
        .filter((e) => e && e.toLowerCase() !== String(to).toLowerCase());
    const who = String((q.customer && q.customer.name) || '').split(' ')[0] || 'there';
    try {
        await tx.sendMail({
            from: `${SELLER.name} <${SELLER.email}>`,
            to,
            ...(cc.length ? { cc: cc.join(', ') } : {}),
            bcc: OFFICE,
            replyTo: OFFICE,
            subject: reminderSubject(q),
            text: [
                'Hi ' + who + ', just a quick reminder about your ' + docLabel(q) + '.',
                info.dueLabel + ': ' + money(info.dueCents),
                '',
                'View & pay: ' + link,
                '',
                "If you've already paid, thank you - please ignore this.",
                SELLER.name + ' - 0422 393 022'
            ].join('\n'),
            html: reminderHtml(q, link, info)
        });
        return { sent: true };
    } catch (err) {
        logger.error('reminder email failed', { to, smtpError: err && err.message });
        return { sent: false, reason: 'smtp-error', error: err && err.message };
    }
}
function renderPaymentReminder(q, link, info) {
    return { subject: reminderSubject(q), html: reminderHtml(q, link, info) };
}

/*  For the previews: the email plus its editable words. */
function renderQuoteLinkEmail(q, link, opts = {}) {
    const w = wording(q, opts);
    return { subject: w.subject, html: html(q, link, opts), fields: w };
}

module.exports = { sendQuoteLinkEmail, renderQuoteLinkEmail, sendPaymentReminderEmail, renderPaymentReminder };
