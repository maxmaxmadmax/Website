/* ==========================================================================
   BOOKING EMAILS

   Two go out the moment a booking is confirmed: a tax invoice to the
   vendor, and a copy to the office so somebody knows without opening the
   admin.

   WHY IT IS A TAX INVOICE AND NOT JUST A RECEIPT
   SoundzGood charges GST, and for a sale over $82.50 including GST the
   buyer is entitled to a tax invoice on request. A food site comes to
   $115.49, so most bookings clear that. A compliant one has to carry the
   words "Tax invoice", the seller and their ABN, the date, what was sold,
   and the GST shown on its own. All of that is below, so the confirmation
   is the invoice and nobody has to ask for one later.

   SENDING IS NEVER ALLOWED TO BREAK A BOOKING
   These are called after the booking is already confirmed and the money is
   already taken. If the mail server is down, that is a nuisance; losing
   the booking would be a disaster. So every failure here is caught and
   logged, never thrown.
   ========================================================================== */

const nodemailer = require('nodemailer');
const logger = require('firebase-functions/logger');

/*  Who the invoice is from. The ABN is a legal requirement on a tax
    invoice - without it the document does not count as one and a vendor
    cannot claim the GST back. */
const SELLER = {
  name: 'SoundzGood Whitsundays',
  abn: process.env.SG_ABN || '',
  email: process.env.SG_FROM_EMAIL || 'bookings@soundzgood.com.au',
  site: 'www.soundzgood.com.au',
};

const OFFICE_COPY = process.env.SG_OFFICE_EMAIL || 'info@soundzgood.com.au';

function transport() {
  const user = (process.env.SMTP_USER || '').trim();

  /*  Google shows an app password as four groups of four - "abcd efgh ijkl
      mnop" - and that is what lands on the clipboard. SMTP wants the
      sixteen characters on their own, so strip the spaces here rather
      than relying on whoever stored the secret to have done it. */
  const pass = (process.env.SMTP_PASS || '').replace(/\s+/g, '');

  if (!user || !pass) return null;

  /*  Google Workspace SMTP. Port 465 with TLS from the start rather than
      587 with STARTTLS - one less thing to negotiate, and Cloud Functions
      egress is happier with it. */
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user, pass },
  });
}

const money = (cents) => '$' + ((cents || 0) / 100).toFixed(2);

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/*  The figures. Older bookings predate the fee, so fall back to the site
    price rather than printing blanks on somebody's invoice. */
function figures(booking) {
  const site = booking.amountCents || 0;
  const fee = booking.bookingFeeCents != null ? booking.bookingFeeCents : 0;
  const gst = booking.gstCents != null ? booking.gstCents : 0;
  const total = booking.totalCents != null ? booking.totalCents : site + fee + gst;
  return { site, fee, gst, total, subtotal: site + fee };
}

function vendorSubject(booking, event) {
  return `You're in - ${event.name || 'the event'}, site ${booking.siteLabel || ''}`.trim();
}

/* -------------------------------------------------------------------------
   The vendor's copy: confirmation and tax invoice in one
   ------------------------------------------------------------------------- */
function vendorHtml(booking, bookingId, event) {
  const f = figures(booking);
  const biz = booking.business || {};
  const when = event.dateLabel || event.dateISO || '';
  const where = [event.venue, event.location].filter(Boolean).join(', ');

  const row = (label, value, strong) => `
    <tr>
      <td style="padding:8px 0;color:#555;font-size:14px;">${esc(label)}</td>
      <td style="padding:8px 0;text-align:right;font-size:14px;${
        strong ? 'font-weight:bold;color:#111;' : 'color:#111;'}">${esc(value)}</td>
    </tr>`;

  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:600px;margin:auto;background:#fff;border-radius:10px;overflow:hidden;">

    <div style="background:#111;padding:24px;">
      <p style="margin:0;color:#ff6b00;font-size:12px;letter-spacing:2px;text-transform:uppercase;">SoundzGood Whitsundays</p>
      <h1 style="margin:6px 0 0;color:#fff;font-size:22px;">You're booked in</h1>
    </div>

    <div style="padding:24px;">
      <p style="margin:0 0 16px;font-size:15px;color:#111;">
        Thanks ${esc(biz.contactName || biz.name || 'there')} - your site at
        <strong>${esc(event.name || 'the event')}</strong> is confirmed and paid.
      </p>

      <table style="width:100%;border-collapse:collapse;margin:0 0 20px;">
        ${row('Reference', booking.reference || bookingId, true)}
        ${row('Business', biz.name || '')}
        ${row('Site', booking.siteLabel || '')}
        ${booking.categoryName ? row('Category', booking.categoryName) : ''}
        ${when ? row('When', when) : ''}
        ${where ? row('Where', where) : ''}
      </table>

      <h2 style="margin:0 0 4px;font-size:16px;color:#111;">Tax invoice</h2>
      <p style="margin:0 0 12px;font-size:12px;color:#666;">
        ${esc(SELLER.name)}${SELLER.abn ? ' &middot; ABN ' + esc(SELLER.abn) : ''}<br>
        Issued ${esc(new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' }))}
      </p>

      <table style="width:100%;border-collapse:collapse;border-top:1px solid #e5e5e5;">
        ${row('Site fee', money(f.site))}
        ${row('Booking fee', money(f.fee))}
        ${row('Subtotal', money(f.subtotal))}
        ${row('GST (10%)', money(f.gst))}
      </table>
      <table style="width:100%;border-collapse:collapse;border-top:2px solid #111;margin-top:4px;">
        ${row('Total paid (incl GST)', money(f.total), true)}
      </table>

      <p style="margin:22px 0 0;font-size:14px;color:#111;"><strong>What happens next</strong></p>
      <p style="margin:6px 0 0;font-size:14px;color:#444;line-height:1.6;">
        Keep this email - the reference above identifies your booking. We'll be
        in touch closer to the day with bump-in times and where to enter.
        If anything changes, reply to this email.
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

function vendorText(booking, bookingId, event) {
  const f = figures(booking);
  const biz = booking.business || {};
  return [
    `You're booked in - ${event.name || 'the event'}`,
    '',
    `Reference: ${booking.reference || bookingId}`,
    `Business:  ${biz.name || ''}`,
    `Site:      ${booking.siteLabel || ''}`,
    event.dateLabel ? `When:      ${event.dateLabel}` : '',
    [event.venue, event.location].filter(Boolean).length
      ? `Where:     ${[event.venue, event.location].filter(Boolean).join(', ')}` : '',
    '',
    'TAX INVOICE',
    `${SELLER.name}${SELLER.abn ? ' - ABN ' + SELLER.abn : ''}`,
    '',
    `Site fee              ${money(f.site)}`,
    `Booking fee           ${money(f.fee)}`,
    `Subtotal              ${money(f.subtotal)}`,
    `GST (10%)             ${money(f.gst)}`,
    `Total paid (incl GST) ${money(f.total)}`,
    '',
    "Keep this email - the reference identifies your booking. We'll be in touch",
    'closer to the day with bump-in times. Reply here if anything changes.',
    '',
    `${SELLER.name} - ${SELLER.email} - ${SELLER.site}`,
  ].filter((l) => l !== '').join('\n');
}

/* -------------------------------------------------------------------------
   The office copy: what an admin needs at a glance
   ------------------------------------------------------------------------- */
function officeHtml(booking, bookingId, event) {
  const f = figures(booking);
  const biz = booking.business || {};

  const row = (k, v) => `
    <tr><td style="padding:6px 12px 6px 0;color:#666;font-size:13px;">${esc(k)}</td>
        <td style="padding:6px 0;font-size:13px;color:#111;">${esc(v)}</td></tr>`;

  return `<!doctype html>
<html><body style="margin:0;padding:20px;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:560px;margin:auto;background:#fff;border-radius:8px;padding:20px;">
    <h2 style="margin:0 0 4px;font-size:17px;color:#111;">New vendor confirmed</h2>
    <p style="margin:0 0 16px;font-size:13px;color:#666;">${esc(event.name || '')}</p>

    <table style="width:100%;border-collapse:collapse;">
      ${row('Business', biz.name || '')}
      ${row('Contact', biz.contactName || '')}
      ${row('Email', biz.email || '')}
      ${row('Phone', biz.phone || '')}
      ${row('Type', booking.vendorType || '')}
      ${row('Category', booking.categoryName || '')}
      ${row('Site', booking.siteLabel || '')}
      ${row('Paid', money(f.total) + '  (GST ' + money(f.gst) + ')')}
      ${row('Reference', booking.reference || bookingId)}
      ${row('Documents', (booking.documents || []).length + ' attached')}
    </table>

    <p style="margin:18px 0 0;font-size:13px;">
      <a href="https://www.soundzgood.com.au/admin#/vendors"
         style="color:#ff6b00;">Open it in the admin</a>
    </p>
  </div>
</body></html>`;
}

/* -------------------------------------------------------------------------
   Send both. Never throws.
   ------------------------------------------------------------------------- */
async function sendBookingEmails(booking, bookingId, event) {
  const tx = transport();

  if (!tx) {
    logger.warn('booking confirmed but SMTP is not configured, no email sent', { bookingId });
    return { sent: false, reason: 'no-smtp' };
  }

  const from = `${SELLER.name} <${SELLER.email}>`;
  const to = (booking.business || {}).email;
  /*  Failures are collected as well as logged. Cloud Logging can run a
      couple of minutes behind, which is a long time to wait to find out
      why an invoice did not go, and the caller may want to say. */
  const results = { vendor: false, office: false, errors: [] };

  if (to) {
    try {
      await tx.sendMail({
        from,
        to,
        replyTo: OFFICE_COPY,
        subject: vendorSubject(booking, event),
        text: vendorText(booking, bookingId, event),
        html: vendorHtml(booking, bookingId, event),
      });
      results.vendor = true;
    } catch (err) {
      logger.error('vendor confirmation email failed', {
        bookingId,
        to,
        /*  Not 'message' - the logger uses that key for the log line itself,
            so the SMTP error was being overwritten by our own text. */
        smtpError: err && err.message,
        smtpCode: err && (err.code || err.responseCode),
        smtpResponse: err && err.response,
      });
      results.errors.push('vendor: ' + (err && err.message));
    }
  } else {
    logger.warn('booking has no email address, cannot send confirmation', { bookingId });
  }

  try {
    await tx.sendMail({
      from,
      to: OFFICE_COPY,
      replyTo: to || OFFICE_COPY,
      subject: `New vendor: ${(booking.business || {}).name || 'unnamed'} - ${booking.siteLabel || ''}`,
      html: officeHtml(booking, bookingId, event),
    });
    results.office = true;
  } catch (err) {
    logger.error('office copy email failed', {
      bookingId,
      smtpError: err && err.message,
      smtpCode: err && (err.code || err.responseCode),
      smtpResponse: err && err.response,
    });
    results.errors.push('office: ' + (err && err.message));
  }

  return { sent: results.vendor || results.office, ...results };
}

module.exports = { sendBookingEmails };
