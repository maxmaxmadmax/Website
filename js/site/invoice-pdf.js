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
    // footer line or spare bottom space spilling onto a page of its own - the ABN is on page 2.
    // No Terms & Conditions in the PDF (Max, 18 Nov 2026) - they stay on the online page.
    return (
        rules +
        '#quote-root > :not(.qp-hero) { padding-left: 12mm; padding-right: 12mm; box-sizing: border-box; } .qv-foot, .qp-terms { display: none !important; } #quote-root, #quote-root > :last-child, .qv-doc, .qv-pay { margin-bottom: 0 !important; padding-bottom: 0 !important; } .qp-hero, .qp-invest { break-after: auto !important; } html, body { overflow: hidden !important; }'
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
    // every photo fully loaded first (the cover photo comes from Firebase Storage,
    // which allows soundzgood.com.au to copy it - bucket CORS, 18 Nov 2026)
    await Promise.all(
        [...document.querySelectorAll('#quote-root img')].map((img) =>
            img.complete
                ? null
                : new Promise((done) => {
                      img.addEventListener('load', done, { once: true });
                      img.addEventListener('error', done, { once: true });
                  })
        )
    );
    layoutPages();
    const worker = window
        .html2pdf()
        .set({
            margin: 0,
            image: { type: 'jpeg', quality: 0.88 },
            html2canvas: { scale: 1.6, useCORS: true, windowWidth: 794 }, // A4 width at 96 dpi
            jsPDF: { unit: 'mm', format: 'a4' },
            pagebreak: { mode: ['css'] } // the itemised pages are laid out by layoutPages()
        })
        .from(document.getElementById('quote-root'))
        .toPdf();
    const pdf = await worker.get('pdf');
    dropBlankEnd(pdf, await worker.get('canvas'));
    return pdf.output('blob');
}

/*  THE ITEMISED PAGES (Max, 18 Nov 2026). The itemised invoice starts on a new
    page; from there, in A4-tall slices:
      - no item row is cut between two pages (it moves to the next page, with
        a top margin like the printed pages), and
      - the totals and payment details always sit at the BOTTOM of the last page
        (moved onto a new page if they don't fit under the items).        */
const PAGE_H = (794 * 297) / 210; // one A4 page at 794px wide
const EDGE = 45; // ~12mm top / bottom margin

function layoutPages() {
    const doc = document.getElementById('qv-doc');
    if (!doc) return;
    // the PDF page starts where the doc's padding ends (its top padding is drawn off the page)
    const top = () => doc.getBoundingClientRect().top + parseFloat(getComputedStyle(doc).paddingTop);
    const pageOf = (y) => Math.floor(y / PAGE_H);

    // 1. rows: never across a page edge
    doc.querySelectorAll('.qv-table tbody tr').forEach((tr) => {
        const r = tr.getBoundingClientRect();
        const y0 = r.top - top();
        const limit = (pageOf(y0) + 1) * PAGE_H - EDGE;
        if (y0 + r.height <= limit || r.height > PAGE_H - 2 * EDGE) return;
        const gap = document.createElement('tr');
        gap.className = 'qv-pdf-gap';
        gap.innerHTML =
            '<td colspan="5" style="height:' +
            Math.ceil((pageOf(y0) + 1) * PAGE_H + EDGE - y0) +
            'px;padding:0;border:0;background:#fff"></td>';
        tr.before(gap);
    });

    // 2. totals + payment details: pinned to the bottom of the last page
    const group = doc.querySelector('.qv-sumwrap');
    const kids = [...doc.children].filter((k) => getComputedStyle(k).display !== 'none' && k.getBoundingClientRect().height > 0);
    const last = kids[kids.length - 1];
    if (!group || !last) return;
    const g0 = group.getBoundingClientRect().top - top();
    const g1 = last.getBoundingClientRect().bottom - top();
    const height = g1 - g0;
    let end = (pageOf(g0) + 1) * PAGE_H - EDGE; // bottom of the page the totals start on
    if (g0 + height > end) end += PAGE_H; // doesn't fit under the items: bottom of the next page
    const push = end - g1;
    if (push > 0) group.style.marginTop = parseFloat(getComputedStyle(group).marginTop) + push + 'px';
}

/*  Leftover space at the bottom can make an empty last page - drop any blank
    pages off the end (each page is one A4-tall slice of the drawn canvas). */
function dropBlankEnd(pdf, canvas) {
    const pageH = Math.round((canvas.width * 297) / 210);
    const ctx = canvas.getContext('2d');
    const blank = (top) => {
        const h = Math.min(pageH, canvas.height - top);
        if (h <= 0) return true;
        const px = ctx.getImageData(0, top, canvas.width, h).data;
        for (let i = 0; i < px.length; i += 4 * 16) if (px[i] < 245 || px[i + 1] < 245 || px[i + 2] < 245) return false;
        return true;
    };
    while (pdf.getNumberOfPages() > 1 && blank((pdf.getNumberOfPages() - 1) * pageH)) pdf.deletePage(pdf.getNumberOfPages());
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
