/* ==========================================================================
   INVOICE PDF, MADE IN THE BROWSER (Max, 18 Nov 2026)

   No headless browser on the server: the page that has the invoice open
   (the customer's after they accept or pay, or the hidden copy admin opens
   when Max marks a job accepted) turns it into a PDF using the print
   stylesheet - the same pages as "Download / Print PDF" - and hands it to
   the server, which emails it with the invoice. If this fails, the server
   still sends the invoice email with the link only (invoiceEmailSweep).
   ========================================================================== */

const LIB = 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js';

function loadLib() {
    if (window.html2pdf) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = LIB;
        s.onload = resolve;
        s.onerror = () => reject(new Error('PDF tool did not load'));
        document.head.appendChild(s);
    });
}

/*  The print rules (quote-view-print.css) without the "@media print" wrapper
    and @page rules, so the copy being drawn looks like the printed pages. */
async function printRules() {
    const link = document.querySelector('link[href*="quote-view-print"]');
    if (!link) return '';
    const css = await (await fetch(link.href)).text();
    const rules = css
        .replace(/^[\s\S]*?@media print \{/, '')
        .replace(/\}\s*$/, '')
        .replace(/@page[^{]*\{[^}]*\}/g, '');
    // the print pages' 12mm side margins (the cover stays full bleed), and no
    // footer line or spare bottom space spilling onto a page of its own - the ABN is on page 2
    return (
        rules +
        '#quote-root > :not(.qp-hero) { padding-left: 12mm; padding-right: 12mm; box-sizing: border-box; } .qv-foot { display: none; } #quote-root, #quote-root > :last-child, .qv-doc, .qv-pay { margin-bottom: 0 !important; padding-bottom: 0 !important; } .qp-hero, .qp-invest { break-after: auto !important; }'
    );
}

/*  The invoice as a PDF (Blob). Runs in the hidden A4-wide copy only, so the
    print look goes straight onto this page - page breaks are then worked out
    on the same layout that gets drawn. */
async function invoicePdfBlob() {
    await loadLib();
    const st = document.createElement('style');
    st.textContent = await printRules();
    document.head.appendChild(st);
    document.querySelectorAll('.qp-term').forEach((d) => {
        d.open = true; // every booking term, like printing
    });
    return window
        .html2pdf()
        .set({
            margin: 0,
            image: { type: 'jpeg', quality: 0.88 },
            html2canvas: { scale: 1.6, useCORS: true, windowWidth: 794 }, // A4 width at 96 dpi
            jsPDF: { unit: 'mm', format: 'a4' },
            pagebreak: { mode: ['css', 'legacy'], avoid: ['tr', '.qv-pay'] } // never cut a row or the bank box in half
        })
        .from(document.getElementById('quote-root'))
        .outputPdf('blob');
}

const toBase64 = (blob) =>
    new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(',')[1] || '');
        r.onerror = reject;
        r.readAsDataURL(blob);
    });

/*  Make the PDF and hand it to the server (sendInvoicePdf). Quietly gives up
    on any error - the link-only email still goes. */
export async function sendInvoicePdf(send, token) {
    try {
        const pdf = await toBase64(await invoicePdfBlob());
        await send({ token, pdf });
        window.parent.postMessage({ sgInvoicePdf: 'sent' }, window.location.origin); // admin's hidden copy can close
    } catch (err) {
        window.parent.postMessage({ sgInvoicePdf: 'failed' }, window.location.origin);
    }
}
