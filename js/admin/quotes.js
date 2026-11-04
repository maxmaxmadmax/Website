/* SOUNDZGOOD ADMIN - quotes.js
   Quotes & invoices: the builder, labour rates and the sales pipeline.
   A plain script: every admin file shares one page scope, loaded in order by admin.html. */
'use strict';

/* =========================================================================
   QUOTES & INVOICES  -  the admin builder

   List of quotes, and a builder for one: customer, hire dates, line items
   (from inventory with the kit engine auto-adding required gear, plus custom
   lines and discounts), live totals (ex-GST, +10% GST), and the actions to
   save, email the link, accept, invoice and mark paid.
   ========================================================================= */

/*  EVENT TYPE - picks the photo at the top of the
    customer's quote page (the Services page photos). Guessed from the
    event name until it's set by hand.                                    */
const EVENT_TYPES = {
    community: 'Community event',
    corporate: 'Corporate function',
    festival: 'Festival / concert',
    wedding: 'Wedding',
    private: 'Private party',
    sporting: 'Sporting event',
    touring: 'Touring band / gig',
    dj: 'DJ / Entertainment' // pub nights + DJ gigs
};
function guessEventType(name) {
    const n = String(name || '').toLowerCase();
    if (/\bdj\b|entertainment/.test(n)) return 'dj';
    if (/wedding|bride|ceremony|reception/.test(n)) return 'wedding';
    if (/corporate|conference|awards|gala|dinner|launch|expo|ball/.test(n)) return 'corporate';
    if (/festival|concert|music|fest\b/.test(n)) return 'festival';
    if (/race|rodeo|cup|footy|football|rugby|cricket|fishing|sport|triathlon|carnival/.test(n)) return 'sporting';
    if (/birthday|party|engagement|anniversary|wake/.test(n)) return 'private';
    if (/tour|band|gig/.test(n)) return 'touring';
    return 'community';
}

function blankQuote() {
    return {
        kind: 'quote',
        customer: {
            name: '',
            business: '',
            email: '',
            ccEmail: '',
            gearEmails: '',
            phone: '',
            address: '',
            eventName: '',
            eventDate: '',
            eventVenue: '',
            soundcheckTime: '',
            eventStartTime: '',
            eventEndTime: '',
            customerNotes: '',
            dayContact: '',
            eventType: ''
        },
        hire: { startDate: '', endDate: '', days: 1 },
        lines: [],
        discountCents: 0,
        labourExcluded: false, // setup & pack-down labour is on by default (delivered jobs)
        labourPH: { setup: false, pack: false }, // "public holiday" ticks for setup / pack-down day
        labourOff: { setup: false, pack: false }, // untick setup or pack-down on its own
        labourPackDate: '', // pack-down on a different day from the last hire day
        feeExcluded: false, // 2% booking & admin fee is on by default
        deliveryTown: '', // '' = pickup / no delivery
        deliveryKm: 0, // one-way road km from Bowen
        notes: '',
        terms: ''
    };
}

/*  Delivery: a town -> one-way km lookup from the Bowen base. The charge is
    $0.80/km RETURN, so delivery = km x 2 x $0.80. No base fee. "Other" lets
    staff type a km for anywhere not listed. Edit distances here for now.    */
const DELIVERY_RATE_PER_KM_CENTS = 80; // $0.80 per km travelled
const DELIVERY_ZONES = [
    { town: 'Bowen (local)', km: 0 },
    { town: 'Merinda', km: 12 },
    { town: 'Guthalungra', km: 38 },
    { town: 'Proserpine', km: 64 },
    { town: 'Home Hill', km: 79 },
    { town: 'Cannonvale', km: 84 },
    { town: 'Cape Gloucester Resort', km: 85 }, // by road
    { town: 'Collinsville', km: 86 },
    { town: 'Scottville', km: 88 },
    { town: 'Airlie Beach', km: 88 },
    { town: 'Jubilee Pocket', km: 90 },
    { town: 'Ayr', km: 91 },
    { town: 'Bloomsbury', km: 95 },
    { town: 'Shute Harbour', km: 98 },
    { town: 'Brandon', km: 98 },
    { town: 'Giru', km: 130 },
    { town: 'Glenden', km: 150 },
    { town: 'Mackay', km: 189 },
    { town: 'Townsville', km: 200 },
    { town: 'Charters Towers', km: 245 },
    { town: 'Moranbah', km: 300 },
    { town: 'Clermont', km: 400 },
    { town: 'Hughenden', km: 450 },
    { town: 'Emerald', km: 500 },
    { town: 'Richmond', km: 560 },
    { town: 'Winton', km: 660 },
    { town: 'Julia Creek', km: 670 },
    { town: 'Cloncurry', km: 780 },
    { town: 'Longreach', km: 810 },
    { town: 'Mount Isa', km: 900 },
    { town: 'Barcaldine', km: 900 }
];

function quoteDeliveryCents(d) {
    const km = Math.max(0, Math.round(d.deliveryKm || 0));
    return km * 2 * DELIVERY_RATE_PER_KM_CENTS; // return trip
}

/* =========================================================================
   LABOUR RATES - KEEP IN STEP with functions/lib/labour.js
   $80/hr. Saturday x1.25, Sunday x1.5, public holiday x1.5. Setup is charged
   on the first hire day, pack-down (50% of setup) on the last, each at its
   own day's rate; each part minimum 1 hr, then up to the half hour.
   Setup time is the man-minute figure on each inventory item.
   ========================================================================= */
const LABOUR_RATE_CENTS = 8000; // $80 / hour
const PACKDOWN_PCT = 0.5; // pack-down = 50% of setup time
const LOADING = { saturday: 1.25, sunday: 1.5, holiday: 1.5 };

const QLD_PUBLIC_HOLIDAYS = {
    '2026-01-01': "New Year's Day",
    '2026-01-26': 'Australia Day',
    '2026-04-03': 'Good Friday',
    '2026-04-04': 'Easter Saturday',
    '2026-04-05': 'Easter Sunday',
    '2026-04-06': 'Easter Monday',
    '2026-04-25': 'Anzac Day',
    '2026-05-04': 'Labour Day',
    '2026-10-05': "King's Birthday",
    '2026-12-25': 'Christmas Day',
    '2026-12-26': 'Boxing Day',
    '2026-12-28': 'Boxing Day (additional)',
    '2027-01-01': "New Year's Day",
    '2027-01-26': 'Australia Day',
    '2027-03-26': 'Good Friday',
    '2027-03-27': 'Easter Saturday',
    '2027-03-28': 'Easter Sunday',
    '2027-03-29': 'Easter Monday',
    '2027-04-26': 'Anzac Day',
    '2027-05-03': 'Labour Day',
    '2027-10-04': "King's Birthday",
    '2027-12-25': 'Christmas Day',
    '2027-12-27': 'Christmas Day (additional)',
    '2027-12-26': 'Boxing Day',
    '2027-12-28': 'Boxing Day (additional)',
    '2028-01-01': "New Year's Day",
    '2028-01-03': "New Year's Day (additional)",
    '2028-01-26': 'Australia Day',
    '2028-04-14': 'Good Friday',
    '2028-04-15': 'Easter Saturday',
    '2028-04-16': 'Easter Sunday',
    '2028-04-17': 'Easter Monday',
    '2028-04-25': 'Anzac Day',
    '2028-05-01': 'Labour Day',
    '2028-10-02': "King's Birthday",
    '2028-12-25': 'Christmas Day',
    '2028-12-26': 'Boxing Day'
};

/*  Local show holidays - only in their own district. home: true = also
    applies to pickup / no-delivery jobs (we're in Bowen).               */
const SHOW_HOLIDAYS = [
    { date: '2026-06-19', name: 'Whitsunday Show holiday', towns: ['proserpine', 'airlie', 'cannonvale'] },
    { date: '2026-06-23', name: 'Bowen Show holiday', towns: ['bowen', 'guthalungra', 'gumlu', 'bogie'], home: true },
    { date: '2026-11-03', name: 'Collinsville Show holiday', towns: ['collinsville'] }
];

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function isoOk(iso) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''));
}

/*  { mult, label } for one day. forceHoliday = the "public holiday" tick. */
function labourDayRate(iso, town, forceHoliday) {
    if (forceHoliday) return { mult: LOADING.holiday, label: 'public holiday surcharge' };
    if (!isoOk(iso)) return { mult: 1, label: '' };
    if (QLD_PUBLIC_HOLIDAYS[iso]) return { mult: LOADING.holiday, label: 'public holiday surcharge (' + QLD_PUBLIC_HOLIDAYS[iso] + ')' };
    const t = String(town || '').toLowerCase();
    const show = SHOW_HOLIDAYS.find((s) => s.date === iso && (t ? s.towns.some((w) => t.includes(w)) : s.home));
    if (show) return { mult: LOADING.holiday, label: 'public holiday surcharge (' + show.name + ')' };
    const [y, m, d] = iso.split('-').map(Number);
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    if (dow === 0) return { mult: LOADING.sunday, label: 'Sunday weekend surcharge' };
    if (dow === 6) return { mult: LOADING.saturday, label: 'Saturday weekend surcharge' };
    return { mult: 1, label: '' };
}

/*  Minimum 1 hour, then up to the next half hour. */
function labourHours(mins) {
    if (!mins || mins <= 0) return 0;
    if (mins <= 60) return 1;
    return Math.ceil(mins / 30) / 2;
}

function shortDate(iso) {
    if (!isoOk(iso)) return '';
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1];
    return DAY_NAMES[dt.getUTCDay()].slice(0, 3) + ' ' + d + ' ' + mon;
}

/*  The two parts for a job. setupMins = total setup man-minutes.
    opts: { startDate, endDate, town, holidaySetup, holidayPack }       */
function labourParts(setupMins, opts) {
    const o = opts || {};
    const setup = Math.max(0, Math.round(setupMins || 0));
    if (!setup) return [];
    const pack = Math.round(setup * PACKDOWN_PCT);
    const start = o.startDate || '';
    const end = o.endDate || o.startDate || '';
    return [
        { key: 'setup', name: 'Setup', date: start, mins: setup, force: !!o.holidaySetup },
        { key: 'pack', name: 'Pack-down', date: end, mins: pack, force: !!o.holidayPack }
    ]
        .filter((p) => p.mins > 0)
        .map((p) => {
            const hours = labourHours(p.mins);
            const rate = labourDayRate(p.date, o.town, p.force);
            const cents = Math.round(hours * LABOUR_RATE_CENTS * rate.mult);
            const hrs = hours + ' hr' + (hours === 1 ? '' : 's');
            const loading = rate.mult === 1 ? '' : ' + ' + Math.round((rate.mult - 1) * 100) + '% ' + rate.label;
            return {
                ...p,
                hours,
                mult: rate.mult,
                rateLabel: rate.label,
                cents,
                // what the client reads, e.g. "Setup - Sat 31 Oct" / "3 hrs @ $80/hr + 25% Saturday weekend surcharge"
                lineName: p.name + (shortDate(p.date) ? ' – ' + shortDate(p.date) : ''),
                lineDesc: `${hrs} @ $${LABOUR_RATE_CENTS / 100}/hr${loading}` // same as functions/lib/labour.js
            };
        });
}

function quoteSetupMins(d) {
    const byId = invByIdMap();
    let mins = 0;
    (d.lines || []).forEach((l) => {
        if (!l.itemId) return; // custom / crew / discount: no setup
        const inv = byId[l.itemId];
        if (!inv) return;
        mins += Math.max(0, Math.round(inv.setupMins || 0)) * Math.max(0, Math.round(l.qty || 0));
    });
    return mins;
}

/*  { parts: [setup, pack-down], hours, cents } for the quote being edited. */
function quoteLabour(d) {
    const ph = d.labourPH || {};
    const off = d.labourOff || {};
    const allParts = labourParts(quoteSetupMins(d), {
        startDate: d.hire && d.hire.startDate,
        endDate: /^\d{4}-\d{2}-\d{2}$/.test(d.labourPackDate || '') ? d.labourPackDate : d.hire && d.hire.endDate,
        town: d.deliveryTown && d.deliveryTown !== 'Other' ? d.deliveryTown : '',
        holidaySetup: ph.setup,
        holidayPack: ph.pack
    });
    const parts = allParts.filter((p) => !off[p.key]); // setup / pack-down each can be unticked
    return {
        parts,
        allParts,
        hours: parts.reduce((t, p) => t + p.hours, 0),
        cents: parts.reduce((t, p) => t + p.cents, 0)
    };
}

let quoteDraft = blankQuote();

const QDOC_STATUS = {
    // SALES PIPELINE: Estimate -> Quote -> Invoice -> Paid
    draft: ['ad-pill-grey', 'Estimate'],
    approved: ['ad-pill-blue', 'Quote - not sent'],
    sent: ['ad-pill-blue', 'Quote sent'],
    accepted: ['ad-pill-green', 'Accepted'],
    declined: ['ad-pill-red', 'Declined'],
    invoiced: ['ad-pill-amber', 'Invoice - unpaid'],
    paid: ['ad-pill-green', 'Paid'],
    cancelled: ['ad-pill-grey', 'Cancelled']
};
function qdocPill(s) {
    const [c, l] = QDOC_STATUS[s] || QDOC_STATUS.draft;
    return `<span class="ad-pill ${c}">${esc(l)}</span>`;
}

/*  Totals - mirror of quoteMoney() in functions/index.js. Prices ex-GST,
    discounts off the net, GST 10% on top.                                 */
const BOOKING_FEE_PCT = 2;
/*  PERFORMER SUPER: 12% of the DJ's performance fee, its
    own line with an on/off tick. Performance = the DJ performance line (or
    a template's DJ / Entertainer fill-in). Not counted in the 2% fee.      */
const SUPER_PCT = 12;
const SUPER_NAME = 'Performer superannuation (12%)';
const SUPER_DESC = "Australian law requires super to be paid for performers. We pay it into your DJ's super fund for you.";
const isPerfLine = (l) => l.perf === true || l.djSlot === 'dj' || /^DJ performance/i.test(String(l.name || ''));

function quoteDraftMoney(d) {
    const docDays = Math.max(1, Math.round((d.hire && d.hire.days) || 1));
    let subtotal = 0;
    let discount = Math.max(0, Math.round(d.discountCents || 0)); // discount off the whole total
    (d.lines || []).forEach((l) => {
        if (l.type === 'discount') {
            discount += Math.max(0, Math.round(l.amountCents || 0));
            return;
        }
        subtotal += quoteLineCents(l, docDays);
    });
    const labourCents = d.labourExcluded === true ? 0 : quoteLabour(d).cents;
    const deliveryCents = quoteDeliveryCents(d);
    const beforeFee = Math.max(0, subtotal + labourCents + deliveryCents - discount);
    // BOOKING & ADMIN FEE: 2% of everything before GST, on every quote
    // rounded to the nearest $10 so it reads cleanly
    const feeCents = d.feeExcluded === true ? 0 : Math.round((beforeFee * BOOKING_FEE_PCT) / 100 / 1000) * 1000;
    const perfCents = (d.lines || []).filter((l) => !l.superLine && isPerfLine(l)).reduce((n, l) => n + quoteLineCents(l, docDays), 0);
    const superCents = d.superExcluded === true ? 0 : Math.round((perfCents * SUPER_PCT) / 100);
    const net = beforeFee + feeCents + superCents;
    const gst = Math.round(net * 0.1);
    return {
        subtotalCents: subtotal,
        labourCents,
        deliveryCents,
        feeCents,
        superCents,
        perfCents,
        discountCents: discount,
        netCents: net,
        gstCents: gst,
        totalCents: net + gst
    };
}

/*  A line's own total: quantity x day rate x number of days.
    Custom lines default to 1 day unless the staffer sets more.
    Discounts are handled once against the whole total, not per line.     */
function quoteLineCents(l, docDays) {
    if (l.type === 'discount') return -Math.max(0, Math.round(l.amountCents || 0));
    const qty = Math.max(0, l.perf ? Math.round(Number(l.qty || 0) * 4) / 4 : Math.round(Number(l.qty) || 0)); // DJ hours can be 4.5
    const unit = Math.max(0, Math.round(l.unitCents || 0));
    const days = Math.max(1, Math.round(l.days || docDays || 1));
    return Math.round(qty * unit * days);
}

VIEWS.quoteDocs = {
    html() {
        return state.openQuoteId ? quoteBuilderHtml() : quoteListHtml();
    },
    wire() {
        if (state.openQuoteId) wireQuoteBuilder();
        else wireQuoteList();
    }
};

/* -------------------------------------------------------------------------
   List
   ------------------------------------------------------------------------- */
/*  Paid vendor bookings shown as rows in the Sales Pipeline. They carry
    vendor:true, so they get their own Vendors tab and open the vendor's
    invoice page instead of the quote builder. */
function vendorInvoiceJobs() {
    const evName = (id) => ((state.events || []).find((e) => e.id === id) || {}).name || 'Event';
    const evISO = (id) => ((state.events || []).find((e) => e.id === id) || {}).dateISO || '';
    return (state.bookings || [])
        .filter((b) => b.status === 'confirmed' || b.paymentStatus === 'paid' || b.paymentStatus === 'free')
        .map((b) => {
            const biz = b.business || {};
            return {
                id: 'vendor:' + b.id,
                vendor: true,
                kind: 'invoice',
                status: 'paid',
                invoiceNumber: b.invoiceNumber || '',
                customer: {
                    name: biz.name || 'Vendor',
                    email: biz.email || '',
                    eventName: evName(b.eventId) + ' · vendor' + (b.siteLabel ? ' · site ' + b.siteLabel : '')
                },
                hire: { startDate: evISO(b.eventId) },
                totalCents: b.totalCents != null ? b.totalCents : b.amountCents || 0,
                createdAt: b.confirmedAt || b.createdAt,
                emailedAt: b.invoiceEmailedAt || null,
                invoiceToken: b.invoiceToken || ''
            };
        });
}
/*  Paid vendors with no invoice number yet get one (once per page load). */
let vendorInvoicesEnsured = false;
function pipelineJobs() {
    const vend = vendorInvoiceJobs();
    if (!vendorInvoicesEnsured && vend.some((v) => !v.invoiceNumber)) {
        vendorInvoicesEnsured = true;
        call('adminEnsureVendorInvoices', {}).catch(() => {
            vendorInvoicesEnsured = false;
        });
    }
    return (state.quoteDocs || []).concat(vend);
}
/*  SALES PIPELINE - the look and the filtering live in js/admin/sales-pipeline.js;
    this hands it the live quotes and the actions on each job. */
function quoteListHtml() {
    return pipelineHtml(pipelineJobs(), state.spFilter, H);
}

function wireQuoteList() {
    const findDoc = (id) => (state.quoteDocs || []).find((x) => x.id === id);
    const label = (d) => (d && d.customer && (d.customer.name || d.customer.business)) || (d && d.number) || 'this job';
    // run an admin function; a failure is shown as an alert
    const run = async (name, data, fail) => {
        try {
            await call(name, data);
        } catch (e) {
            window.alert(e.message || fail);
        }
    };
    wirePipeline(pipelineJobs, state.spFilter, H, {
        open(id) {
            location.hash = '#/quoteDocs?q=' + id;
        },
        // email every paid vendor (not yet emailed) their invoice & event guide
        async sendAllVendors(btn) {
            const unsent = vendorInvoiceJobs().filter((v) => !v.emailedAt);
            if (!unsent.length) return;
            const evId = state.activeEventId;
            const names = unsent.map((v) => '- ' + v.customer.name).join('\n');
            if (
                !window.confirm(
                    'Email ' +
                        unsent.length +
                        ' vendor' +
                        (unsent.length === 1 ? '' : 's') +
                        ' their tax invoice & event guide now?\n\n' +
                        names +
                        '\n\nThis sends real emails to vendors.'
                )
            )
                return;
            btn.disabled = true;
            btn.textContent = 'Sending...';
            try {
                const res = await call('adminSendVendorInvoicesAll', { eventId: evId });
                window.alert('Sent ' + res.sent + '.' + (res.failed && res.failed.length ? '\n\nNot sent:\n' + res.failed.join('\n') : ''));
            } catch (err) {
                window.alert(err.message || 'Could not send.');
            }
            btn.disabled = false;
            btn.textContent = 'Done';
        },
        // vendor tax invoice: view the page, or email a TEST to the signed-in admin only
        async vendorInvoice(id, mode, btn) {
            const bookingId = String(id).replace(/^vendor:/, '');
            const was = btn ? btn.textContent : '';
            if (btn) {
                btn.disabled = true;
                btn.textContent = mode === 'test' ? 'Sending...' : 'Opening...';
            }
            try {
                if (mode === 'test') {
                    const res = await call('adminSendVendorInvoice', { bookingId, test: true });
                    window.alert(
                        res.sent
                            ? 'Test sent to ' + res.to + ' only. The vendor was NOT emailed.'
                            : 'It did not send. ' + (res.error || res.reason || '')
                    );
                } else {
                    const res = await call('adminVendorInvoiceLink', { bookingId });
                    if (mode === 'copy') {
                        try {
                            await navigator.clipboard.writeText(res.link);
                            window.alert('Link copied.');
                        } catch (e) {
                            window.prompt('Copy the vendor link:', res.link);
                        }
                    } else window.open(res.link, '_blank', 'noopener');
                }
            } catch (err) {
                window.alert(err.message || 'Could not do that.');
            }
            if (btn) {
                btn.disabled = false;
                btn.textContent = was;
            }
        },
        newQuote() {
            state.openQuoteId = null;
            location.hash = '#/quoteDocs?q=new';
        },
        // a new estimate with the same customer, items and settings - opens it
        async duplicate(id) {
            const doc = findDoc(id);
            if (!doc) return;
            quoteDraft = { ...quoteFromDoc(doc), kind: 'quote' };
            rebuildAllKits();
            const cm = findCustomerMatch(doc.customer || {});
            quoteCustomerId = cm ? cm.id : '';
            state.quoteFromLeadId = '';
            state.openQuoteId = '__new__';
            location.hash = '#/quoteDocs?q=new'; // the router keeps this pre-filled copy
            try {
                await saveQuoteDoc(null);
                const m = document.getElementById('q-msg');
                if (m) m.textContent = 'Copy made - this is the new estimate.';
            } catch (e) {
                /* message shown */
            }
        },
        // the job is off: cancelled (kept, in Archived) and its DJ booking taken off the roster
        async canceljob(id) {
            const q = findDoc(id) || {};
            const gigs = [...new Set([].concat(q.pubBookings || [], q.gigBookingId || []).filter(Boolean))];
            if (
                !window.confirm(
                    'Cancel ' +
                        label(q) +
                        '?\n\nIt stays in the pipeline marked Job cancelled, and the customer link stops working.' +
                        (gigs.length ? ' The DJ booking comes off the roster.' : '')
                )
            )
                return;
            try {
                await call('adminArchiveQuote', { id, archive: true, jobCancelled: true });
                const { doc, updateDoc } = fb.f;
                for (const g of gigs) await updateDoc(doc(fb.db, 'talentSchedule', g), { status: 'cancelled' }).catch(() => {});
                loadSchedule();
            } catch (e) {
                window.alert(e.message || 'Could not cancel.');
            }
        },
        async archive(id) {
            if (
                !window.confirm(
                    'Archive ' +
                        label(findDoc(id)) +
                        '? It moves to the Archived tab and the customer link stops working. You can restore it later.'
                )
            )
                return;
            await run('adminArchiveQuote', { id, archive: true }, 'Could not archive.');
        },
        // money came in another way (bank transfer / cash): paid in full, becomes a tax invoice
        async paid(id) {
            const d = findDoc(id);
            if (
                !window.confirm(
                    'Mark ' +
                        label(d) +
                        ' as PAID IN FULL (' +
                        money((d && d.totalCents) || 0) +
                        ')?\n\nUse this when the money came in by bank transfer or cash. It becomes a tax invoice.'
                )
            )
                return;
            await run('adminSetQuoteStatus', { id, status: 'paid' }, 'Could not mark paid.');
        },
        // a bank-transfer deposit arrived: books the job (becomes an invoice) and unlocks the pick list
        async confirmjob(id) {
            // job goes ahead, customer pays later
            const d = findDoc(id);
            if (
                !window.confirm(
                    'Confirm ' +
                        label(d) +
                        ' without payment?\n\nIt becomes an unpaid invoice, the pick list unlocks and goes to the office + crew (and the gear list to the band). Payment reminders still work.'
                )
            )
                return;
            await run('adminConfirmJob', { id }, 'Could not confirm the job.');
        },
        async unconfirmjob(id) {
            if (!window.confirm('Undo the job confirmation for ' + label(findDoc(id)) + '?')) return;
            await run('adminConfirmJob', { id, undo: true }, 'Could not undo it.');
        },
        async deposit(id) {
            const d = findDoc(id);
            if (!window.confirm('Deposit received for ' + label(d) + '?\n\nThis books the job and makes it a tax invoice.')) return;
            await run('adminDepositReceived', { id }, 'Could not record the deposit.');
        },
        // makes the private crew link (no prices) - the menu then shows Open / Copy
        async picklist(id) {
            await run('adminPickListLink', { id }, 'Could not make the pick list.');
        },
        // GEAR LIST to the band / crew - no prices
        // TEST: the gear list + pick list emails, to Max only (nothing recorded)
        async geartest(id) {
            try {
                const r = await call('adminSendGearList', { id, test: true });
                window.alert(
                    r.sent ? 'Test sent to ' + r.to + ' - check your inbox (2 emails).' : 'It did not send: ' + (r.error || r.reason || '')
                );
            } catch (e) {
                window.alert(e.message || 'Could not send.');
            }
        },
        async gearlist(id) {
            const d = findDoc(id);
            const to = String((d.customer || {}).gearEmails || '').trim();
            if (!to) {
                window.alert('Open the quote and add the band / crew emails under "Gear list to" first.');
                return;
            }
            if (!window.confirm('Email the gear list for ' + label(d) + ' to:\n\n' + to + '?')) return;
            try {
                const r = await call('adminSendGearList', { id });
                window.alert(r.sent ? 'Sent to ' + r.to + '.' : 'It did not send: ' + (r.error || r.reason || ''));
            } catch (e) {
                window.alert(e.message || 'Could not send.');
            }
        },
        // LATE PAYMENT CHARGE: 2% of what is still owing - asks first
        async latefee(id) {
            const d = findDoc(id);
            const owing = (d.totalCents || 0) + (d.lateFeeCents || 0) - (d.amountPaidCents || 0);
            if (
                !window.confirm(
                    'Add a 2% late payment charge to ' +
                        label(d) +
                        '?\n\n' +
                        money(Math.round(owing * 0.02)) +
                        ' (2% of the ' +
                        money(owing) +
                        ' still owing).\n\nIt shows on their invoice as a separate line. You can remove it later.'
                )
            )
                return;
            await run('adminAddLateFee', { id }, 'Could not add the late fee.');
        },
        // payment reminder
        async remind(id) {
            await sendReminder(call, findDoc(id));
        },
        async unlatefee(id) {
            if (!window.confirm('Remove the last late fee from ' + label(findDoc(id)) + '?')) return;
            await run('adminRemoveLateFee', { id }, 'Could not remove it.');
        },
        // back to a sent quote, as if nothing was paid (hand-marked payments only)
        async undopay(id) {
            const d = findDoc(id);
            if (
                !window.confirm(
                    'Undo the deposit / payment on ' +
                        label(d) +
                        '? It goes back to a sent quote - invoice number, pick list and ticks are cleared.'
                )
            )
                return;
            await run('adminUndoPayment', { id }, 'Could not undo.');
        },
        async restore(id) {
            await run('adminArchiveQuote', { id, archive: false }, 'Could not restore.');
        },
        async del(id) {
            const d = findDoc(id);
            // an archived job with an invoice or money on it: type DELETE (it may be a tax record)
            const hasMoney = d && (d.invoiceNumber || (d.amountPaidCents || 0) > 0 || d.kind === 'invoice');
            if (hasMoney) {
                const typed = window.prompt(
                    label(d) +
                        ' (' +
                        (d.invoiceNumber || d.number || '') +
                        ') has an invoice or payment on it.\n\nOnly delete TEST jobs - real tax invoices must be kept for 5 years.\n\nType DELETE to remove it forever:'
                );
                if (
                    String(typed || '')
                        .trim()
                        .toUpperCase() !== 'DELETE'
                )
                    return;
            } else if (
                !window.confirm(
                    'DELETE ' + label(d) + ' (' + ((d && d.number) || '') + ') FOREVER?\n\nThis cannot be undone. Archive keeps it instead.'
                )
            )
                return;
            await run('adminDeleteQuote', { id, force: !!hasMoney }, 'Could not delete.');
        }
    });
}

/*  "Copy lines from..." on the quote: templates first, then the 40 newest quotes. */
function copyFromSelectHtml() {
    const docs = (state.quoteDocs || []).filter((q) => q.id !== state.openQuoteId && q.status !== 'cancelled' && (q.lines || []).length);
    const name = (q) =>
        q.templateName ||
        [(q.customer || {}).eventName || (q.customer || {}).business || (q.customer || {}).name, q.number].filter(Boolean).join(' - ') ||
        'Untitled';
    const tpls = docs.filter((q) => q.isTemplate).sort((x, y) => name(x).localeCompare(name(y)));
    const recent = docs
        .filter((q) => !q.isTemplate)
        .sort((x, y) => (secs(y.createdAt) || 0) - (secs(x.createdAt) || 0))
        .slice(0, 40);
    if (!tpls.length && !recent.length) return '';
    const opts = (list) => list.map((q) => `<option value="${attr(q.id)}">${esc(name(q))}</option>`).join('');
    return `<select class="qb-date qb-copyfrom" id="q-copyfrom"><option value="">&#128203; Copy lines from a template or quote&hellip;</option>${tpls.length ? `<optgroup label="Templates">${opts(tpls)}</optgroup>` : ''}${recent.length ? `<optgroup label="Recent quotes">${opts(recent)}</optgroup>` : ''}</select>`;
}

async function uploadQuotePoster(file) {
    const msg = document.getElementById('q-poster-msg');
    if (msg) msg.textContent = 'Uploading photo…';
    try {
        const { ref, uploadBytes, getDownloadURL } = fb.st;
        const small = await shrinkPhoto(file, 1600);
        const path =
            'quote-images/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + (small.type === 'image/webp' ? '.webp' : '');
        await uploadBytes(ref(fb.storage, path), small, { contentType: small.type || file.type });
        quoteDraft.posterUrl = await getDownloadURL(ref(fb.storage, path));
        scheduleQuoteAutosave();
        render();
    } catch (e) {
        if (msg) msg.textContent = 'Upload failed - ' + (e.message || 'try again');
    }
}

/*  Event type "Custom photo": your own image (e.g. the gig poster) behind the top of the customer's quote. */
function posterBoxHtml() {
    return `<div class="qb-poster">
    ${quoteDraft.posterUrl ? `<img src="${attr(quoteDraft.posterUrl)}" alt="Custom photo">` : ''}
    <label class="ad-btn ad-btn-small">${quoteDraft.posterUrl ? '&#8635; Change photo' : '&#128444; Upload photo'}<input type="file" accept="image/*" id="q-poster" hidden></label>
    <span class="qb-poster-msg" id="q-poster-msg">${quoteDraft.posterUrl ? '' : 'or copy an image and press Ctrl+V'}</span>
  </div>`;
}

function quoteFromDoc(doc) {
    return {
        kind: doc.kind || 'quote',
        customer: { ...blankQuote().customer, ...(doc.customer || {}) },
        hire: { ...blankQuote().hire, ...(doc.hire || {}) },
        // Labour and delivery lines are recomputed live, so drop stored ones here.
        lines: (doc.lines || [])
            .filter((l) => l.type !== 'labour' && l.type !== 'delivery' && l.type !== 'fee' && !l.superLine)
            .map((l) => {
                const c = { ...l };
                if (c.type === 'custom' && !c.resType) {
                    const r = (state.resources || []).find(
                        (x) =>
                            x.name &&
                            String(x.name).trim().toLowerCase() ===
                                String(c.name || '')
                                    .trim()
                                    .toLowerCase()
                    );
                    if (r) {
                        c.resType = r.type || 'staff';
                        c.resourceId = r.id;
                    } else if (/on-site av technician|operator/i.test(c.name || '')) c.resType = 'staff';
                }
                return c;
            }),
        feeExcluded: doc.feeExcluded === true,
        superExcluded: doc.superExcluded === true,
        accomOff: doc.accomOff === true,
        autoSendOnDetails: doc.autoSendOnDetails === true,
        isTemplate: doc.isTemplate === true,
        templateName: doc.templateName || '',
        posterUrl: doc.posterUrl || '',
        // saved discountCents is the total; the box is only the whole-quote part
        discountCents: Math.max(
            0,
            Math.round(doc.discountCents || 0) -
                (doc.lines || []).reduce((n, l) => n + (l.type === 'discount' ? Math.max(0, Math.round(l.amountCents || 0)) : 0), 0)
        ),
        labourExcluded: doc.labourExcluded === true,
        labourPH: { setup: !!(doc.labourPH && doc.labourPH.setup), pack: !!(doc.labourPH && doc.labourPH.pack) },
        labourOff: { setup: !!(doc.labourOff && doc.labourOff.setup), pack: !!(doc.labourOff && doc.labourOff.pack) },
        labourPackDate: doc.labourPackDate || '',
        deliveryTown: (doc.delivery && doc.delivery.town) || '',
        deliveryKm: Math.max(0, Math.round((doc.delivery && doc.delivery.km) || 0)),
        notes: doc.notes || '',
        terms: doc.terms || ''
    };
}

/* -------------------------------------------------------------------------
   Builder
   ------------------------------------------------------------------------- */
function currentQuoteDoc() {
    return (state.quoteDocs || []).find((x) => x.id === state.openQuoteId) || null;
}

/*  "Emailed 16 Oct 2026, 3:12 pm to gm@... (2 times)" - or "Not emailed yet".
    Written by adminSendQuote on every successful send.   */
function quoteEmailedLine(doc) {
    const s = secs(doc && doc.lastEmailedAt);
    if (!s) return '&#9993; Not emailed to the customer yet.';
    const when = new Date(s * 1000).toLocaleString('en-AU', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
    });
    const n = doc.emailCount || 1;
    return (
        '&#9993; Emailed ' +
        esc(when) +
        (doc.lastEmailedTo ? ' to ' + esc(doc.lastEmailedTo) : '') +
        (n > 1 ? ' &middot; ' + n + ' times' : '')
    );
}

function quoteBuilderHtml() {
    const doc = currentQuoteDoc();
    const status = doc ? doc.status : 'approved'; // a new one made here is a quote, not an estimate
    const isInvoice = doc && doc.kind === 'invoice';
    let docWord = 'Quote';
    if (isInvoice) docWord = 'Tax Invoice';
    else if (status === 'draft') docWord = 'Estimate';
    const num = doc ? (isInvoice && doc.invoiceNumber ? doc.invoiceNumber : doc.number) : 'New';
    const created = doc && doc.createdAt ? dateShort(doc.createdAt) : dateShort(Math.floor(Date.now() / 1000));
    const c = quoteDraft.customer;
    const h = quoteDraft.hire;

    // the status pill: Template, the saved status, or New (bar) / Draft (paper) before the first save
    const pill = (unsaved) => {
        if (quoteDraft.isTemplate) return '<span class="ad-pill ad-pill-blue">Template</span>';
        if (doc) return qdocPill(status);
        return '<span class="ad-pill ad-pill-grey">' + unsaved + '</span>';
    };

    const link = doc && doc.token ? window.location.origin + '/quote?t=' + doc.token : '';

    const metaRow = (label, value) =>
        `<div class="qb-mrow"><span class="qb-mlabel">${label}</span><span class="qb-mval">${value}</span></div>`;
    const hirePeriod =
        h.startDate || h.endDate ? `${esc(h.startDate || '…')} &rarr; ${esc(h.endDate || '…')}` : '<span class="qb-faint">Set below</span>';

    const botCard =
        doc && doc.source === 'bot'
            ? (() => {
                  const chip = (label, value) =>
                      value ? `<div class="qb-botcell"><span>${label}</span><strong>${esc(value)}</strong></div>` : '';
                  const support =
                      {
                          full: 'Full service (deliver, set up + on-site tech)',
                          delivery: 'Delivery & setup only',
                          pickup: 'Self-collect from Bowen'
                      }[doc.botSupport] || '—';
                  const venueSetting = { indoor: 'Indoors', outdoor: 'Outdoors', mixed: 'Indoor & outdoor' }[doc.botIndoor] || '';
                  const powerLbl = { yes: 'Mains power', no: 'No power', unsure: 'Power unsure' }[doc.botPower] || '';
                  const accessLbl =
                      { easy: 'Easy', stairs: 'Some stairs / carry', tricky: 'Tricky — upstairs / long carry' }[doc.botAccess] || '';
                  const timing = [doc.botStart, doc.botFinish].filter(Boolean).join(' → ');
                  const extrasLbl = Array.isArray(doc.botExtras) && doc.botExtras.length ? doc.botExtras.join(', ') : '';
                  return `
      <section class="qb-botcard">
        <div class="qb-botcard-h">&#128233; From the estimate bot &mdash; what the customer told us</div>
        <div class="qb-botgrid">
          ${chip('Package matched', doc.packageName)}
          ${chip('Guests', doc.guests)}
          ${chip('Venue', (doc.delivery && doc.delivery.town) || doc.botTown)}
          ${chip('Setting', venueSetting + (powerLbl ? ' · ' + powerLbl : ''))}
          ${chip('Timing', timing)}
          ${chip('Access', accessLbl)}
          ${chip('Days', (doc.hire && doc.hire.days) || 1)}
          ${chip('Event date', c.eventDate)}
          ${chip('Support', support)}
        </div>
        ${extrasLbl ? `<p class="qb-botmsg"><span>Extras chosen:</span> ${esc(extrasLbl)}</p>` : ''}
        ${doc.botGenerator ? '<p class="qb-botflag">⚠ Outdoors with no mains power — a generator estimate is in the lines; confirm the right size.</p>' : ''}
        ${doc.botMessage ? `<p class="qb-botmsg"><span>Their message:</span> ${esc(doc.botMessage)}</p>` : ''}
        <p class="qb-botnote">Review the gear &amp; price against this, adjust anything, then Send.</p>
      </section>`;
              })()
            : '';

    return `
    <div class="q-build qb">

      <!-- toolbar (not part of the printed paper) -->
      <div class="qb-bar">
        <button type="button" class="qb-back" id="q-back">&larr; Sales Pipeline</button>
        <div class="qb-bar-title"><h1>${quoteDraft.isTemplate ? 'Template: ' + esc(quoteDraft.templateName || 'Untitled') : esc(docWord) + ' #' + esc(num)}</h1>${pill('New')}</div>
        <div class="qb-bar-spacer"></div>
        ${link ? `<a class="ad-btn ad-btn-ghost" href="${attr(link)}" target="_blank" rel="noopener">Preview</a>` : ''}
        <span class="qb-auto" id="q-auto"></span>
        <button type="button" class="ad-btn${doc ? '' : ' ad-btn-primary'}" id="q-save">Save</button>
        <label class="qb-tpl" title="A template is copied for DJ gig invoices and can't be sent"><input type="checkbox" data-qtpl${quoteDraft.isTemplate ? ' checked' : ''}> Template</label>
        ${!quoteDraft.isTemplate && doc && status === 'draft' ? '<button type="button" class="ad-btn ad-btn-primary" id="q-approve">&#10003; Approve as quote</button>' : ''}
        ${!quoteDraft.isTemplate && doc && status !== 'draft' ? `<button type="button" class="ad-btn ad-btn-primary" id="q-send">${status === 'approved' ? '&#9993; Send Quote' : '&#9993; Resend'}</button>` : ''}
      </div>
      ${
          quoteDraft.isTemplate
              ? `<div class="qb-tplbar">
        <label class="qb-tplname"><span>Template name</span><input type="text" data-qtplname value="${attr(quoteDraft.templateName || '')}" placeholder="e.g. Grand View Friday" maxlength="80"></label>
        <p>&#128203; Booking a DJ (Entertainment) with this template copies it into that gig&rsquo;s invoice, then adds the DJ&rsquo;s hours &times; rate and travel. A template is never sent. Leave the customer and dates blank.</p>
      </div>`
              : ''
      }

      ${botCard}

      <!-- the paper -->
      <div class="qb-paper">

        <div class="qb-lh">
          <div class="qb-brand">
            <img src="/data/images/logo.png" alt="SoundzGood" class="qb-logo">
            <div class="qb-seller">
              ABN 49 700 595 348<br>
              34a Williams St, Bowen QLD 4805<br>
              info@soundzgood.com.au<br>
              www.soundzgood.com.au
            </div>
          </div>
          <div class="qb-meta">
            <p class="qb-tagline">Good People<br>Great Events</p>
            <div class="qb-mgrid">
              ${quoteDraft.isTemplate ? metaRow('Template', `<strong>${esc(quoteDraft.templateName || 'Untitled')}</strong>`) : metaRow(docWord + ' number', `<strong>${esc(num)}</strong>`)}
              ${metaRow('Status', pill('Draft'))}
              ${metaRow('Created', esc(created))}
              ${metaRow('Event / Job', `<input class="qb-min" data-qc="eventName" value="${attr(c.eventName)}" placeholder="Event name">`)}
              ${metaRow(
                  'Event type',
                  `<select class="qb-min" data-qc="eventType">${Object.keys(EVENT_TYPES)
                      .map(
                          (k) =>
                              `<option value="${k}"${(c.eventType || guessEventType(c.eventName)) === k ? ' selected' : ''}>${EVENT_TYPES[k]}</option>`
                      )
                      .join('')}<option value="custom"${c.eventType === 'custom' ? ' selected' : ''}>Custom photo&hellip;</option></select>`
              )}
              ${c.eventType === 'custom' ? metaRow('Photo', posterBoxHtml()) : ''}
              ${metaRow('Venue', `<input class="qb-min" data-qc="eventVenue" value="${attr(c.eventVenue || '')}" placeholder="Venue / address">`)}
              ${metaRow('Event date', `<input type="date" class="qb-min" data-qevdate value="${attr(isoFromPretty(c.eventDate) || (quoteDraft.hire && quoteDraft.hire.startDate) || '')}">`)}
              ${metaRow('Soundcheck', `<input type="time" class="qb-min" data-qc="soundcheckTime" value="${attr(c.soundcheckTime || '')}">`)}
              ${metaRow('Event starts', `<input type="time" class="qb-min" data-qc="eventStartTime" value="${attr(c.eventStartTime || '')}">`)}
              ${metaRow('Event ends', `<input type="time" class="qb-min" data-qc="eventEndTime" value="${attr(c.eventEndTime || '')}">`)}
              ${metaRow('Hire period', `<span class="qb-hp">${hirePeriod}</span>`)}
              ${metaRow('Days charged', `<input class="qb-min qb-min-num" type="number" min="1" step="1" data-qh="days" value="${attr(h.days)}">`)}
            </div>
          </div>
        </div>

        <div class="qb-parties">
          <div class="qb-to">
            <p class="qb-block-h">${isInvoice ? 'Bill to' : 'Quote to'}</p>
            ${quoteCustSearchHtml()}
            <label class="qb-fl"><span>Name</span><input class="qb-cin qb-cin-strong" data-qc="name" value="${attr(c.name)}" placeholder="Customer name"></label>
            <label class="qb-fl"><span>Business</span><input class="qb-cin" data-qc="business" value="${attr(c.business)}" placeholder="Business (optional)"></label>
            <label class="qb-fl"><span>Address</span><input class="qb-cin" data-qc="address" value="${attr(c.address)}" placeholder="Address"></label>
            <label class="qb-fl"><span>Phone</span><input class="qb-cin" data-qc="phone" value="${attr(c.phone)}" placeholder="Phone"></label>
            <label class="qb-fl"><span>Email</span><input class="qb-cin" type="email" data-qc="email" value="${attr(c.email)}" placeholder="Email"></label>
            <div class="qb-fl"><span>CC &middot; billing / accounts copy</span><div class="qb-cc" id="qb-cc">${ccChipsInner(c.ccEmail, 'Accounts email (optional) - press Enter')}</div></div>
            <label class="qb-fl"><span>Event day contact</span><input class="qb-cin" data-qc="dayContact" value="${attr(c.dayContact || '')}" placeholder="Name &amp; phone on the day"></label>
            <label class="qb-fl"><span>Customer notes</span><textarea class="qb-cin qb-cnotes" rows="3" data-qc="customerNotes" placeholder="Anything the customer told us">${esc(c.customerNotes || '')}</textarea></label>
          </div>
          <div class="qb-hire">
            <p class="qb-block-h">Hire period</p>
            <label class="qb-dfield"><span>From</span><input class="qb-date" type="date" data-qh="startDate" value="${attr(h.startDate)}"></label>
            <label class="qb-dfield"><span>To</span><input class="qb-date" type="date" data-qh="endDate" value="${attr(h.endDate)}"></label>

            <p class="qb-block-h" style="margin-top:14px">Delivery</p>
            <label class="qb-dfield"><span>To</span>
              <select class="qb-date qb-delsel" data-qdel-town>
                <option value="__pickup__"${!quoteDraft.deliveryTown ? ' selected' : ''}>Pickup / no delivery</option>
                ${DELIVERY_ZONES.map((z) => `<option value="${z.km}" data-town="${attr(z.town)}"${quoteDraft.deliveryTown === z.town ? ' selected' : ''}>${esc(z.town)}${z.km ? ` — ${z.km}km` : ''}</option>`).join('')}
                <option value="__other__"${quoteDraft.deliveryTown === 'Other' ? ' selected' : ''}>Other (enter km)…</option>
              </select></label>
            ${quoteDraft.deliveryTown === 'Other' ? `<label class="qb-dfield"><span>Km ea way</span><input class="qb-date" type="number" min="0" step="1" data-qdel-km value="${attr(quoteDraft.deliveryKm || '')}"></label>` : ''}
          </div>
        </div>

        <div class="qb-lines-head">
          <span class="qb-block-h">Line items</span>
          ${copyFromSelectHtml()}
        </div>

        <div class="qb-table">
          <div class="qb-thead">
            <span class="qb-c-grip"></span>
            <span class="qb-c-desc">Item / Description</span>
            <span class="qb-c-qty" id="q-th-qty">Qty</span>
            <span class="qb-c-rate" id="q-th-rate">Amount (ex GST)</span>
            <span class="qb-c-days">Days</span>
            <span class="qb-c-total">Total (ex GST)</span>
            <span class="qb-c-x"></span>
          </div>
          <div class="qb-lines" id="q-lines"></div>

          <!--  The adder stays pinned as the bottom row: type to search
                inventory (top 3), or add a custom line / discount. It sits
                outside #q-lines so re-rendering the rows never wipes it.   -->
          <div class="qb-addrow">
            <div class="qb-adder">
              <div class="qb-searchwrap">
                <input type="text" id="q-inv-search" class="qb-searchin" autocomplete="off"
                       placeholder="&#128269;  Search inventory, crew or a vehicle&hellip;">
                <div class="qb-results" id="q-inv-results" hidden></div>
              </div>
              <button type="button" class="ad-btn ad-btn-small" id="q-add-custom">+ Custom item</button>
              <button type="button" class="ad-btn ad-btn-small" id="q-add-disc">&minus; Discount</button>
            </div>
          </div>
        </div>

        <div class="qb-foot">
          <div class="qb-foot-notes">
            <div class="qb-note-box">
              <p class="qb-block-h">Notes to customer</p>
              <textarea class="qb-note" rows="3" data-qmeta="notes" placeholder="Thanks for your enquiry. Looking forward to working with you!">${esc(quoteDraft.notes)}</textarea>
            </div>
            <div class="qb-note-box">
              <p class="qb-block-h">Terms &amp; conditions</p>
              <textarea class="qb-note" rows="3" data-qmeta="terms" placeholder="Quote valid for 30 days.&#10;Payment due on acceptance.&#10;All prices are in AUD and exclude GST.">${esc(quoteDraft.terms)}</textarea>
            </div>
          </div>
          <div class="qb-summary" id="q-totals"></div>
        </div>
      </div>

      <!-- lifecycle strip (not part of the paper) -->
      ${
          doc && !quoteDraft.isTemplate
              ? `
      <section class="qb-lifecycle">
        <div class="qb-life-row">
          ${status === 'approved' || status === 'sent' ? '<button type="button" class="ad-btn" id="q-accept">Mark accepted</button>' : ''}
          ${(status === 'accepted' || (status === 'invoiced' && doc.acceptedAt)) && !(doc.amountPaidCents > 0) ? '<button type="button" class="ad-btn" id="q-unaccept">Undo accept</button>' : ''}
          ${doc.kind !== 'invoice' && status !== 'draft' ? '<button type="button" class="ad-btn" id="q-invoice">Convert to invoice</button>' : ''}
          ${doc.kind === 'invoice' && status !== 'paid' ? '<button type="button" class="ad-btn" id="q-paid">Mark paid</button>' : ''}
          <button type="button" class="ad-btn" id="q-dup">Duplicate</button>
          <button type="button" class="ad-btn inv-del" id="q-cancel">Cancel</button>
          <span class="ad-quote-msg" id="q-msg"></span>
        </div>
        <p class="q-emailed">${quoteEmailedLine(doc)}</p>
        ${
            link
                ? `<div class="q-link"><span>Customer link</span>
          <input class="ad-input" id="q-link" readonly value="${attr(link)}">
          <button type="button" class="ad-btn ad-btn-small" id="q-copy">Copy</button></div>`
                : ''
        }
      </section>`
              : '<p class="q-savefirst">Save the quote to send it, get its link, or turn it into an invoice. <span id="q-msg" class="ad-quote-msg"></span></p>'
      }
    </div>`;
}

let quoteEventDateAuto = '';
/*  CC EMAILS AS CHIPS: type an address, press Enter or a
    comma, and it becomes a tag; x removes it. Saved as "a@b.com, c@d.com"
    in customer.ccEmail - everyone listed gets a copy. */
const CC_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
function ccList(str) {
    return String(str || '')
        .split(/[,;\s]+/)
        .map((e) => e.trim())
        .filter(Boolean);
}
function ccChipsInner(str, ph) {
    const list = ccList(str);
    return (
        list
            .map(
                (e, i) =>
                    '<span class="qb-chip' +
                    (CC_RE.test(e) ? '' : ' is-bad') +
                    '" title="' +
                    attr(CC_RE.test(e) ? 'Gets a copy of every email' : 'This does not look like an email address') +
                    '">' +
                    esc(e) +
                    '<button type="button" data-cc-del="' +
                    i +
                    '" aria-label="Remove ' +
                    attr(e) +
                    '">&times;</button></span>'
            )
            .join('') +
        '<input class="qb-cc-in" type="email" autocomplete="off" placeholder="' +
        (list.length ? 'Add another&hellip;' : ph || 'Copy someone in (optional) - type an email, press Enter') +
        '">' +
        '<p class="qb-cc-msg" hidden></p>'
    );
}

/*  "Tue 20 Oct 2026" -> "2026-10-20", for the event-date calendar.
    A date typed without a year comes back blank - just pick the date. */
function isoFromPretty(text) {
    const m = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/.exec(String(text || ''));
    if (!m) return /^\d{4}-\d{2}-\d{2}$/.test(String(text || '')) ? text : '';
    const mon = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[2].toLowerCase());
    if (mon < 0) return '';
    return m[3] + '-' + String(mon + 1).padStart(2, '0') + '-' + String(m[1]).padStart(2, '0');
}

/*  "2026-10-20" -> "Tue 20 Oct 2026" for the Event date box. */
function prettyEventDate(iso) {
    if (!isoOk(iso)) return '';
    return prettyDate(iso).replace(/,/g, '');
}

/*  INCLUDED / REQUIRED ROWS, GROUPED
    Under each item, its included gear is shown by inventory category as
    small sub-headings - Cable, then Stands... - each A-Z, and sitting
    inside the item (no dividing line).                                  */
function kitCategoryOf() {
    const cats = {};
    invItems().forEach((it) => {
        cats[it.id] = it.category || '';
    });
    return (l) => {
        const c = String(cats[l.itemId] || '').trim();
        return c ? c.charAt(0).toUpperCase() + c.slice(1) : 'Other';
    };
}

function sortKitGroups() {
    const cat = kitCategoryOf();
    const L = quoteDraft.lines;
    for (let i = 0; i < L.length; i++) {
        if (L[i].type !== 'kit') continue;
        let end = i;
        while (end < L.length && L[end].type === 'kit') end++;
        const group = L.slice(i, end).sort(
            (a, b) =>
                // system parts first, in Max's order; everything else A-Z by category then name
                (a.sysOrder != null ? a.sysOrder : 1e9) - (b.sysOrder != null ? b.sysOrder : 1e9) ||
                cat(a).localeCompare(cat(b), undefined, { sensitivity: 'base' }) ||
                String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true, sensitivity: 'base' })
        );
        L.splice(i, end - i, ...group);
        i = end - 1;
    }
}

/*  PACKAGES STAY TOGETHER. A "unit" is a top line plus the
    included parts under it. Every unit of a package is pulled together where
    the package first appears, with its discount line last - so dragging
    something out of a package, or adding gear in between, can't split it. */
function quoteUnits(L) {
    const units = [];
    L.forEach((l) => {
        if (l.type === 'kit' && units.length) units[units.length - 1].push(l);
        else units.push([l]);
    });
    return units;
}
function normalizePackages() {
    const L = quoteDraft.lines;
    if (!L.some((l) => l.pkgId)) return;
    const units = quoteUnits(L);
    const out = [];
    const done = new Set();
    units.forEach((u) => {
        const id = u[0].pkgId;
        if (!id) {
            out.push(...u);
            return;
        }
        if (done.has(id)) return;
        done.add(id);
        const mine = units.filter((x) => x[0].pkgId === id);
        mine.filter((x) => x[0].type !== 'discount').forEach((x) => out.push(...x));
        const disc = mine.filter((x) => x[0].type === 'discount');
        if (disc.length) disc.forEach((x) => out.push(...x));
        else {
            const p = invItems().find((x) => x.id === id);
            out.push({ type: 'discount', name: ((p && p.name) || 'Package') + ' - package discount', amountCents: 0, pkgId: id });
        }
    });
    quoteDraft.lines = out;
}

/*  Admin-only: smart gig lines (filled in per gig by the server) get an
    orange box. The booking fee is a set fee, so it is left plain.        */
function isSmartLine(l) {
    if (!l.pubDj) return false;
    return !!(
        l.perf ||
        l.superLine ||
        l.accom ||
        ['dj', 'travel', 'accom'].includes(l.djSlot) ||
        (!l.djSlot && /^Travel/i.test(String(l.name || '')))
    );
}
const isEntLine = (l) => !!(l.pubDj || l.djSlot || l.superLine || l.perf);
/*  DJ JOBS IN TWO PARTS: the entertainment (DJ, travel, booking fee, super)
    on top under Hours / Fee, then the production gear under its own heading,
    with any discount last so it reads as a saving on production.          */
function sortDjSections() {
    const units = quoteUnits(quoteDraft.lines);
    if (!units.some((u) => isEntLine(u[0]))) return false;
    const rank = (l) => {
        if (isEntLine(l)) return 0;
        if (l.type === 'fee') return 3;
        if (l.type === 'discount' && !l.pkgId) return 2;
        return 1;
    };
    quoteDraft.lines = units
        .map((u, i) => [u, i])
        .sort((a, b) => rank(a[0][0]) - rank(b[0][0]) || a[1] - b[1])
        .map((x) => x[0])
        .flat();
    return true;
}
function setQuoteHead(dj) {
    const q = document.getElementById('q-th-qty'),
        r = document.getElementById('q-th-rate');
    if (q) q.textContent = dj ? 'Hours' : 'Qty';
    if (r) r.textContent = dj ? 'Fee (ex GST)' : 'Amount (ex GST)';
}
// the production subtotal, the discount off it, then what production comes to
const isProdDisc = (l) => !!l && l.type === 'discount' && !l.pkgId;
function prodSums() {
    const days = Math.max(1, Math.round(quoteDraft.hire.days || 1));
    const L = quoteDraft.lines;
    const sub = L.filter((l) => !isEntLine(l) && !isProdDisc(l) && l.type !== 'fee').reduce((n, l) => n + quoteLineCents(l, days), 0);
    const off = L.filter(isProdDisc).reduce((n, l) => n + Math.max(0, Math.round(l.amountCents || 0)), 0);
    return { sub, total: Math.max(0, sub - off) };
}
function refreshProdSums() {
    const ps = prodSums();
    document.querySelectorAll('[data-prodsum]').forEach((b) => {
        b.textContent = money(ps[b.dataset.prodsum]);
    });
}
const PROD_HEAD =
    '<div class="qb-thead qb-prodhead"><span class="qb-c-grip"></span><span class="qb-c-desc">Production</span><span class="qb-c-qty">Qty</span><span class="qb-c-rate">Amount (ex GST)</span><span class="qb-c-days">Days</span><span class="qb-c-total">Total (ex GST)</span><span class="qb-c-x"></span></div>';

function renderQuoteLines() {
    const host = document.getElementById('q-lines');
    if (!host) return;
    scheduleQuoteAutosave(); // a line was added, removed or moved (ignored while drawing)
    const days = Math.max(1, Math.round(quoteDraft.hire.days || 1));

    if (!quoteDraft.lines.length) {
        setQuoteHead(false);
        host.innerHTML = '<p class="q-lines-empty">No items yet &mdash; search inventory above, or add a custom item.</p>';
        renderQuoteTotals();
        return;
    }

    sortKitGroups();
    normalizePackages();
    syncCrewRates();
    syncPackageDiscounts();
    const djJob = sortDjSections();
    setQuoteHead(djJob);
    const kitCat = kitCategoryOf();
    const inv = invByIdMap();
    // a Kit / Package tag on a line that is one
    const sysTag = (itemId) => {
        const it = inv[itemId];
        if (!it || !it.isSystem) return '';
        const pkg = it.bundleType === 'package';
        return '<span class="qb-sys-tag qb-sys-line' + (pkg ? ' is-pkg' : '') + '">' + (pkg ? 'Package' : 'Kit') + '</span>';
    };

    /*  SHORT ON STOCK? For this quote's hire dates: what
      other BOOKED jobs (deposit in) already have out, against what this
      quote needs. Pencilled jobs are mentioned but don't count.          */
    const stockWarn = (() => {
        const r = jobRange(quoteDraft);
        if (!r) return () => '';
        const use = stockUsage(state.quoteDocs || [], r[0], r[1], state.openQuoteId);
        const need = {};
        pickItems(quoteDraft.lines).forEach((p) => {
            if (p.itemId) need[p.itemId] = p.qty;
        });
        const dayTxt = r[0] === r[1] ? prettyEventDate(r[0]) : prettyEventDate(r[0]) + ' – ' + prettyEventDate(r[1]);
        return (l) => {
            const it = l.itemId && inv[l.itemId];
            if (!it || it.isSystem || !need[l.itemId]) return '';
            const u = use[l.itemId] || { booked: 0, pencilled: 0 };
            const left = Math.max(0, it.quantityTotal - Math.min(it.quantityRepair || 0, it.quantityTotal) - u.booked);
            if (need[l.itemId] <= left) {
                if (!u.pencilled || need[l.itemId] <= left - u.pencilled) return '';
                return (
                    '<span class="qb-stock is-tight" title="Other quotes not yet paid want some of these too">' +
                    u.pencilled +
                    ' also pencilled in elsewhere</span>'
                );
            }
            return '<span class="qb-stock is-out">&#9888; Only ' + left + ' left ' + esc(dayTxt) + ' (need ' + need[l.itemId] + ')</span>';
        };
    })();

    const rowsHtml = quoteDraft.lines.map((l, i) => {
        if (l.type === 'discount' && l.pkgId) {
            if (!(l.amountCents > 0) && !l.pkgUnpriced) return ''; // nothing off - no line
            return `
        <div class="qb-row qb-row-disc" data-ql="${i}" data-top>
          <div class="qb-cell qb-c-grip"><span class="qb-grip" title="Drag to reorder">&#10303;</span></div>
          <div class="qb-cell qb-c-desc">
            <span class="qb-disc-badge">Package discount</span>
            <span class="qb-pkg-disc">${esc(l.name || 'Package discount')}</span>
            ${l.pkgUnpriced ? '<span class="qb-stock is-tight">This package has no price yet - set one in Inventory</span>' : '<span class="qb-sub">Brings the package down to its package price</span>'}
          </div>
          <div class="qb-cell qb-c-qty">&mdash;</div>
          <div class="qb-cell qb-c-rate">&mdash;</div>
          <div class="qb-cell qb-c-days">&mdash;</div>
          <div class="qb-cell qb-c-total qb-total">&minus;${esc(money(l.amountCents || 0))}</div>
          <div class="qb-cell qb-c-x"><button type="button" class="qb-del" data-ql-del title="Remove">&times;</button></div>
        </div>`;
        }
        if (l.type === 'discount') {
            const val = l.amountCents ? l.amountCents / 100 : '';
            return `
        <div class="qb-row qb-row-disc" data-ql="${i}" data-top>
          <div class="qb-cell qb-c-grip"><span class="qb-grip" title="Drag to reorder">&#10303;</span></div>
          <div class="qb-cell qb-c-desc">
            <span class="qb-disc-badge">${djJob ? 'Production discount' : 'Discount'}</span>
            <input class="qb-name" data-lf="name" value="${attr(l.name)}" placeholder="${djJob ? 'Production package price adjustment' : 'Discount'}">
          </div>
          <div class="qb-cell qb-c-qty">&mdash;</div>
          <div class="qb-cell qb-c-rate">&mdash;</div>
          <div class="qb-cell qb-c-days">&mdash;</div>
          <div class="qb-cell qb-c-total qb-total">&minus;<span class="qb-inline-dollar">$</span><input class="qb-num qb-num-total" type="number" min="0" step="1" data-lf="amountCents" value="${attr(val)}"></div>
          <div class="qb-cell qb-c-x"><button type="button" class="qb-del" data-ql-del title="Remove">&times;</button></div>
        </div>`;
        }

        // Kit / required lines render as a read-only sub-row grouped under the item above.
        if (l.type === 'kit') {
            // a sub-heading each time the category changes (Cable, then Stands...)
            const prev = quoteDraft.lines[i - 1];
            const cat = kitCat(l);
            // a kit's own parts sit straight under it, in Max's order, with no heading
            const sameCat = prev && prev.type === 'kit' && prev.sysOrder == null && kitCat(prev) === cat;
            const header =
                l.sysOrder != null || sameCat
                    ? ''
                    : '<div class="qb-subhead' + (prev && prev.type === 'kit' ? ' qb-subhead-next' : '') + '">' + esc(cat) + '</div>';
            const free = l.charge === 'free' || !l.unitCents;
            return `${header}
        <div class="qb-row qb-row-sub" data-ql="${i}" data-sub>
          <div class="qb-cell qb-c-grip"></div>
          <div class="qb-cell qb-c-desc"><span class="qb-arrow">&#8627;</span><span class="qb-subname">${esc(String(l.name || '').replace(/ \(included\)$/i, ''))}</span>${stockWarn(l)}</div>
          <div class="qb-cell qb-c-qty">${esc(l.qty)}</div>
          <div class="qb-cell qb-c-rate">${free ? '<span class="qb-incl">Included</span>' : money(l.unitCents)}</div>
          <div class="qb-cell qb-c-days">${free ? '&mdash;' : esc(Math.max(1, Math.round(l.days || days)))}</div>
          <div class="qb-cell qb-c-total">${free ? '&mdash;' : money(quoteLineCents(l, days))}</div>
          <div class="qb-cell qb-c-x"><button type="button" class="qb-del" data-ql-del title="Remove">&times;</button></div>
        </div>`;
        }

        // Editable item / custom line.
        // staff show their own day rate (before weekend / holiday loading)
        let rate = l.unitCents ? l.unitCents / 100 : '';
        if (l.resType === 'staff' && l.baseCents != null) rate = l.baseCents / 100;
        return `
      <div class="qb-row" data-ql="${i}" data-top>
        <div class="qb-cell qb-c-grip"><span class="qb-grip" title="Drag to reorder">&#10303;</span></div>
        <div class="qb-cell qb-c-desc${isSmartLine(l) ? ' is-smart' : ''}"${isSmartLine(l) ? ' title="Smart line - filled in per gig"' : ''}>
          <input class="qb-name" data-lf="name" value="${attr(l.name)}" placeholder="Item name">
          ${sysTag(l.itemId)}
          ${l.description || isSmartLine(l) ? `<span class="qb-sub">${esc(l.description || '')}${isSmartLine(l) ? '<span class="qb-smart-note">Smart Calculator</span>' : ''}</span>` : ''}${stockWarn(l)}
        </div>
        <div class="qb-cell qb-c-qty"><input class="qb-num" type="number" min="0" step="${l.perf ? '0.25' : '1'}" data-lf="qty" value="${attr(l.qty)}"${l.perf ? ' title="Hours"' : ''}></div>
        <div class="qb-cell qb-c-rate"><span class="qb-inline-dollar">$</span><input class="qb-num" type="number" min="0" step="1" data-lf="unitCents" value="${attr(rate)}"></div>
        <div class="qb-cell qb-c-days"><input class="qb-num" type="number" min="1" step="1" data-lf="days" value="${attr(Math.max(1, Math.round(l.days || days)))}"></div>
        <div class="qb-cell qb-c-total qb-total"><span class="q-line-total">${esc(money(quoteLineCents(l, days)))}</span></div>
        <div class="qb-cell qb-c-x"><button type="button" class="qb-del" data-ql-del title="Remove">&times;</button></div>
      </div>`;
    });

    // which package (if any) each line sits in - parts follow the line above them
    const L = quoteDraft.lines;
    const pkgOf = [];
    L.forEach((l, i) => {
        pkgOf[i] = l.type === 'kit' ? (i ? pkgOf[i - 1] : null) : l.pkgId || null;
    });
    let html = '';
    const firstProd = djJob ? L.findIndex((l) => !isEntLine(l)) : -1;
    const ps = prodSums();
    const sumRow = (label, cents, k) =>
        '<div class="qb-prodsum is-' + k + '"><span>' + label + '</span><b data-prodsum="' + k + '">' + esc(money(cents)) + '</b></div>';
    for (let i = 0; i < L.length; i++) {
        const id = pkgOf[i];
        if (i === firstProd) html += PROD_HEAD;
        if (djJob && isProdDisc(L[i]) && !isProdDisc(L[i - 1])) html += sumRow('Production subtotal', ps.sub, 'sub');
        if (id && pkgOf[i - 1] !== id) {
            // the package line: name, tag, the package total (gear less its discount), remove-all
            let total = 0;
            let j = i;
            for (; j < L.length && pkgOf[j] === id; j++) {
                const x = L[j];
                if (x.type === 'discount') total -= Math.max(0, Math.round(x.amountCents || 0));
                else total += quoteLineCents(x, days);
            }
            const name =
                (inv[id] && inv[id].name) ||
                String((L.find((x) => x.pkgId === id && x.type === 'discount') || {}).name || 'Package').replace(
                    / - package discount$/,
                    ''
                );
            html += `<div class="qb-pkg">
        <div class="qb-pkg-head">
          <span class="qb-sys-tag is-pkg">Package</span>
          <b>${esc(name)}</b>
          <span class="qb-pkg-total">${esc(money(total))}</span>
          <button type="button" class="qb-del" data-pkg-del="${attr(id)}" title="Remove the whole package">&times;</button>
        </div>
        <div class="qb-pkg-body">`;
        }
        html += rowsHtml[i];
        if (id && pkgOf[i + 1] !== id) html += '</div></div>';
        if (djJob && isProdDisc(L[i]) && !isProdDisc(L[i + 1])) html += sumRow('Production total', ps.total, 'total');
    }
    host.innerHTML = html;
    renderQuoteTotals();
}

/*  COST BREAKDOWN GROUPS - KEEP IN STEP between
    js/site/quote-view.js and js/admin/quotes.js. Inventory category -> group shown
    in the totals ("Audio $180, Staging $180, Lighting $60").            */
const COST_GROUP = {
    audio: 'Audio',
    mixer: 'Audio',
    amp: 'Audio',
    microphone: 'Audio',
    iem: 'Audio',
    di: 'Audio',
    'studio monitor': 'Audio',
    cable: 'Audio',
    stands: 'Audio',
    speaker: 'Audio',
    speakers: 'Audio',
    'mic kit': 'Backline',
    drum: 'Backline',
    drums: 'Backline', // Max's Inventory names
    lighting: 'Lighting',
    truss: 'Lighting',
    stage: 'Staging',
    furniture: 'Staging',
    backline: 'Backline',
    'dj mixer': 'DJ equipment',
    vision: 'Vision',
    power: 'Audio' // power & cables count as Audio
};
const COST_GROUP_ORDER = ['Audio', 'Backline', 'Lighting', 'Staging', 'DJ equipment', 'Vision', 'Other']; // Max's order
function costGroupOf(category) {
    // gear in a category we don't know yet counts as Audio, not "Other"
    return (
        COST_GROUP[
            String(category || '')
                .trim()
                .toLowerCase()
        ] || 'Audio'
    );
}
/*  [{ name, cents }] in the order above, only groups with a cost. */
function costBreakdown(lines, centsOf, categoryOf) {
    const sums = {};
    (lines || []).forEach((l) => {
        if (l.type === 'labour' || l.type === 'delivery' || l.type === 'discount' || l.type === 'fee') return;
        if (l.resType) return; // crew & vehicles have their own subtotal
        if (isEntLine(l)) return; // DJ jobs: the entertainment fee, on its own
        const c = centsOf(l);
        if (!c) return;
        const g = l.itemId ? costGroupOf(categoryOf(l)) : 'Other';
        sums[g] = (sums[g] || 0) + c;
    });
    return COST_GROUP_ORDER.filter((g) => sums[g]).map((g) => ({ name: g, cents: sums[g] }));
}

function renderQuoteTotals() {
    const host = document.getElementById('q-totals');
    if (!host) return;
    syncCrewRates();
    syncPackageDiscounts();
    const m = quoteDraftMoney(quoteDraft);
    const lab = quoteLabour(quoteDraft);
    const discVal = quoteDraft.discountCents ? quoteDraft.discountCents / 100 : '';
    const ph = quoteDraft.labourPH || {};
    const off = quoteDraft.labourOff || {};
    const labourRow = lab.allParts.length
        ? `
    <div class="qb-sumrow qb-sumlabour">
      <span><label class="qb-labtoggle"><input type="checkbox" data-qlabour${quoteDraft.labourExcluded ? '' : ' checked'}> Setup &amp; pack-down</label>
        <em class="qb-labnote">${lab.hours} hr${lab.hours === 1 ? '' : 's'} total</em></span>
      <span class="${quoteDraft.labourExcluded || !lab.cents ? 'qb-laboff' : ''}">${quoteDraft.labourExcluded ? 'excluded' : lab.cents ? esc(money(lab.cents)) : 'off'}</span>
    </div>
    ${
        quoteDraft.labourExcluded
            ? ''
            : lab.allParts
                  .map(
                      (p) => `
    <div class="qb-labpart${off[p.key] ? ' is-off' : ''}">
      <span><label class="qb-labpick"><input type="checkbox" data-qlaboff="${p.key}"${off[p.key] ? '' : ' checked'}> <b>${esc(p.lineName)}</b></label><em>${esc(p.lineDesc)}</em>
        ${p.key === 'pack' && !off.pack ? `<label class="qb-labday">Pack-down day <input type="date" data-qpackdate value="${attr(quoteDraft.labourPackDate || '')}"></label>` : ''}
        ${off[p.key] ? '' : `<label class="qb-labph"><input type="checkbox" data-qlabph="${p.key}"${ph[p.key] ? ' checked' : ''}> Public holiday</label>`}</span>
      <span>${off[p.key] ? 'off' : esc(money(p.cents))}</span>
    </div>`
                  )
                  .join('')
    }`
        : '';
    // crew & vehicles, totted up on their own
    const crewDays = Math.max(1, Math.round(quoteDraft.hire.days || 1));
    const crewSum = (t) => (quoteDraft.lines || []).filter((l) => l.resType === t).reduce((n, l) => n + quoteLineCents(l, crewDays), 0);
    const staffCents = crewSum('staff');
    const vehicleCents = crewSum('vehicle') + crewSum('trailer');
    const entCents = (quoteDraft.lines || []).filter(isEntLine).reduce((n, l) => n + quoteLineCents(l, crewDays), 0);
    const delCents = quoteDeliveryCents(quoteDraft);
    // "Bowen (local)" is free, and says so
    const isLocal = /local/i.test(quoteDraft.deliveryTown || '');
    let deliveryRow = '';
    if (isLocal)
        deliveryRow = `
    <div class="qb-sumrow">
      <span>Local delivery &amp; pickup</span>
      <span class="qb-free">FREE</span>
    </div>`;
    else if (delCents)
        deliveryRow = `
    <div class="qb-sumrow">
      <span>Travel &amp; transport${quoteDraft.deliveryTown ? ' — ' + esc(quoteDraft.deliveryTown) : ''}
        <em class="qb-labnote" style="margin-left:0">Fuel and vehicle running costs · ${quoteDraft.deliveryKm} km each way (${quoteDraft.deliveryKm * 2} km return) @ $0.80/km</em></span>
      <span>${esc(money(delCents))}</span>
    </div>`;
    // 2% booking & admin fee row, with an on/off tick
    const feeRow = `
    <div class="qb-sumrow">
      <span><label class="qb-labtoggle"><input type="checkbox" data-qfee${quoteDraft.feeExcluded ? '' : ' checked'}> Booking &amp; admin fee</label></span>
      <span class="${quoteDraft.feeExcluded ? 'qb-laboff' : ''}">${quoteDraft.feeExcluded ? 'off' : esc(money(m.feeCents))}</span>
    </div>`;
    // performer super row, with an on/off tick
    const superRow =
        m.perfCents > 0
            ? `
    <div class="qb-sumrow">
      <span><label class="qb-labtoggle"><input type="checkbox" data-qsuper${quoteDraft.superExcluded ? '' : ' checked'}> Performer super (${SUPER_PCT}%)</label>
        <em class="qb-labnote" style="margin-left:0">Of the DJ's performance fee - required by law for performers</em></span>
      <span class="${quoteDraft.superExcluded ? 'qb-laboff' : ''}">${quoteDraft.superExcluded ? 'off' : esc(money(m.superCents))}</span>
    </div>`
            : '';
    host.innerHTML = `
    ${(() => {
        const inv = invByIdMap();
        const groups = costBreakdown(
            quoteDraft.lines,
            (l) => quoteLineCents(l, crewDays),
            (l) => (inv[l.itemId] || {}).category
        );
        return (
            (entCents ? '<div class="qb-sumrow"><span>Entertainment fee</span><span>' + esc(money(entCents)) + '</span></div>' : '') +
            (groups.length
                ? '<div class="qb-sumhead">Equipment hire</div>' +
                  groups
                      .map(
                          (g) =>
                              '<div class="qb-sumrow qb-sumsub"><span>' +
                              esc(g.name) +
                              '</span><span>' +
                              esc(money(g.cents)) +
                              '</span></div>'
                      )
                      .join('')
                : '')
        );
    })()}
    <div class="qb-sumrow"><span>Hire subtotal (ex GST)</span><span id="qsum-sub">${esc(money(m.subtotalCents - entCents - staffCents - vehicleCents))}</span></div>
    ${labourRow}
    ${staffCents ? '<div class="qb-sumrow"><span>Crew &amp; operators</span><span>' + esc(money(staffCents)) + '</span></div>' : ''}
    ${vehicleCents ? '<div class="qb-sumrow"><span>Vehicles</span><span>' + esc(money(vehicleCents)) + '</span></div>' : ''}
    ${deliveryRow}
    ${feeRow}
    ${superRow}
    <div class="qb-sumrow qb-sumdisc"><span>Discount</span>
      <span class="qb-discinput">&minus;<span class="qb-inline-dollar">$</span><input class="qb-num qb-num-total" type="number" min="0" step="1" data-qdisc value="${attr(discVal)}" placeholder="0"></span></div>
    <div class="qb-sumrow"><span>GST (10%)</span><span id="qsum-gst">${esc(money(m.gstCents))}</span></div>
    <div class="qb-sumrow qb-sumgrand"><span>Total (incl GST)</span><span id="qsum-total">${esc(money(m.totalCents))}</span></div>`;
}

/*  Update just the computed figures (used while typing in the discount box,
    so the input keeps focus instead of being rebuilt out from under you).  */
function updateQuoteTotalsValues() {
    const m = quoteDraftMoney(quoteDraft);
    const set = (id, v) => {
        const el = document.getElementById(id);
        if (el) el.textContent = v;
    };
    set('qsum-sub', money(m.subtotalCents));
    set('qsum-gst', money(m.gstCents));
    set('qsum-total', money(m.totalCents));
}

function addInvLineToQuote(itemId) {
    const byId = invByIdMap();
    const it = byId[itemId];
    if (!it) return;
    const days = Math.max(1, Math.round(quoteDraft.hire.days || 1));
    if (it.isSystem && it.bundleType === 'package') {
        addPackageToQuote(it, byId, days);
        renderQuoteLines();
        return;
    }

    quoteDraft.lines.push({
        type: 'item',
        itemId: it.id,
        name: it.name,
        description: it.subtitle || '',
        qty: 1,
        unitCents: it.priceCents || 0,
        days
    });

    // Auto-add the required kit for one of these.
    quoteDraft.lines.push(...kitLinesFor(it.id, 1, byId, days));

    renderQuoteLines();
}

/*  A PACKAGE on a quote is ITEMISED: each kit and single
    item gets its own priced line (kit parts underneath as Included), in
    Max's order, then ONE "package discount" line takes the total down to the
    package price. Every line carries pkgId so the discount can follow along
    when quantities or hire days change (syncPackageDiscounts).            */
function addPackageToQuote(pkg, byId, days) {
    const eff = {};
    (pkg.requirements || []).forEach((r) => {
        if (r && r.itemId) eff[r.itemId] = (eff[r.itemId] || 0) + Math.max(0, Math.round(r.qty || 0));
    });
    const order = [];
    (pkg.systemParts && pkg.systemParts.length ? pkg.systemParts : pkg.requirements || []).forEach((p) => {
        if (p && eff[p.itemId] && !order.includes(p.itemId)) order.push(p.itemId);
    });
    Object.keys(eff).forEach((id) => {
        if (!order.includes(id)) order.push(id);
    });
    order.forEach((id) => {
        const it = byId[id];
        if (!it || !eff[id]) return;
        quoteDraft.lines.push({
            type: 'item',
            itemId: id,
            name: it.name,
            description: it.subtitle || '',
            qty: eff[id],
            unitCents: it.priceCents || 0,
            days,
            pkgId: pkg.id
        });
        quoteDraft.lines.push(...kitLinesFor(id, eff[id], byId, days));
    });
    // crew in the package (Audio Operator...) - their own lines, under Crew & operators
    (pkg.systemParts || [])
        .filter((p) => p && p.resourceId)
        .forEach((p) => {
            const r =
                (state.resources || []).find((x) => x.id === p.resourceId) ||
                (pkg.crewParts || []).find((x) => x.resourceId === p.resourceId) ||
                {};
            const type = ['staff', 'vehicle', 'trailer'].includes(r.type) ? r.type : 'staff';
            quoteDraft.lines.push({
                type: 'custom',
                name: r.name || 'Crew',
                qty: Math.max(1, p.qty || 1),
                unitCents: r.dayRateCents || 0,
                days,
                resourceId: p.resourceId,
                resType: type,
                pkgId: pkg.id
            });
        });
    quoteDraft.lines.push({ type: 'discount', name: (pkg.name || 'Package') + ' - package discount', amountCents: 0, pkgId: pkg.id });
    syncPackageDiscounts();
}

/*  Each staff crew line priced day by day from the hire start: its own rate
    (baseCents) x that day's loading. Description says what was added.     */
function crewRateFor(base, days, startIso, town) {
    let total = 0;
    const notes = {};
    for (let d = 0; d < days; d++) {
        let iso = '';
        if (isoOk(startIso)) {
            const [y, m, dd] = startIso.split('-').map(Number);
            iso = new Date(Date.UTC(y, m - 1, dd + d)).toISOString().slice(0, 10);
        }
        const r = labourDayRate(iso, town, false);
        total += Math.round(base * r.mult);
        if (r.mult !== 1) {
            const key = Math.round((r.mult - 1) * 100) + '% ' + r.label;
            notes[key] = (notes[key] || 0) + 1;
        }
    }
    const note = Object.keys(notes)
        .map((k) => '+' + k + (days > 1 ? ' (' + notes[k] + ' day' + (notes[k] === 1 ? '' : 's') + ')' : ''))
        .join(', ');
    return { total, note };
}
function syncCrewRates() {
    const days0 = Math.max(1, Math.round(quoteDraft.hire.days || 1));
    const town = quoteDraft.deliveryTown && quoteDraft.deliveryTown !== 'Other' ? quoteDraft.deliveryTown : '';
    (quoteDraft.lines || []).forEach((l) => {
        if (l.resType !== 'staff') return;
        if (l.baseCents == null) l.baseCents = Math.max(0, Math.round(l.unitCents || 0));
        const days = Math.max(1, Math.round(l.days || days0));
        const r = crewRateFor(l.baseCents, days, quoteDraft.hire.startDate, town);
        l.unitCents = Math.round(r.total / days);
        l.description = r.note ? '$' + l.baseCents / 100 + '/day ' + r.note : '';
    });
}

/*  Work each package discount out again: everything in that package at full
    price, less the package price (per day x hire days).                    */
function syncPackageDiscounts() {
    const L = quoteDraft.lines || [];
    if (!L.some((l) => l.type === 'discount' && l.pkgId)) return;
    const byId = invByIdMap();
    const days = Math.max(1, Math.round(quoteDraft.hire.days || 1));
    const full = {};
    const extra = {}; // weekend / public holiday surcharges on crew in the package
    let cur = null; // the package the current item (and its kit lines) belongs to
    L.forEach((l) => {
        if (l.type === 'item' || l.type === 'custom') cur = l.pkgId || null;
        else if (l.type !== 'kit') cur = null;
        if (cur && (l.type === 'item' || l.type === 'kit' || l.type === 'custom')) full[cur] = (full[cur] || 0) + quoteLineCents(l, days);
        if (cur && l.resType === 'staff' && l.baseCents != null) {
            const ld = Math.max(1, Math.round(l.days || days));
            extra[cur] = (extra[cur] || 0) + Math.max(0, quoteLineCents(l, days) - l.baseCents * Math.max(0, Math.round(l.qty || 0)) * ld);
        }
    });
    L.forEach((l) => {
        if (l.type !== 'discount' || !l.pkgId) return;
        const pkg = byId[l.pkgId];
        const base = Math.max(0, Math.round((pkg && pkg.priceCents) || 0)) * days;
        // operator surcharges go ON TOP of the package price, never swallowed by the discount
        const target = base > 0 ? base + (extra[l.pkgId] || 0) : 0;
        l.amountCents = target > 0 ? Math.max(0, (full[l.pkgId] || 0) - target) : 0;
        l.pkgUnpriced = !(base > 0);
    });
}

/*  The included / required lines for qty of one item (via js/admin/kit.js). */
function kitLinesFor(itemId, qty, byId, days) {
    if (!qty) return [];
    const kit = expandKit({ [itemId]: qty }, byId);
    // A SYSTEM keeps the parts in the order Max set in the System builder;
    // anything they bring along (leads, stands) follows, A-Z.
    const parent = byId[itemId];
    const order = {};
    let n = 0;
    const partsOf = (x) => (x.systemParts && x.systemParts.length ? x.systemParts : x.requirements || []);
    // walk in Max's order; a kit inside a package is followed straight away by its own parts
    const walk = (x, depth) => {
        partsOf(x).forEach((p) => {
            if (!p || !p.itemId || order[p.itemId] != null) return;
            order[p.itemId] = n++;
            const child = byId[p.itemId];
            if (child && child.isSystem && depth < 3) walk(child, depth + 1);
        });
    };
    if (parent && parent.isSystem) walk(parent, 0);
    return kit.required.map((r) => {
        const charged = r.charge === 'normal';
        const line = {
            type: 'kit',
            itemId: r.itemId,
            name: r.name, // no "(included)" - the Included column says it
            qty: r.qty,
            unitCents: charged ? r.unitCents : 0,
            charge: r.charge,
            days: charged ? days : 1
        };
        if (order[r.itemId] != null) line.sysOrder = order[r.itemId];
        return line;
    });
}

/*  Opening a quote re-works every item's included gear from its current
    qty, so older quotes correct themselves. */
function rebuildAllKits() {
    const byId = invByIdMap();
    for (let i = 0; i < quoteDraft.lines.length; i++) {
        if (quoteDraft.lines[i].type === 'item') rebuildKitForLine(i, byId);
    }
}

/*  An item's quantity changed: re-work its included / required lines so
    3 Stage Decks bring 12 legs. Replaces the kit rows directly under it. */
function rebuildKitForLine(i, byId = invByIdMap()) {
    const line = quoteDraft.lines[i];
    if (!line || line.type !== 'item' || !line.itemId) return false;
    if (!byId[line.itemId]) return false;
    let end = i + 1;
    while (end < quoteDraft.lines.length && quoteDraft.lines[end].type === 'kit') end++;
    const days = Math.max(1, Math.round(quoteDraft.hire.days || 1));
    const gone = new Set(line.removedParts || []); // parts Max took off this line
    quoteDraft.lines.splice(
        i + 1,
        end - (i + 1),
        ...kitLinesFor(line.itemId, Math.max(0, Math.round(line.qty || 0)), byId, days).filter((k) => !gone.has(k.itemId))
    );
    return true;
}

/* -------------------------------------------------------------------------
   Inventory typeahead - the pinned bottom "add" row
   ------------------------------------------------------------------------- */
function invSearchList() {
    return invItems().filter((it) => it.id && it.name);
}

/* -------------------------------------------------------------------------
   ONE SEARCH ENGINE for every search box in the admin.
   - Every word you type must appear somewhere, in any order:
     "deck stage" finds "Stage Deck".
   - Best matches first: the name starts with what you typed, then a word in
     the name starts with it, then the name contains it, then it's only in
     the other details (category, notes, email...).
   ------------------------------------------------------------------------- */
function searchWords(term) {
    return String(term || '')
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
}

/*  Does this item match? name + any other text parts. */
function searchMatch(term, name, ...more) {
    const words = searchWords(term);
    if (!words.length) return true;
    const hay = [name, ...more].filter(Boolean).join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
}

/*  Lower = better. Used to put the best matches at the top. */
function searchScore(term, name) {
    const t = String(term || '')
        .trim()
        .toLowerCase();
    const n = String(name || '').toLowerCase();
    if (!t) return 9;
    if (n.startsWith(t)) return 0;
    if (n.split(/[^a-z0-9]+/).some((w) => w.startsWith(searchWords(t)[0] || t))) return 1;
    if (n.includes(t)) return 2;
    return 3;
}

/*  Filter + rank a list. nameOf(item) gives the main name, moreOf(item) the
    other searchable text. limit = 0 for no limit.                         */
function searchList(list, term, nameOf, moreOf, limit) {
    const out = list
        .filter((it) => searchMatch(term, nameOf(it), ...(moreOf ? moreOf(it) : [])))
        .map((it) => ({ it, sc: searchScore(term, nameOf(it)) }))
        .sort(
            (a, b) =>
                a.sc - b.sc ||
                String(nameOf(a.it) || '').length - String(nameOf(b.it) || '').length || // equal match: shorter name first
                String(nameOf(a.it) || '').localeCompare(String(nameOf(b.it) || ''), undefined, { numeric: true, sensitivity: 'base' })
        )
        .map((x) => x.it);
    return limit ? out.slice(0, limit) : out;
}

let invSearchActive = -1; // keyboard-highlighted result

/*  THE DJ BOOKING FEE in the add-search: type "booking",
    "fee", "coordination"... and it's there to drop into a template or quote.
    Same name, wording and amount as the setting on Entertainment.        */
function djFeeItem() {
    const f = state.djFee || {};
    const pct = f.mode === 'percent';
    const name = f.name || 'Booking & management';
    return {
        id: '__djfee',
        kind: 'djfee',
        name,
        sub: 'DJ booking fee',
        priceCents: pct ? 0 : Number.isFinite(f.cents) ? f.cents : 8000,
        pctLabel: pct ? (Number.isFinite(f.pct) ? f.pct : 15) + '% of DJ' : '',
        description: f.description == null ? 'Sourcing, scheduling and managing your DJ, with backup cover' : f.description
    };
}
/*  Matches for the quote add-search: inventory + active crew/vehicles. */
function quoteSearchMatches(term) {
    const t = String(term || '')
        .trim()
        .toLowerCase();
    if (!t) return [];
    if (state.djFee === undefined && !state.djFeeLoading) {
        // not loaded yet (Entertainment not opened) - fetch once
        state.djFeeLoading = true;
        fb.f
            .getDocs(fb.f.collection(fb.db, 'djSettings'))
            .then((s) => {
                state.djFee = {};
                s.forEach((d) => {
                    if (d.id === 'fee') state.djFee = d.data();
                });
            })
            .catch(() => {
                state.djFee = {};
            });
    }
    /*  FILL-IN LINES for DJ templates: the booking swaps
      them for the real DJ + price, their travel, and the fee.          */
    const fee = djFeeItem();
    const slots = [
        {
            id: '__djslot',
            kind: 'djfee',
            slot: 'dj',
            name: 'DJ / Entertainer',
            sub: 'Filled in per booking',
            priceCents: 0,
            pctLabel: 'DJ + their price',
            description: 'Filled in per booking: the DJ, their hours and price',
            words: 'dj entertainer entertainment act performance'
        },
        {
            id: '__djtravel',
            kind: 'djfee',
            slot: 'travel',
            name: 'DJ travel',
            sub: 'Filled in per booking',
            priceCents: 0,
            pctLabel: 'Their travel fee',
            description: 'Filled in per booking: left off if the DJ is local',
            words: 'dj travel'
        },
        {
            id: '__djaccom',
            kind: 'djfee',
            slot: 'accom',
            name: 'Accommodation',
            sub: 'Filled in per booking',
            priceCents: 0,
            pctLabel: 'Venue provides',
            description: 'Filled in per booking: left off if the DJ is local or driving home',
            words: 'accommodation accomodation hotel stay room'
        },
        { ...fee, slot: 'fee', words: 'dj booking fee management coordination backup' }
    ];
    const feeHit = slots.filter((x) => searchMatch(t, x.name, x.words));
    const hits = searchList(
        quoteAddSearchList(),
        t,
        (it) => it.name,
        (it) => [it.sub],
        8 - feeHit.length
    );
    return feeHit.concat(
        hits
            .filter((x) => x.bundle === 'package')
            .concat(
                hits.filter((x) => x.system && x.bundle !== 'package'),
                hits.filter((x) => !x.system)
            )
    ); // systems first
}

function renderInvResults(term) {
    const box = document.getElementById('q-inv-results');
    if (!box) return [];
    const t = String(term || '')
        .trim()
        .toLowerCase();
    if (!t) {
        box.hidden = true;
        box.innerHTML = '';
        invSearchActive = -1;
        return [];
    }
    const matches = quoteSearchMatches(term);
    if (!matches.length) {
        box.hidden = false;
        box.innerHTML = '<div class="qb-res-empty">No match in inventory or crew</div>';
        invSearchActive = -1;
        return [];
    }
    box.hidden = false;
    box.innerHTML = matches
        .map(
            (it, i) => `
    <div class="qb-res${i === invSearchActive ? ' is-active' : ''}" data-add="${attr(it.id)}" data-kind="${attr(it.kind)}">
      <span class="qb-res-name">${it.kind === 'djfee' ? '<span class="qb-sys-tag is-pkg">' + (it.slot === 'fee' ? 'DJ fee' : 'Fill-in') + '</span>' : ''}${it.system ? '<span class="qb-sys-tag' + (it.bundle === 'package' ? ' is-pkg' : '') + '">' + (it.bundle === 'package' ? 'Package' : 'Kit') + '</span>' : ''}${esc(it.name)}${it.kind === 'resource' ? ` <span class="qb-res-tag">${esc(it.sub)}</span>` : ''}</span>
      <span class="qb-res-price">${it.kind === 'djfee' ? esc(it.slot === 'fee' ? (it.pctLabel || money(it.priceCents)) + ' per booking' : it.pctLabel) : esc(money(it.priceCents)) + '/day'}</span>
    </div>`
        )
        .join('');
    return matches;
}

function wireInvTypeahead() {
    const input = document.getElementById('q-inv-search');
    const box = document.getElementById('q-inv-results');
    if (!input || !box) return;

    const add = (id) => {
        if (!id) return;
        const pick =
            String(id).indexOf('__dj') === 0
                ? quoteSearchMatches(input.value).find((x) => x.id === id)
                : quoteAddSearchList().find((x) => x.id === id);
        if (pick && pick.kind === 'djfee') {
            // a fill-in line: on gig quotes the server swaps it for the real thing per booking
            const desc =
                pick.slot === 'fee' && pick.pctLabel ? pick.pctLabel + "'s performance - worked out per booking" : pick.description;
            quoteDraft.lines.push({
                type: 'custom',
                name: pick.name,
                description: desc,
                qty: 1,
                unitCents: pick.priceCents,
                days: 1,
                pubDj: true,
                noPick: true,
                djSlot: pick.slot
            });
            renderQuoteLines();
        } else if (pick && pick.kind === 'resource') addResourceLineToQuote(pick);
        else addInvLineToQuote(id);
        input.value = '';
        box.hidden = true;
        box.innerHTML = '';
        invSearchActive = -1;
        input.focus();
    };

    input.addEventListener('input', () => {
        invSearchActive = -1;
        renderInvResults(input.value);
    });
    input.addEventListener('focus', () => {
        if (input.value.trim()) renderInvResults(input.value);
    });
    input.addEventListener('keydown', (e) => {
        const matches = quoteSearchMatches(input.value);
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            invSearchActive = Math.min(matches.length - 1, invSearchActive + 1);
            renderInvResults(input.value);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            invSearchActive = Math.max(0, invSearchActive - 1);
            renderInvResults(input.value);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const pick = matches[invSearchActive] || matches[0];
            if (pick) add(pick.id);
        } else if (e.key === 'Escape') {
            box.hidden = true;
            invSearchActive = -1;
        }
    });
    // mousedown (not click) so it fires before the input's blur hides the list
    box.addEventListener('mousedown', (e) => {
        const r = e.target.closest('[data-add]');
        if (!r) return;
        e.preventDefault();
        add(r.getAttribute('data-add'));
    });
    input.addEventListener('blur', () => {
        setTimeout(() => {
            box.hidden = true;
        }, 150);
    });
}

/* -------------------------------------------------------------------------
   Reordering - each item plus its included/required rows moves as one group
   ------------------------------------------------------------------------- */
function quoteGroups() {
    const groups = [];
    let cur = null;
    quoteDraft.lines.forEach((l, idx) => {
        if (l.type === 'kit' && cur) {
            cur.lines.push(l);
        } else {
            cur = { start: idx, lines: [l] };
            groups.push(cur);
        }
    });
    return groups;
}

function groupIndexOfLine(idx) {
    const g = quoteGroups();
    for (let i = 0; i < g.length; i++) {
        const s = g[i].start;
        if (idx >= s && idx < s + g[i].lines.length) return i;
    }
    return -1;
}

function moveLineGroup(fromLine, overLine, after) {
    const groups = quoteGroups();
    const fromG = groupIndexOfLine(fromLine);
    let toG = groupIndexOfLine(overLine);
    if (fromG < 0 || toG < 0 || fromG === toG) return;
    const moved = groups.splice(fromG, 1)[0];
    if (fromG < toG) toG -= 1; // indices shift after removal
    let insert = toG + (after ? 1 : 0);
    insert = Math.max(0, Math.min(groups.length, insert));
    groups.splice(insert, 0, moved);
    quoteDraft.lines = groups.reduce((acc, gr) => acc.concat(gr.lines), []);
    renderQuoteLines();
}

function wireQuoteDrag(lines) {
    if (!lines) return;
    let fromLine = null;
    const clearMarks = () =>
        lines.querySelectorAll('.qb-drop-before, .qb-drop-after').forEach((el) => el.classList.remove('qb-drop-before', 'qb-drop-after'));
    const dropInfo = (e) => {
        const row = e.target.closest('[data-ql]');
        if (!row) return null;
        const r = row.getBoundingClientRect();
        return { row, line: Number(row.getAttribute('data-ql')), after: e.clientY - r.top > r.height / 2 };
    };

    // arm dragging only when the grab starts on a grip
    lines.addEventListener('mousedown', (e) => {
        const g = e.target.closest('.qb-grip');
        if (!g) return;
        const row = g.closest('[data-ql]');
        if (row && row.hasAttribute('data-top')) row.setAttribute('draggable', 'true');
    });
    lines.addEventListener('mouseup', () => {
        lines.querySelectorAll('[draggable="true"]').forEach((el) => el.removeAttribute('draggable'));
    });

    lines.addEventListener('dragstart', (e) => {
        const row = e.target.closest('[data-ql]');
        if (!row || !row.hasAttribute('data-top') || row.getAttribute('draggable') !== 'true') {
            e.preventDefault();
            return;
        }
        fromLine = Number(row.getAttribute('data-ql'));
        row.classList.add('qb-dragging');
        e.dataTransfer.effectAllowed = 'move';
        try {
            e.dataTransfer.setData('text/plain', String(fromLine));
        } catch (_) {}
    });
    lines.addEventListener('dragover', (e) => {
        if (fromLine == null) return;
        e.preventDefault();
        clearMarks();
        const info = dropInfo(e);
        if (info) info.row.classList.add(info.after ? 'qb-drop-after' : 'qb-drop-before');
    });
    lines.addEventListener('drop', (e) => {
        if (fromLine == null) return;
        e.preventDefault();
        const info = dropInfo(e);
        const from = fromLine;
        fromLine = null;
        clearMarks();
        if (info) moveLineGroup(from, info.line, info.after);
    });
    lines.addEventListener('dragend', () => {
        fromLine = null;
        clearMarks();
        lines.querySelectorAll('[draggable="true"]').forEach((el) => el.removeAttribute('draggable'));
        lines.querySelectorAll('.qb-dragging').forEach((el) => el.classList.remove('qb-dragging'));
    });
}

function wireQuoteBuilder() {
    // BACK TO ALL QUOTES - wired first so nothing below can stop it working,
    // and it never waits more than 3s on the auto-save
    const back = document.getElementById('q-back');
    if (back)
        back.addEventListener('click', () => {
            back.disabled = true;
            location.hash = '#/quoteDocs'; // the router saves anything pending, then shows the list
        });

    qAutoReady = false; // drawing the quote is not a change
    renderQuoteLines();
    wireQuoteCustSearch();

    const wrap = document.querySelector('.q-build');
    if (!wrap) return;

    // the billing CC email chips
    const field = 'ccEmail';
    const ccBox = document.getElementById('qb-cc');
    if (ccBox) {
        const ccSet = (list, keepFocus) => {
            quoteDraft.customer[field] = list.join(', ');
            ccBox.innerHTML = ccChipsInner(quoteDraft.customer[field], 'Accounts email (optional) - press Enter');
            if (keepFocus) ccBox.querySelector('.qb-cc-in').focus();
            scheduleQuoteAutosave();
        };
        const ccAdd = (input, keepFocus) => {
            const typed = ccList(input.value);
            if (!typed.length) return;
            const bad = typed.filter((x) => !CC_RE.test(x));
            if (bad.length) {
                const msg = ccBox.querySelector('.qb-cc-msg');
                if (msg) {
                    msg.hidden = false;
                    msg.textContent = '"' + bad.join(', ') + '" doesn\'t look like an email address.';
                }
                return;
            }
            const have = ccList(quoteDraft.customer[field]);
            typed.forEach((x) => {
                if (!have.some((h) => h.toLowerCase() === x.toLowerCase())) have.push(x);
            });
            ccSet(have, keepFocus);
        };
        ccBox.addEventListener('click', (e) => {
            const del = e.target.closest('[data-cc-del]');
            if (del) {
                const list = ccList(quoteDraft.customer[field]);
                list.splice(Number(del.getAttribute('data-cc-del')), 1);
                ccSet(list, true);
                return;
            }
            const inp = ccBox.querySelector('.qb-cc-in');
            if (inp && e.target === ccBox) inp.focus();
        });
        ccBox.addEventListener('keydown', (e) => {
            if (!e.target.classList.contains('qb-cc-in')) return;
            if (e.key === 'Enter' || e.key === ',' || e.key === ';' || (e.key === 'Tab' && e.target.value.trim())) {
                e.preventDefault();
                ccAdd(e.target, true);
            } else if (e.key === 'Backspace' && !e.target.value) {
                const list = ccList(quoteDraft.customer[field]);
                if (list.length) {
                    list.pop();
                    ccSet(list, true);
                }
            }
        });
        ccBox.addEventListener('paste', (e) => {
            if (!e.target.classList.contains('qb-cc-in')) return;
            setTimeout(() => ccAdd(e.target, true), 0);
        });
        ccBox.addEventListener('focusout', (e) => {
            if (e.target.classList.contains('qb-cc-in') && e.target.value.trim()) ccAdd(e.target, false);
        });
    }

    // customer / hire / meta fields
    wrap.addEventListener('input', (e) => {
        const t = e.target;
        if (t.dataset.qc) {
            quoteDraft.customer[t.dataset.qc] = t.value;
            if (t.dataset.qc === 'eventType') render();
            return;
        }
        if (t.hasAttribute('data-qtpl')) {
            quoteDraft.isTemplate = t.checked;
            scheduleQuoteAutosave();
            render();
            return;
        }
        if (t.hasAttribute('data-qtplname')) {
            quoteDraft.templateName = t.value;
            scheduleQuoteAutosave();
            return;
        }
        // event date calendar: saved as "Tue 20 Oct 2026"
        if (t.hasAttribute('data-qevdate')) {
            quoteDraft.customer.eventDate = prettyEventDate(t.value);
            return;
        }
        if (t.dataset.qmeta) {
            quoteDraft[t.dataset.qmeta] = t.value;
            return;
        }
        if (t.hasAttribute('data-qdisc')) {
            quoteDraft.discountCents = toCents(t.value);
            updateQuoteTotalsValues();
            return;
        }
        if (t.hasAttribute('data-qfee')) {
            quoteDraft.feeExcluded = !t.checked;
            renderQuoteTotals();
            return;
        }
        if (t.hasAttribute('data-qsuper')) {
            // performer super on / off
            quoteDraft.superExcluded = !t.checked;
            renderQuoteTotals();
            return;
        }
        if (t.hasAttribute('data-qlaboff')) {
            // setup / pack-down on or off
            quoteDraft.labourOff = { ...(quoteDraft.labourOff || {}), [t.getAttribute('data-qlaboff')]: !t.checked };
            renderQuoteTotals();
            return;
        }
        if (t.hasAttribute('data-qpackdate')) {
            // pack-down on its own day
            quoteDraft.labourPackDate = t.value || '';
            renderQuoteTotals();
            return;
        }
        if (t.hasAttribute('data-qlabph')) {
            quoteDraft.labourPH = { ...(quoteDraft.labourPH || {}), [t.getAttribute('data-qlabph')]: t.checked };
            renderQuoteTotals();
            return;
        }
        if (t.hasAttribute('data-qlabour')) {
            quoteDraft.labourExcluded = !t.checked;
            renderQuoteTotals(); // rebuild so the labour row & total reflect it
            return;
        }
        if (t.hasAttribute('data-qdel-town')) {
            const v = t.value;
            if (v === '__pickup__') {
                quoteDraft.deliveryTown = '';
                quoteDraft.deliveryKm = 0;
            } else if (v === '__other__') {
                quoteDraft.deliveryTown = 'Other';
            } else {
                const opt = t.selectedOptions && t.selectedOptions[0];
                quoteDraft.deliveryTown = opt ? opt.getAttribute('data-town') || '' : '';
                quoteDraft.deliveryKm = Math.max(0, Math.round(Number(v) || 0));
            }
            render(); // toggles the "Other km" field + updates totals
            return;
        }
        if (t.hasAttribute('data-qdel-km')) {
            quoteDraft.deliveryKm = Math.max(0, Math.round(Number(t.value || 0)));
            renderQuoteTotals();
            return;
        }
        if (t.dataset.qh) {
            if (t.dataset.qh === 'days') quoteDraft.hire.days = Math.max(1, Math.round(Number(t.value) || 1));
            else {
                const oldStart = quoteDraft.hire.startDate;
                quoteDraft.hire[t.dataset.qh] = t.value;
                // Event date follows the first hire day until you type your own
                if (t.dataset.qh === 'startDate') {
                    const cur = String(quoteDraft.customer.eventDate || '').trim();
                    if (!cur || cur === quoteEventDateAuto || cur === prettyEventDate(oldStart)) {
                        quoteEventDateAuto = prettyEventDate(t.value);
                        quoteDraft.customer.eventDate = quoteEventDateAuto;
                        const ed = wrap.querySelector('[data-qevdate]');
                        if (ed) ed.value = t.value;
                    }
                }
                const d = daysBetween(quoteDraft.hire.startDate, quoteDraft.hire.endDate);
                if (d) {
                    quoteDraft.hire.days = d;
                    const di = wrap.querySelector('[data-qh="days"]');
                    if (di) di.value = d;
                }
            }
            renderQuoteLines(); // days affect multi-day line totals
            return;
        }
        // line fields
        const line = t.closest('[data-ql]');
        if (line && t.dataset.lf) {
            const i = Number(line.getAttribute('data-ql'));
            const l = quoteDraft.lines[i];
            if (!l) return;
            const f = t.dataset.lf;
            if (f === 'unitCents' && l.resType === 'staff') {
                l.baseCents = toCents(t.value);
                syncCrewRates();
            } // crew: their own rate, surcharges added on top
            else if (f === 'amountCents' || f === 'unitCents' || f === 'extraDayCents') l[f] = toCents(t.value);
            else if (f === 'qty') l.qty = Math.max(0, l.perf ? Math.round(Number(t.value || 0) * 4) / 4 : Math.round(Number(t.value || 0)));
            else if (f === 'days') l.days = Math.max(1, Math.round(Number(t.value || 1)));
            else l[f] = t.value;
            // update just this line's total + the grand totals, without a full re-render
            const tot = line.querySelector('.q-line-total');
            if (tot) tot.textContent = money(quoteLineCents(l, Math.max(1, Math.round(quoteDraft.hire.days || 1))));
            refreshProdSums();
            renderQuoteTotals();
        }
    });

    // add buttons
    const days0 = () => Math.max(1, Math.round(quoteDraft.hire.days || 1));
    const addCustom = document.getElementById('q-add-custom');
    if (addCustom)
        addCustom.addEventListener('click', () => {
            quoteDraft.lines.push({ type: 'custom', name: '', qty: 1, unitCents: 0, days: days0() });
            renderQuoteLines();
        });
    // Event type "Custom photo": pick a file or Ctrl+V
    const poster = document.getElementById('q-poster');
    if (poster)
        poster.addEventListener('change', () => {
            if (poster.files && poster.files[0]) uploadQuotePoster(poster.files[0]);
        });
    if (!window.__posterPasteWired) {
        window.__posterPasteWired = true;
        document.addEventListener('paste', (e) => {
            if (!document.getElementById('q-poster')) return;
            const it = [...((e.clipboardData && e.clipboardData.items) || [])].find((x) => x.type && x.type.startsWith('image/'));
            const file = it && it.getAsFile();
            if (file) {
                e.preventDefault();
                uploadQuotePoster(file);
            }
        });
    }

    // copy another quote's or template's lines onto the end of this one
    const copyFrom = document.getElementById('q-copyfrom');
    if (copyFrom)
        copyFrom.addEventListener('change', () => {
            const src = (state.quoteDocs || []).find((q) => q.id === copyFrom.value);
            copyFrom.value = '';
            if (!src) return;
            quoteFromDoc(src).lines.forEach((l) =>
                quoteDraft.lines.push(l.days != null && l.type !== 'discount' ? { ...l, days: days0() } : l)
            );
            rebuildAllKits();
            renderQuoteLines();
            scheduleQuoteAutosave();
        });
    const addDisc = document.getElementById('q-add-disc');
    if (addDisc)
        addDisc.addEventListener('click', () => {
            quoteDraft.lines.push({ type: 'discount', name: '', amountCents: 0 });
            renderQuoteLines();
        });

    // inventory typeahead (top 3 as you type)
    wireInvTypeahead();

    // remove line
    const lines = document.getElementById('q-lines');
    if (lines)
        lines.addEventListener('click', (e) => {
            const pdel = e.target.closest('[data-pkg-del]');
            if (pdel) {
                const id = pdel.getAttribute('data-pkg-del');
                quoteDraft.lines = quoteUnits(quoteDraft.lines)
                    .filter((u) => u[0].pkgId !== id)
                    .flat();
                renderQuoteLines();
                return;
            }
            const del = e.target.closest('[data-ql-del]');
            if (!del) return;
            const i = Number(del.closest('[data-ql]').getAttribute('data-ql'));
            const L = quoteDraft.lines;
            const line = L[i];
            if (!line) return;
            if (line.accom) quoteDraft.accomOff = true; // stays off when the gig quote is rebuilt
            if (line.type === 'kit') {
                // one part: remember it on the line it belongs to, so it stays removed
                let p = i - 1;
                while (p >= 0 && L[p].type === 'kit') p--;
                if (p >= 0 && L[p].itemId && line.itemId) {
                    L[p].removedParts = [...new Set([...(L[p].removedParts || []), line.itemId])];
                }
                L.splice(i, 1);
            } else {
                // the kit / item itself: take its included parts with it
                let end = i + 1;
                while (end < L.length && L[end].type === 'kit') end++;
                L.splice(i, end - i);
                // last thing from a package gone? its package discount line goes too
                if (line.pkgId && !L.some((x) => x.pkgId === line.pkgId && x.type !== 'discount')) {
                    const d = L.findIndex((x) => x.type === 'discount' && x.pkgId === line.pkgId);
                    if (d >= 0) L.splice(d, 1);
                }
            }
            renderQuoteLines();
        });

    // drag to reorder (grip handle). An item drags together with its
    // included/required sub-rows as one group.
    wireQuoteDrag(lines);

    const save = document.getElementById('q-save');
    if (save)
        save.addEventListener('click', () => {
            clearTimeout(qAutoTimer);
            qAutoTimer = null;
            saveQuoteDoc(save);
        });

    // auto-save: any typing in the quote (not the two search boxes) or any line change
    wrap.addEventListener('input', (e) => {
        if (!e.target.closest('#q-inv-search, #qb-cust-input')) scheduleQuoteAutosave();
    });
    wrap.addEventListener('change', (e) => {
        const t = e.target;
        if (t.dataset && t.dataset.lf === 'qty') {
            const row = t.closest('[data-ql]');
            if (row) {
                rebuildKitForLine(Number(row.getAttribute('data-ql')));
                renderQuoteLines();
            } // also re-checks stock
        }
        if (!t.closest('#q-inv-search, #qb-cust-input')) scheduleQuoteAutosave();
    });
    qAutoReady = true;
    quoteHistoryBaseline();

    wireQuoteActions();
}

function wireQuoteActions() {
    const msg = () => document.getElementById('q-msg');
    const run = async (name, data, ok) => {
        const m = msg();
        setMsg(m, 'Working…', '');
        try {
            const res = await call(name, data);
            setMsg(m, ok || 'Done.', 'is-ok');
            return res;
        } catch (err) {
            setMsg(m, err.message || 'Failed.', 'is-bad');
            throw err;
        }
    };

    // APPROVE: the estimate becomes a quote, ready to send to the customer
    const approve = document.getElementById('q-approve');
    if (approve)
        approve.addEventListener('click', async () => {
            await saveQuoteDoc(approve, true);
            if (state.openQuoteId === '__new__') return;
            try {
                await run(
                    'adminSetQuoteStatus',
                    { id: state.openQuoteId, status: 'approved' },
                    'Approved - now a quote. Hit Send when ready.'
                );
                render();
            } catch (e) {
                /* message shown */
            }
        });

    const send = document.getElementById('q-send');
    if (send)
        send.addEventListener('click', async () => {
            await saveQuoteDoc(send, true);
            if (state.openQuoteId === '__new__') return;
            try {
                const res = await run('adminSendQuote', { id: state.openQuoteId }, 'Sent to the customer.');
                if (res && !res.sent) setMsg(msg(), 'Not sent: ' + (res.error || res.reason || 'unknown'), 'is-bad');
                render();
            } catch (e) {
                /* message shown */
            }
        });

    // a button that moves the quote to a status, then redraws
    const statusButton = (elId, status, ok) => {
        const btn = document.getElementById(elId);
        if (!btn) return;
        btn.addEventListener('click', async () => {
            try {
                await run('adminSetQuoteStatus', { id: state.openQuoteId, status }, ok);
                render();
            } catch (e) {
                /* message shown */
            }
        });
    };
    statusButton('q-accept', 'accepted', 'Accepted - now an invoice.');

    // UNDO ACCEPT: puts the quote back to "sent" so the customer can accept again
    // (e.g. a test click). Refused on the server if any card money was taken.
    const unaccept = document.getElementById('q-unaccept');
    if (unaccept)
        unaccept.addEventListener('click', async () => {
            if (!window.confirm('Undo the acceptance? The invoice goes back to a Sent quote and the customer can accept it again.')) return;
            try {
                await run('adminSetQuoteStatus', { id: state.openQuoteId, status: 'sent', undoAccept: true }, 'Acceptance undone.');
                render();
            } catch (e) {}
        });

    // DUPLICATE: a new draft quote with the same customer, items and settings.
    // New number + link; no acceptance, payment or email history carried over.
    const dup = document.getElementById('q-dup');
    if (dup)
        dup.addEventListener('click', async () => {
            await flushQuoteAutosave();
            const doc = currentQuoteDoc();
            if (!doc) return;
            quoteDraft = { ...quoteFromDoc(doc), kind: 'quote' };
            rebuildAllKits();
            state.openQuoteId = '__new__';
            location.hash = '#/quoteDocs?q=new';
            try {
                await saveQuoteDoc(null);
            } catch (e) {
                return;
            } // repaints with the new number + link
            const m = document.getElementById('q-msg');
            if (m) m.textContent = 'Copy made - this is the new quote.';
        });

    statusButton('q-invoice', 'invoiced', 'Converted to invoice.');
    statusButton('q-paid', 'paid', 'Marked paid.');

    const cancel = document.getElementById('q-cancel');
    if (cancel)
        cancel.addEventListener('click', async () => {
            if (!window.confirm('Cancel this quote? The customer link will stop working.')) return;
            try {
                await run('adminSetQuoteStatus', { id: state.openQuoteId, status: 'cancelled' }, 'Cancelled.');
                location.hash = '#/quoteDocs';
            } catch (e) {}
        });

    const copy = document.getElementById('q-copy');
    if (copy)
        copy.addEventListener('click', () => {
            const el = document.getElementById('q-link');
            if (el) {
                el.select();
                try {
                    document.execCommand('copy');
                    copy.textContent = 'Copied';
                    setTimeout(() => {
                        copy.textContent = 'Copy';
                    }, 1500);
                } catch (e) {}
            }
        });
}

/*  Materialise the live labour figure as a real line so the server total and
    the customer's copy include it. Stripped again on load (quoteFromDoc).   */
function quoteDraftForSave() {
    syncCrewRates();
    syncPackageDiscounts();
    if (!quoteDraft.customer.eventType) quoteDraft.customer.eventType = guessEventType(quoteDraft.customer.eventName);
    const lab = quoteLabour(quoteDraft);
    const del = quoteDeliveryCents(quoteDraft);
    const km = Math.max(0, Math.round(quoteDraft.deliveryKm || 0));
    const lines = quoteDraft.lines
        .filter((l) => l.type !== 'labour' && l.type !== 'delivery')
        .filter((l) => !(l.type === 'discount' && l.pkgId && !(l.amountCents > 0))) // a $0 package discount isn't saved
        .map((l) => ({ ...l }));
    if (quoteDraft.labourExcluded !== true && lab.cents > 0) {
        lab.parts.forEach((p) =>
            lines.push({
                type: 'labour',
                name: p.lineName,
                description: p.lineDesc,
                qty: 1,
                unitCents: p.cents,
                days: 1,
                hours: p.hours
            })
        );
    }
    if (/local/i.test(quoteDraft.deliveryTown || '')) {
        lines.push({
            type: 'delivery',
            name: 'Local delivery & pickup — Free',
            description: '',
            qty: 1,
            unitCents: 0,
            days: 1
        });
    } else if (del > 0) {
        lines.push({
            type: 'delivery',
            name: 'Travel & transport' + (quoteDraft.deliveryTown ? ' — ' + quoteDraft.deliveryTown : ''),
            description: 'Fuel and vehicle running costs · ' + km + ' km each way (' + km * 2 + ' km return) @ $0.80/km',
            qty: 1,
            unitCents: del,
            days: 1
        });
    }
    const { feeCents, superCents } = quoteDraftMoney(quoteDraft);
    if (feeCents > 0) {
        lines.push({ type: 'fee', name: 'Booking & admin', qty: 1, unitCents: feeCents, days: 1 });
    }
    if (superCents > 0) {
        lines.push({
            type: 'custom',
            name: SUPER_NAME,
            description: SUPER_DESC,
            qty: 1,
            unitCents: superCents,
            days: 1,
            superLine: true,
            pubDj: true,
            noPick: true
        });
    }
    return {
        ...quoteDraft,
        lines,
        feeExcluded: quoteDraft.feeExcluded === true,
        superExcluded: quoteDraft.superExcluded === true,
        accomOff: quoteDraft.accomOff === true,
        autoSendOnDetails: quoteDraft.autoSendOnDetails === true,
        isTemplate: quoteDraft.isTemplate === true,
        templateName: String(quoteDraft.templateName || '').slice(0, 80),
        labourExcluded: quoteDraft.labourExcluded === true,
        labourOff: { setup: !!(quoteDraft.labourOff || {}).setup, pack: !!(quoteDraft.labourOff || {}).pack },
        labourPackDate: quoteDraft.labourPackDate || '',
        delivery: { town: quoteDraft.deliveryTown || '', km }
    };
}

/* -------------------------------------------------------------------------
   AUTO-SAVE
   Quotes and invoices save themselves 1.5 seconds after you stop typing or
   change a line. A brand-new quote waits until it has a customer name or a
   line item, so opening "New quote" and walking away doesn't use a number.
   Leaving the quote ("All quotes") saves anything still waiting.
   ------------------------------------------------------------------------- */
let qAutoTimer = null,
    qAutoBusy = false,
    qAutoAgain = false,
    qAutoReady = false;

function quoteAutoMsg(text, cls) {
    const m = document.getElementById('q-auto');
    if (m) {
        m.textContent = text;
        m.className = 'qb-auto' + (cls ? ' ' + cls : '');
    }
}

/*  UNDO / REDO ON A QUOTE. Ctrl+Z steps back, Ctrl+Y (or
    Ctrl+Shift+Z) steps forward. Every change to the quote goes through
    scheduleQuoteAutosave, so that is where a snapshot is taken; a burst of
    typing within 0.8s counts as one step. While you're typing in a box the
    browser's own undo works on that box as normal. History starts fresh
    each time a different quote is opened.                                 */
const qUndo = { id: null, past: [], future: [], last: null, lastPush: 0 };
const QUNDO_MAX = 60;
const quoteSnap = () => JSON.stringify(quoteDraft);
function quoteHistoryBaseline() {
    if (qUndo.id !== state.openQuoteId) {
        qUndo.id = state.openQuoteId;
        qUndo.past = [];
        qUndo.future = [];
        qUndo.last = quoteSnap();
    } else if (qUndo.last == null) qUndo.last = quoteSnap();
}
function trackQuoteHistory() {
    const now = quoteSnap();
    if (now === qUndo.last) return;
    const t = Date.now();
    if (t - qUndo.lastPush > 800) {
        qUndo.past.push(qUndo.last);
        if (qUndo.past.length > QUNDO_MAX) qUndo.past.shift();
        qUndo.lastPush = t;
    }
    qUndo.last = now;
    qUndo.future = [];
}
function quoteUndoStep(back) {
    const from = back ? qUndo.past : qUndo.future;
    const to = back ? qUndo.future : qUndo.past;
    if (!from.length) {
        quoteAutoMsg(back ? 'Nothing to undo' : 'Nothing to redo');
        return;
    }
    to.push(quoteSnap());
    quoteDraft = JSON.parse(from.pop());
    qUndo.last = quoteSnap();
    qUndo.lastPush = 0;
    render();
    qAutoReady = true;
    scheduleQuoteAutosave();
    quoteAutoMsg(back ? 'Undone - Ctrl+Y to redo' : 'Redone');
}
if (!window.__quoteUndoWired) {
    window.__quoteUndoWired = true;
    document.addEventListener('keydown', (e) => {
        if (!(e.ctrlKey || e.metaKey) || state.view !== 'quoteDocs' || !state.openQuoteId) return;
        const k = String(e.key || '').toLowerCase();
        const undo = k === 'z' && !e.shiftKey;
        const redo = k === 'y' || (k === 'z' && e.shiftKey);
        if (!undo && !redo) return;
        const a = document.activeElement;
        if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable) && a.type !== 'checkbox' && a.type !== 'radio')
            return; // typing: the box's own undo
        e.preventDefault();
        quoteUndoStep(undo);
    });
}

function scheduleQuoteAutosave() {
    if (!qAutoReady) return;
    trackQuoteHistory();
    clearTimeout(qAutoTimer);
    quoteAutoMsg('Unsaved changes…');
    qAutoTimer = setTimeout(runQuoteAutosave, 1500);
}

async function runQuoteAutosave() {
    clearTimeout(qAutoTimer);
    qAutoTimer = null;
    if (!state.openQuoteId || !quoteDraft) return; // still saves if you clicked to another tab
    const isNew = state.openQuoteId === '__new__';
    const c = quoteDraft.customer || {};
    if (isNew && !String(c.name || '').trim() && !(quoteDraft.lines || []).length) {
        quoteAutoMsg('');
        return;
    }
    if (qAutoBusy) {
        qAutoAgain = true;
        return;
    }
    qAutoBusy = true;
    quoteAutoMsg('Saving…');
    try {
        await saveQuoteDoc(null, true);
        const t = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        if (isNew && state.view === 'quoteDocs') refreshQuoteKeepFocus(); // first save: show its number + Send button
        quoteAutoMsg('Auto-saved ' + t, 'is-ok');
    } catch (err) {
        quoteAutoMsg('Auto-save failed - press Save', 'is-bad');
    } finally {
        qAutoBusy = false;
        if (qAutoAgain) {
            qAutoAgain = false;
            scheduleQuoteAutosave();
        }
    }
}

/*  Save now if anything is waiting (used when leaving the quote). */
async function flushQuoteAutosave() {
    if (qAutoTimer || qAutoAgain) {
        qAutoAgain = false;
        await runQuoteAutosave();
    }
}

/*  Re-draw the quote without losing your place in the box you're typing in. */
function refreshQuoteKeepFocus() {
    const a = document.activeElement;
    let sel = null,
        start = null,
        end = null;
    if (a && a.closest && a.closest('.q-build')) {
        const ql = a.closest('[data-ql]');
        for (const k of ['qc', 'qh', 'qmeta', 'lf']) {
            if (a.dataset && a.dataset[k] != null) {
                sel = (ql ? '[data-ql="' + ql.getAttribute('data-ql') + '"] ' : '') + '[data-' + k + '="' + a.dataset[k] + '"]';
                break;
            }
        }
        if (!sel && a.id) sel = '#' + a.id;
        try {
            start = a.selectionStart;
            end = a.selectionEnd;
        } catch (e) {
            /* not a text box */
        }
    }
    render();
    if (!sel) return;
    const b = document.querySelector('.q-build ' + sel);
    if (b) {
        b.focus();
        try {
            if (start != null) b.setSelectionRange(start, end);
        } catch (e) {
            /* ok */
        }
    }
}

async function saveQuoteDoc(btn, quiet) {
    const m = document.getElementById('q-msg');
    if (btn) btn.disabled = true;
    try {
        const id = state.openQuoteId === '__new__' ? null : state.openQuoteId;
        // no event date picked: it is the first hire day
        if (!String(quoteDraft.customer.eventDate || '').trim() && quoteDraft.hire && quoteDraft.hire.startDate) {
            quoteDraft.customer.eventDate = prettyEventDate(quoteDraft.hire.startDate);
        }
        const res = await call('adminSaveQuote', { id, quote: quoteDraftForSave() });
        if (res && res.id) {
            state.openQuoteId = res.id;
            state.quoteLoadedId = res.id;
            if (/[?&]q=new\b/.test(location.hash)) history.replaceState(null, '', '#/quoteDocs?q=' + res.id);
        }
        await syncCustomerFromQuote(); // add / update this customer in Customers
        if (res && res.id && state.quoteFromLeadId) {
            linkQuoteToLead(state.quoteFromLeadId, res.id, res.number);
            state.quoteFromLeadId = '';
        }
        if (!quiet) {
            setMsg(m, 'Saved.', 'is-ok');
            render(); // repaint so the number, link and actions appear
            const m2 = document.getElementById('q-msg');
            setMsg(m2, 'Saved.', 'is-ok');
        }
        return res;
    } catch (err) {
        setMsg(m, err.message || 'Could not save.', 'is-bad');
        throw err;
    } finally {
        if (btn) btn.disabled = false;
    }
}

/*  Whole days between two yyyy-mm-dd dates, inclusive (from a <input type=date>).
    Returns 0 when either is missing or the range is backwards.            */
function daysBetween(a, b) {
    if (!a || !b) return 0;
    const da = new Date(a + 'T00:00:00');
    const db = new Date(b + 'T00:00:00');
    if (isNaN(da) || isNaN(db)) return 0;
    const diff = Math.round((db - da) / 86400000) + 1;
    return diff > 0 ? diff : 0;
}
