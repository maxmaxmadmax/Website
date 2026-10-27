/* ==========================================================================
   EMAIL LOG

   Every email the system sends - quotes, invoices, vendor invoices, the
   bot's estimate, lead emails, Messages, office copies - is written to the
   emailLog collection (who, subject, the exact HTML, sent or failed), so the
   admin Messages page can show "Sent emails" with a preview of each one.

   How: nodemailer.createTransport is wrapped once, here, so every mail file
   is covered without changing how it sends. A sendMail call may pass
   kind: 'quote' etc. to label it; that option is taken off before sending.
   Logging can never stop an email: any logging error is swallowed.

   Required once at the top of functions/index.js.
   ========================================================================== */

const nodemailer = require('nodemailer');
const logger = require('firebase-functions/logger');

const realCreate = nodemailer.createTransport.bind(nodemailer);

async function writeLog(entry) {
  try {
    const { getFirestore, FieldValue } = require('firebase-admin/firestore');
    await getFirestore().collection('emailLog').add({ ...entry, at: FieldValue.serverTimestamp() });
  } catch (err) {
    logger.warn('email log write failed', { message: err && err.message });
  }
}

const list = (v) => (Array.isArray(v) ? v.join(', ') : String(v || ''));

nodemailer.createTransport = function (...args) {
  const tx = realCreate(...args);
  const send = tx.sendMail.bind(tx);
  tx.sendMail = async function (opts = {}) {
    const { kind, ...mail } = opts;
    const entry = {
      kind: String(kind || 'email'),
      to: list(mail.to),
      cc: list(mail.cc),
      bcc: list(mail.bcc),
      subject: String(mail.subject || '').slice(0, 300),
      html: String(mail.html || '').slice(0, 300000),
      text: mail.html ? '' : String(mail.text || '').slice(0, 20000),
      test: /^\[TEST\]/.test(String(mail.subject || '')),
    };
    try {
      const r = await send(mail);
      await writeLog({ ...entry, ok: true, error: '' });
      return r;
    } catch (err) {
      await writeLog({ ...entry, ok: false, error: String((err && err.message) || err).slice(0, 500) });
      throw err;
    }
  };
  return tx;
};

module.exports = {};
