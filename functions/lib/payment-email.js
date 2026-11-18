/* ==========================================================================
   INVOICE, RECEIPT AND REVIEW EMAILS (Max, 18 Nov 2026)

   Everything for a booking stays in the one workflow:
     invoiceEmail   the customer accepts their quote -> tax invoice PDF,
                    what's due and how to pay
     receiptEmail   money comes in (Stripe card, or Max marks it in admin)
                    -> "Payment received" + tax invoice / receipt PDF
     reviewEmail    the day after the event -> "How did we do?" + Google review
   The PDF lists what we're supplying and the totals; the itemised prices
   stay on the online invoice (same link as the quote).
   Never throws - each returns { sent } like the other mail.
   ========================================================================== */

const PDFDocument = require('pdfkit');
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
const stampDay = (t) => (t && t.toDate ? t.toDate().toLocaleDateString('en-CA', { timeZone: 'Australia/Brisbane' }) : todayISO());
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

/* ---- the PDF: tax invoice, or tax invoice / receipt ---- */
function pdfBuffer(build) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: 'A4', margin: 48 });
        const parts = [];
        doc.on('data', (c) => parts.push(c));
        doc.on('end', () => resolve(Buffer.concat(parts)));
        doc.on('error', reject);
        build(doc);
        doc.end();
    });
}

/*  opts.receipt = { cents, day, method } adds the "Paid" box. */
function invoicePdf(q, site, opts = {}) {
    const ref = q.invoiceNumber || q.number;
    const c = q.customer || {};
    const d = dues(q);
    return pdfBuffer((doc) => {
        const L = 48;
        const W = doc.page.width - 96;
        // letterhead
        doc.rect(0, 0, doc.page.width, 92).fill('#111111');
        doc.fillColor(ORANGE).font('Helvetica-Bold').fontSize(10).text('SOUNDZGOOD WHITSUNDAYS', L, 30, { characterSpacing: 2 });
        doc.fillColor('#ffffff')
            .fontSize(20)
            .text(opts.receipt ? 'Tax invoice / Receipt' : 'Tax invoice', L, 48);
        doc.fontSize(11).text(ref, L, 52, { width: W, align: 'right' });

        // seller and customer
        let y = 112;
        doc.fillColor('#111111').font('Helvetica-Bold').fontSize(9).text('FROM', L, y);
        doc.text('BILL TO', L + W / 2, y);
        doc.font('Helvetica').fontSize(10).fillColor('#333333');
        const from = [
            SELLER.legal || SELLER.name,
            SELLER.abn ? 'ABN ' + SELLER.abn : '',
            '34a Williams St, Bowen QLD 4805',
            SELLER.email,
            SELLER.site
        ].filter(Boolean);
        const to = [c.name, c.email, c.phone, c.address].filter(Boolean);
        doc.text(from.join('\n'), L, y + 14, { width: W / 2 - 12 });
        const yFrom = doc.y;
        doc.text(to.join('\n'), L + W / 2, y + 14, { width: W / 2 });
        y = Math.max(yFrom, doc.y) + 16;

        // invoice facts
        const facts = [
            ['Invoice', ref],
            ['Issued', prettyDay(stampDay(q.invoicedAt))],
            ['Event', eventName(q)],
            [
                'Event date',
                prettyDay(q.hire && q.hire.startDate) +
                    (q.hire && q.hire.endDate && q.hire.endDate !== q.hire.startDate ? ' - ' + prettyDay(q.hire.endDate) : '')
            ],
            ['Venue', c.eventVenue || '']
        ].filter((f) => f[1]);
        doc.rect(L, y, W, facts.length * 16 + 14).fill('#f7f7f8');
        facts.forEach((f, i) => {
            doc.fillColor('#777777')
                .font('Helvetica')
                .fontSize(9)
                .text(f[0], L + 12, y + 9 + i * 16);
            doc.fillColor('#111111')
                .font('Helvetica-Bold')
                .fontSize(10)
                .text(f[1], L + 100, y + 8 + i * 16, { width: W - 112, lineBreak: false, ellipsis: true });
        });
        y += facts.length * 16 + 30;

        // what we're supplying
        doc.fillColor('#111111').font('Helvetica-Bold').fontSize(11).text("What we're supplying", L, y);
        y = doc.y + 6;
        doc.font('Helvetica').fontSize(9.5).fillColor('#333333');
        (q.lines || [])
            .filter((l) => l && l.type !== 'discount' && String(l.name || '').trim())
            .forEach((l) => {
                if (y > doc.page.height - 120) {
                    doc.addPage();
                    y = 48;
                }
                const qty = Number(l.qty) || 0;
                doc.text(qty ? String(qty) + ' x' : '', L, y, { width: 40 });
                doc.text(String(l.name).trim(), L + 44, y, { width: W - 44 });
                y = doc.y + 3;
            });
        doc.fillColor('#777777')
            .fontSize(8.5)
            .text('Itemised prices are on your online invoice: ' + linkOf(site, q), L, y + 4, { width: W });
        y = doc.y + 16;

        // totals
        if (y > doc.page.height - 260) {
            doc.addPage();
            y = 48;
        }
        const row = (label, value, bold) => {
            doc.fillColor('#111111')
                .font(bold ? 'Helvetica-Bold' : 'Helvetica')
                .fontSize(bold ? 11 : 10);
            doc.text(label, L + W / 2, y, { width: W / 4 });
            doc.text(value, L + (3 * W) / 4, y, { width: W / 4, align: 'right' });
            y += bold ? 18 : 15;
        };
        row('Subtotal (ex GST)', money(Math.round(q.totalCents || 0) - Math.round(q.gstCents || 0)));
        row('GST (10%)', money(q.gstCents));
        if (q.lateFeeCents) row('Late payment charges', money(q.lateFeeCents));
        row('Total (incl GST)', money(d.total), true);
        row('Paid to date', money(d.paid));
        row('Balance owing', money(d.owing), true);
        y += 10;

        // paid box (receipt)
        if (opts.receipt) {
            doc.rect(L, y, W, 40).fill('#e7f6ee');
            doc.fillColor('#15803d')
                .font('Helvetica-Bold')
                .fontSize(12)
                .text('PAID ' + money(opts.receipt.cents), L + 14, y + 8);
            doc.font('Helvetica')
                .fontSize(9.5)
                .text(
                    prettyDay(opts.receipt.day) + ' - ' + (opts.receipt.method === 'card' ? 'card payment' : 'bank transfer'),
                    L + 14,
                    y + 24
                );
            y += 54;
        }

        // how to pay
        if (d.owing > 0) {
            doc.fillColor('#111111').font('Helvetica-Bold').fontSize(11).text('How to pay', L, y);
            doc.font('Helvetica').fontSize(10).fillColor('#333333');
            const due = [d.nowLabel + ': ' + money(d.nowCents)];
            if (d.balanceCents > 0) due.push('Balance ' + money(d.balanceCents) + ', due ' + prettyDay(d.balanceDay));
            doc.text(due.join('\n'), L, doc.y + 4, { width: W });
            doc.text(
                'Card: pay online at ' +
                    linkOf(site, q) +
                    '\nBank transfer: ' +
                    SELLER.bankName +
                    ' - BSB ' +
                    SELLER.bankBsb +
                    ' - Account ' +
                    SELLER.bankAcc +
                    ' - Reference ' +
                    ref,
                L,
                doc.y + 6,
                { width: W }
            );
            doc.fillColor('#777777')
                .fontSize(8.5)
                .text('Please pay by the due dates to avoid late fees (see Terms & Conditions).', L, doc.y + 6, { width: W });
        }
    });
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
        await tx.sendMail({
            from: `${SELLER.name} <${SELLER.email}>`,
            to,
            ...(cc.length ? { cc: cc.join(', ') } : {}),
            bcc: OFFICE,
            replyTo: OFFICE,
            ...mail
        });
        return { sent: true };
    } catch (err) {
        logger.error(mail.kind + ' email failed', { to, smtpError: err && err.message });
        return { sent: false, reason: 'smtp-error', error: err && err.message };
    }
}

/* ---- 1. accepted: the tax invoice ---- */
function renderInvoice(q, site) {
    const ref = q.invoiceNumber || q.number;
    const d = dues(q);
    const link = linkOf(site, q);
    const rows = [[d.nowLabel, money(d.nowCents)]];
    if (d.balanceCents > 0) rows.push(['Balance ' + money(d.balanceCents), 'due ' + prettyDay(d.balanceDay)]);
    const html = wrap(
        'Your tax invoice',
        `<p style="margin:0 0 16px;">Hi ${esc(who(q))},</p>
      <p style="margin:0 0 16px;">Thanks for accepting your quote for ${esc(eventName(q))}. Your date is secured. Your tax invoice ${esc(ref)} is attached.</p>
      ${box(rows)}
      ${button(link, 'Pay by card or view your invoice')}
      ${bankHtml(ref)}
      <p style="margin:0;font-size:14px;color:#555;">Please pay by the due dates to avoid late fees.</p>`
    );
    const text = [
        `Hi ${who(q)},`,
        '',
        `Thanks for accepting your quote for ${eventName(q)}. Your date is secured. Your tax invoice ${ref} is attached.`,
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
async function sendInvoiceEmail(q, site) {
    const out = renderInvoice(q, site);
    const pdf = await invoicePdf(q, site);
    return send(q, { kind: 'invoice', ...out, attachments: [{ filename: (q.invoiceNumber || q.number) + '.pdf', content: pdf }] });
}

/* ---- 2. money in: the receipt ---- */
function renderReceipt(q, site, r) {
    const ref = q.invoiceNumber || q.number;
    const d = dues(q);
    const over = isoDay((q.hire && (q.hire.endDate || q.hire.startDate)) || '') < todayISO() && !!isoDay(q.hire && q.hire.startDate);
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
      <p style="margin:0 0 16px;">Thanks, we've received your payment for ${esc(eventName(q))}. Your receipt is attached.</p>
      ${box(rows)}
      ${button(linkOf(site, q), 'View your invoice')}
      ${over ? reviewHtml() : ''}`
    );
    const text = [
        `Hi ${who(q)},`,
        '',
        `Thanks, we've received your payment for ${eventName(q)}. Your receipt is attached.`,
        '',
        ...rows.map((x) => x[0] + ': ' + x[1]),
        '',
        `View your invoice: ${linkOf(site, q)}`,
        ...(over ? ['', 'How did we do? If you were happy with us, a quick Google review really helps: ' + REVIEW_URL] : []),
        ...SIGN_OFF
    ].join('\n');
    return { subject: `Payment received - ${ref} - SoundzGood`, html, text };
}
/*  r = { cents, day, method } - this payment. */
async function sendReceiptEmail(q, site, r) {
    const out = renderReceipt(q, site, r);
    const pdf = await invoicePdf(q, site, { receipt: r });
    return send(q, {
        kind: 'receipt',
        ...out,
        attachments: [{ filename: 'Receipt ' + (q.invoiceNumber || q.number) + '.pdf', content: pdf }]
    });
}

/* ---- 3. the day after: how did we do? ---- */
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
    invoicePdf,
    todayISO,
    addDays
};
