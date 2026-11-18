/* ==========================================================================
   INVOICE, RECEIPT AND REVIEW EMAILS (Max, 18 Nov 2026)

   Everything for a booking stays in the one workflow:
     invoiceEmail   the customer accepts their quote -> link to their invoice,
                    what's due and how to pay, plus the invoice PDF when the
                    browser that has it open made one (pdf = Buffer)
     receiptEmail   money comes in (Stripe card, or Max marks it in admin)
                    -> "Payment received" - the email is the receipt
     reviewEmail    the Tuesday after the event -> "How did we do?" + Google review
   Never throws - each returns { sent } like the other mail.
   ========================================================================== */

const logger = require('firebase-functions/logger');
const { SELLER, OFFICE, transport, esc, money } = require('./quote-doc-email');

const ORANGE = '#ff6b00';
const REVIEW_URL = 'https://g.page/r/CSUgRhfqGvdnEAI/review'; // Google review box (same as the vendor thank-you)
const DEPOSIT_PCT = 50; // KEEP IN STEP with QUOTE_DEPOSIT_PCT in shared.js

/* ---- small helpers ---- */
const todayISO = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Brisbane' });
const isoDay = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '');
function addDays(iso, n) {
    if (!isoDay(iso)) return '';
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function prettyDay(iso) {
    if (!isoDay(iso)) return '';
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}
const eventName = (q) => (q.customer && q.customer.eventName) || 'your event';
const who = (q) => (q.customer && q.customer.name) || 'there';
const grandTotal = (q) => Math.round(q.totalCents || 0) + Math.round(q.lateFeeCents || 0);
const linkOf = (site, q) => site + '/quote?t=' + q.token;

/*  What they owe and when: the deposit now and the balance 7 days before the
    event, or everything now (pay in full, bank in full, or under 7 days out). */
function dues(q) {
    const total = grandTotal(q);
    const paid = Math.max(0, Math.round(q.amountPaidCents || 0));
    const owing = Math.max(0, total - paid);
    const balanceDay = addDays(q.hire && q.hire.startDate, -7);
    const fullNow = q.payFull === true || q.bankPlan === 'full' || !balanceDay || balanceDay <= todayISO();
    if (!paid && !fullNow) {
        const pct = q.depositPct || DEPOSIT_PCT;
        const deposit = Math.round((total * pct) / 100);
        return { total, paid, owing, nowCents: deposit, nowLabel: pct + '% deposit, due now', balanceCents: owing - deposit, balanceDay };
    }
    const later = !!(paid && owing && balanceDay && balanceDay > todayISO()); // deposit paid, balance not due yet
    return {
        total,
        paid,
        owing,
        nowCents: owing,
        nowLabel: later ? 'Balance, due ' + prettyDay(balanceDay) : paid ? 'Balance owing' : 'Due now',
        balanceCents: 0,
        balanceDay: later ? balanceDay : ''
    };
}

/* ---- email bits ---- */
const wrap = (heading, body, ask = true) => `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:600px;margin:auto;background:#fff;border-radius:10px;overflow:hidden;">
    <div style="background:#111;padding:24px;">
      <p style="margin:0;color:${ORANGE};font-size:12px;letter-spacing:2px;text-transform:uppercase;">SoundzGood Whitsundays</p>
      <h1 style="margin:6px 0 0;color:#fff;font-size:22px;">${esc(heading)}</h1>
    </div>
    <div style="padding:24px;font-size:15px;color:#111;line-height:1.6;">${body}
      <p style="margin:20px 0 0;">${ask ? 'Any questions, just reply to this email.<br><br>' : ''}Cheers,<br>Max<br>SoundzGood Whitsundays &middot; 0422 393 022</p>
    </div>
    <div style="padding:18px 24px;background:#fafafa;border-top:1px solid #eee;">
      <p style="margin:0;font-size:12px;color:#777;">${esc(SELLER.name)}${SELLER.legal ? ' &middot; ' + esc(SELLER.legal) : ''}${SELLER.abn ? ' &middot; ABN ' + esc(SELLER.abn) : ''}<br>34a Williams St, Bowen QLD 4805<br>${esc(SELLER.email)} &middot; ${esc(SELLER.site)}</p>
    </div>
  </div>
</body></html>`;
const SIGN_OFF = ['', 'Any questions, just reply to this email.', '', 'Cheers,', 'Max', 'SoundzGood Whitsundays - 0422 393 022'];
const button = (href, label) =>
    `<p style="text-align:center;margin:0 0 22px;"><a href="${esc(href)}" style="display:inline-block;background:${ORANGE};color:#fff;text-decoration:none;font-weight:bold;font-size:15px;padding:13px 26px;border-radius:10px;">${label} &rarr;</a></p>`;
const box = (rows) =>
    `<div style="background:#fff7ef;border:1px solid #ffd9b3;border-radius:10px;padding:14px 20px;margin:0 0 20px;">${rows
        .map((r) => `<p style="margin:4px 0;font-size:14px;"><span style="color:#666;">${esc(r[0])}:</span> <b>${esc(r[1])}</b></p>`)
        .join('')}</div>`;
const bankHtml = (ref) =>
    `<p style="margin:0 0 20px;font-size:14px;color:#333;"><b>Bank transfer</b><br>${esc(SELLER.bankName)}<br>BSB ${esc(SELLER.bankBsb)} &nbsp; Account ${esc(SELLER.bankAcc)}<br>Reference: ${esc(ref)}</p>`;
const reviewHtml = () =>
    `<div style="text-align:center;border:1px solid #eee;border-radius:10px;padding:18px;margin:0 0 20px;">
      <p style="margin:0 0 6px;font-weight:bold;">How did we do?</p>
      <p style="margin:0 0 12px;font-size:14px;color:#555;">If you were happy with us, a quick Google review really helps. It takes a minute.</p>
      <a href="${REVIEW_URL}" style="font-size:30px;letter-spacing:4px;color:#f5a623;text-decoration:none;">&#9733;&#9733;&#9733;&#9733;&#9733;</a><br>
      <a href="${REVIEW_URL}" style="display:inline-block;margin-top:10px;background:${ORANGE};color:#fff;text-decoration:none;font-weight:bold;font-size:15px;padding:12px 24px;border-radius:10px;">Leave a Google review &rarr;</a>
    </div>`;

/*  PAUSED (Max, 18 Nov 2026: "Don't email the customer"): until SG_CUSTOMER_EMAILS=on
    is set in functions/.env, these emails go to the office ONLY, marked with who
    they would have gone to. Nothing reaches a customer. */
const LIVE = process.env.SG_CUSTOMER_EMAILS === 'on';

async function send(q, mail) {
    const tx = transport();
    if (!tx) return { sent: false, reason: 'no-smtp' };
    const to = q.customer && q.customer.email;
    if (!to) return { sent: false, reason: 'no-address' };
    const cc = String((q.customer && q.customer.ccEmail) || '')
        .split(/[,;\s]+/)
        .map((e) => e.trim())
        .filter((e) => e && e.toLowerCase() !== String(to).toLowerCase());
    try {
        await tx.sendMail(
            LIVE
                ? {
                      from: `${SELLER.name} <${SELLER.email}>`,
                      to,
                      ...(cc.length ? { cc: cc.join(', ') } : {}),
                      bcc: OFFICE,
                      replyTo: OFFICE,
                      ...mail
                  }
                : {
                      from: `${SELLER.name} <${SELLER.email}>`,
                      to: OFFICE,
                      replyTo: OFFICE,
                      ...mail,
                      subject: '[NOT SENT - would go to ' + to + (cc.length ? ', cc ' + cc.join(', ') : '') + '] ' + mail.subject
                  }
        );
        return { sent: true };
    } catch (err) {
        logger.error(mail.kind + ' email failed', { to, smtpError: err && err.message });
        return { sent: false, reason: 'smtp-error', error: err && err.message };
    }
}

/* ---- 1. accepted: the tax invoice ---- */
function renderInvoice(q, site, pdf) {
    const ref = q.invoiceNumber || q.number;
    const d = dues(q);
    const link = linkOf(site, q);
    const rows = [[d.nowLabel, money(d.nowCents)]];
    if (d.balanceCents > 0) rows.push(['Balance ' + money(d.balanceCents), 'due ' + prettyDay(d.balanceDay)]);
    const html = wrap(
        'Your tax invoice',
        `<p style="margin:0 0 16px;">Hi ${esc(who(q))},</p>
      <p style="margin:0 0 16px;">Thanks for accepting your quote for ${esc(eventName(q))}. Your date is secured. Here is your tax invoice ${esc(ref)}${pdf ? ' (also attached as a PDF)' : ''}.</p>
      ${box(rows)}
      ${button(link, 'Pay by card or view your invoice')}
      ${bankHtml(ref)}
      <p style="margin:0;font-size:14px;color:#555;">Please pay by the due dates to avoid late fees.</p>`
    );
    const text = [
        `Hi ${who(q)},`,
        '',
        `Thanks for accepting your quote for ${eventName(q)}. Your date is secured. Here is your tax invoice ${ref}${pdf ? ' (also attached as a PDF)' : ''}.`,
        '',
        ...rows.map((r) => r[0] + ': ' + r[1]),
        '',
        `Pay by card or view your invoice: ${link}`,
        `Bank transfer: ${SELLER.bankName} - BSB ${SELLER.bankBsb} - Account ${SELLER.bankAcc} - Reference ${ref}`,
        '',
        'Please pay by the due dates to avoid late fees.',
        ...SIGN_OFF
    ].join('\n');
    return { subject: `Your tax invoice ${ref} from SoundzGood`, html, text };
}
async function sendInvoiceEmail(q, site, pdf) {
    const out = renderInvoice(q, site, pdf);
    const attachments = pdf ? [{ filename: (q.invoiceNumber || q.number) + '.pdf', content: pdf }] : [];
    return send(q, { kind: 'invoice', ...out, attachments });
}

/* ---- 2. money in: the receipt ---- */
function renderReceipt(q, site, r) {
    const ref = q.invoiceNumber || q.number;
    const d = dues(q);
    const rows = [
        ['Paid ' + prettyDay(r.day), money(r.cents)],
        ['Paid by', r.method === 'card' ? 'Card' : 'Bank transfer'],
        ['Invoice', ref],
        ['Total', money(d.total) + ' - paid so far ' + money(d.paid)]
    ];
    rows.push(
        d.owing > 0
            ? ['Left to pay', money(d.owing) + (d.balanceDay ? ', due ' + prettyDay(d.balanceDay) : '')]
            : ['Left to pay', 'Nothing - paid in full']
    );
    const html = wrap(
        'Payment received, thank you',
        `<p style="margin:0 0 16px;">Hi ${esc(who(q))},</p>
      <p style="margin:0 0 16px;">Thanks, we've received your payment for ${esc(eventName(q))}. This email is your receipt.</p>
      ${box(rows)}
      ${button(linkOf(site, q), 'View your invoice')}`
    );
    const text = [
        `Hi ${who(q)},`,
        '',
        `Thanks, we've received your payment for ${eventName(q)}. This email is your receipt.`,
        '',
        ...rows.map((x) => x[0] + ': ' + x[1]),
        '',
        `View your invoice: ${linkOf(site, q)}`,
        ...SIGN_OFF
    ].join('\n');
    return { subject: `Payment received - ${ref} - SoundzGood`, html, text };
}
/*  r = { cents, day, method } - this payment. */
const sendReceiptEmail = (q, site, r) => send(q, { kind: 'receipt', ...renderReceipt(q, site, r) });

/* ---- 3. the Tuesday after: how did we do? ---- */
function renderReview(q) {
    const html = wrap(
        'How did we do?',
        `<p style="margin:0 0 16px;">Hi ${esc(who(q))},</p>
      <p style="margin:0 0 20px;">Thanks for having us at ${esc(eventName(q))}. We hope it was a great one!</p>
      ${reviewHtml()}
      <p style="margin:0;font-size:14px;color:#555;">Anything we could do better? Just reply, Max reads every one.</p>`,
        false
    );
    const text = [
        `Hi ${who(q)},`,
        '',
        `Thanks for having us at ${eventName(q)}. We hope it was a great one!`,
        '',
        'If you were happy with us, a quick Google review really helps. It takes a minute:',
        REVIEW_URL,
        '',
        'Anything we could do better? Just reply, Max reads every one.',
        ...SIGN_OFF.slice(2)
    ].join('\n');
    return { subject: `How did we do at ${eventName(q)}?`, html, text };
}
const sendReviewEmail = (q) => send(q, { kind: 'review', ...renderReview(q) });

module.exports = {
    sendInvoiceEmail,
    sendReceiptEmail,
    sendReviewEmail,
    renderInvoice,
    renderReceipt,
    renderReview,
    todayISO,
    addDays
};
