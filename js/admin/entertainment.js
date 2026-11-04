/* SOUNDZGOOD ADMIN - entertainment.js
   Entertainment: DJ bookings, the roster, venues and accommodation.
   A plain script: every admin file shares one page scope, loaded in order by admin.html. */
'use strict';

/* =========================================================================
   ENTERTAINMENT
   Two tabs that look and work like Crew & Vehicles:
     GIGS  calendar on the left, the list on the right, "+ New booking" and
           every gig open in the side panel - with its status trail
           Booked > DJ confirmed > Played > Times in > Invoice sent > Paid
     DJS   one row per DJ (photo, location, rate, contact, their deck, next
           gig); click to edit in the side panel. Rates + contact are
           private (actRates/); name, act and photo are public (talent/).
   ========================================================================= */
VIEWS.entertainment = {
    html() {
        const tab = state.entTab || 'gigs';
        if (tab === 'venues') {
            const open = state.openVenue != null;
            return `<div class="inv-wrap ent${open ? ' has-detail' : ''}">${venuesMainHtml()}${open ? venueDetailHtml() : ''}</div>`;
        }
        if (tab === 'accom') {
            const open = state.openAccom != null;
            return `<div class="inv-wrap ent${open ? ' has-detail' : ''}">${accomMainHtml()}${open ? accomDetailHtml() : ''}</div>`;
        }
        if (tab === 'djs') {
            const open = state.openDj != null;
            return `<div class="inv-wrap ent${open ? ' has-detail' : ''}">${djMainHtml()}${open ? djDetailHtml() : ''}</div>`;
        }
        const picked = state.bookingOpen ? (state.schedule || []).find((x) => x.id === state.bookingOpen) : null;
        const open = state.entPanel && (state.bookEditing || picked);
        /*  The gig details open where the calendar sits, on the right, and the
        calendar comes back when they close.          */
        const side = open
            ? `
      <aside class="ad-card ent-detail ent-side" aria-label="Gig">
        <button type="button" class="inv-detail-close ent-x" data-ent-close aria-label="Close">&times;</button>
        ${!state.bookEditing && picked ? gigTrailHtml(picked) : ''}
        ${bookingPanel(picked)}
      </aside>`
            : calendarHtml();
        return `<div class="inv-wrap ent">${gigsMainHtml(side)}</div>`;
    },
    wire() {
        wireEntertainment();
        wirePubBits();
        wireEntPage();
    }
};

const ENT_NEW_BTN = {
    gigs: '<button type="button" class="ad-btn ad-btn-primary" id="ad-book-new">+ New booking</button>',
    venues: '<button type="button" class="ad-btn ad-btn-primary" data-venue-new>+ New venue</button>',
    accom: '<button type="button" class="ad-btn ad-btn-primary" data-accom-new>+ New place</button>',
    djs: '<button type="button" class="ad-btn ad-btn-primary" data-dj-new>+ New DJ</button>'
};

function entHead(tab) {
    return `
        <div class="inv-head">
          <div class="inv-head-title">
            <span class="ad-mail-icon" aria-hidden="true">&#127911;</span>
            <div>
              <h1>Entertainment</h1>
              <p>Book DJs, see who&rsquo;s playing where, and keep their details in one place.</p>
            </div>
          </div>
          <div class="inv-head-actions">
            <div class="ad-tabs" role="tablist">
              <button type="button" class="ad-tab${tab === 'gigs' ? ' is-on' : ''}" data-ent-tab="gigs">Bookings</button>
              <button type="button" class="ad-tab${tab === 'djs' ? ' is-on' : ''}" data-ent-tab="djs">Entertainment Roster</button>
              <button type="button" class="ad-tab${tab === 'venues' ? ' is-on' : ''}" data-ent-tab="venues">Venues</button>
              <button type="button" class="ad-tab${tab === 'accom' ? ' is-on' : ''}" data-ent-tab="accom">Accommodation</button>
            </div>
            ${ENT_NEW_BTN[tab] || ENT_NEW_BTN.djs}
          </div>
        </div>`;
}

/* the gig's invoice (made from a template), if it has one */
const gigInvoice = (b) => (state.quoteDocs || []).find((q) => q.gigBookingId === b.id && q.status !== 'cancelled') || null;
/*  THE GIG CHECKLIST: Enquiry > DJ confirmed > Quote accepted > Deposit >
    Set times in > Invoice sent > Paid > Entertainer paid. Every step is read
    from the booking and its quote - nothing to tick by hand.             */
function gigTrail(b) {
    const inv = gigInvoice(b);
    const v = venueRecord(b.venue) || {}; // account venues (Grand View) pay no deposit
    const paid = !!inv && (inv.status === 'paid' || inv.paymentStatus === 'paid');
    return [
        ['Enquiry', true],
        ['DJ confirmed', !!b.djConfirmedAt],
        [
            'Quote accepted',
            !!inv &&
                (!!inv.acceptedAt ||
                    ['accepted', 'invoiced', 'paid'].includes(inv.status) ||
                    ['bank', 'deposit', 'paid'].includes(inv.paymentStatus))
        ],
        ...(v.noDeposit ? [] : [['Deposit', paid || (!!inv && (inv.paymentStatus === 'deposit' || (inv.amountPaidCents || 0) > 0))]]),
        ['Set times in', !!b.timesConfirmedAt],
        ['Invoice sent', !!inv && (inv.kind === 'invoice' || ['invoiced', 'paid'].includes(inv.status))],
        ['Paid', paid],
        ['Entertainer paid', !!b.djPaidAt]
    ];
}
function gigDots(b) {
    return (
        '<span class="ent-dots">' +
        gigTrail(b)
            .map(([l, ok]) => '<i class="' + (ok ? 'is-on' : '') + '" title="' + attr(l) + (ok ? ' ✓' : '') + '"></i>')
            .join('') +
        '</span>'
    );
}
/*  Has the gig's quote been emailed to the venue? "Sent 29 Oct" or "Not sent". */
function gigSentTag(b) {
    const inv = gigInvoice(b);
    if (!inv) return '';
    const s = secs(inv.lastEmailedAt);
    if (!s) return '<span class="ent-sent is-not" title="Quote not emailed to the venue yet">Not sent</span>';
    const d = new Date(s * 1000);
    const when = d.toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    return (
        '<span class="ent-sent" title="Emailed ' +
        attr(when) +
        (inv.lastEmailedTo ? ' to ' + attr(inv.lastEmailedTo) : '') +
        '">&#9993; Sent ' +
        esc(d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })) +
        '</span>'
    );
}
const GIG_NEXT_HINT = {
    'DJ confirmed': ' &mdash; text the DJ their link below.',
    'Set times in': ' &mdash; text the DJ their link below.',
    'Quote accepted': ' &mdash; open the quote below and send it to the venue.'
};
function gigTrailHtml(b) {
    const steps = gigTrail(b);
    const next = steps.find(([, ok]) => !ok);
    return (
        '<div class="ent-trail">' +
        steps
            .map(
                ([l, ok]) =>
                    '<div class="ent-step' +
                    (ok ? ' is-on' : '') +
                    '"><span>' +
                    (ok ? '&#10003;' : '') +
                    '</span><em>' +
                    esc(l) +
                    '</em></div>'
            )
            .join('<b></b>') +
        '</div>' +
        (next
            ? '<p class="ent-next">Next: <b>' + esc(next[0]) + '</b>' + (GIG_NEXT_HINT[next[0]] || '') + '</p>'
            : '<p class="ent-next is-done">All done &#10003;</p>')
    );
}

function gigsMainHtml(side) {
    const today = isoDay(new Date());
    const all = state.schedule || [];
    const upcoming = all.filter((b) => b.date >= today);
    const weekEnd = isoDay(new Date(Date.now() + (7 - ((new Date().getDay() + 6) % 7) - 1) * 86400000));
    const thisWeek = upcoming.filter((b) => b.date <= weekEnd);
    const waitingDj = upcoming.filter((b) => !b.djConfirmedAt && (b.status || 'confirmed') === 'confirmed');
    const twoWeeksAgo = isoDay(new Date(Date.now() - 14 * 86400000));
    const timesDue = all.filter((b) => b.date < today && b.date >= twoWeeksAgo && !b.timesConfirmedAt && b.templateId);
    const shown = filteredBookings();
    /*  NIGHTS WITH NO DJ: every Grand View Friday in the next
      8 weeks with nobody booked shows in the list (and on the calendar) with a
      "Book a DJ" button - same rule as the dashboard.                      */
    const loading = !state.scheduleLoaded; // bookings not in yet
    const openNights = loading ? [] : openRegularNights(all, null, 56);
    const showOpen =
        !String(state.bookFilter.text || '').trim() &&
        ['upcoming', 'all', 'grandview', 'grand-view'].includes(state.bookFilter.tab || 'upcoming');
    const rowsAll = shown
        .map((b) => ({ kind: 'gig', date: b.date, b }))
        .concat(showOpen ? openNights.map((n) => ({ kind: 'open', date: n.iso, n })) : [])
        .sort((x, y) => x.date.localeCompare(y.date));
    return `
      <div class="inv-main">
        ${entHead('gigs')}
        <div class="ad-tiles">
          ${invTile('&#128197;', 'is-blue', thisWeek.length, 'This week', '')}
          ${invTile('&#127925;', 'is-green', upcoming.length, 'Upcoming', '')}
          ${invTile('&#10071;', 'is-red', openNights.length, 'Nights with no DJ', '')}
          ${invTile('&#9203;', 'is-amber', waitingDj.length, 'Waiting on DJ', '')}
          ${invTile('&#128338;', 'is-grey', timesDue.length, 'Times to come in', '')}
        </div>
        ${importBanner()}
        <div class="ent-split">
          <section class="ad-card ent-list">
            <div class="ad-book-tabs">
              <div class="ad-tabs" role="group" aria-label="Which bookings">
                ${bookTabs()
                    .map(
                        (t) =>
                            `<button type="button" class="ad-tab${state.bookFilter.tab === t.key ? ' is-on' : ''}" data-book-tab="${attr(t.key)}">${esc(t.label)}</button>`
                    )
                    .join('')}
                <button type="button" class="ad-tab ent-add-venue" id="ad-add-venue" title="Save a new venue - it gets its own tab">+ Add venue</button>
              </div>
              <input type="search" id="ad-book-search" class="ad-search" placeholder="Search gigs..." value="${attr(state.bookFilter.text)}" aria-label="Search gigs">
            </div>
            <div class="ad-table-wrap inv-table-wrap">
              <table class="ad-table inv-table">
                <thead><tr><th>Date</th><th>DJ</th><th>Venue</th><th>Times</th><th>Progress</th><th></th></tr></thead>
                <tbody>
                  ${
                      rowsAll.length
                          ? rowsAll
                                .map((row) => {
                                    if (row.kind === 'open') {
                                        return `<tr class="inv-row ent-open">
                      <td class="ent-date">${esc(prettyDate(row.date))}</td>
                      <td><span class="ad-pill ad-pill-red">No DJ booked</span></td>
                      <td class="ad-cell-muted">${esc(String(row.n.venue).split(',')[0])}</td>
                      <td class="ad-cell-muted">—</td>
                      <td></td>
                      <td class="ad-cell-right"><button type="button" class="ad-btn ad-btn-primary ent-book" data-book-night="${attr(row.date)}" data-book-venue="${attr(row.n.venue)}">Book a DJ</button></td>
                    </tr>`;
                                    }
                                    const b = row.b;
                                    const act = (state.talent || []).find((t) => t.slug === b.slug) || {};
                                    return `<tr class="inv-row${state.bookingOpen === b.id && state.entPanel ? ' is-open' : ''}${b.date < today ? ' is-past' : ''}${b.status === 'unconfirmed' ? ' is-unconf' : ''}" data-book-open="${attr(b.id)}">
                      <td class="ent-date">${esc(prettyDate(b.date))}</td>
                      <td><span class="inv-item-cell"><span class="ad-act-face ent-face" style="${act.photo ? `background-image:url('/${attr(act.photo)}')` : ''}"></span><span class="inv-item-name">${esc(act.name || b.slug)}</span></span></td>
                      <td class="ad-cell-muted">${esc(String(b.venue || '—').split(',')[0])}</td>
                      <td class="ad-cell-muted">${esc(b.time || '—')}</td>
                      <td>${b.status === 'unconfirmed' ? '<span class="ent-unconf-tag">Unconfirmed &middot; unpaid</span>' : gigDots(b)}${gigSentTag(b)}</td>
                      <td class="ad-cell-right"><button type="button" class="inv-open-btn" data-book-open="${attr(b.id)}" aria-label="Open">&#8250;</button></td>
                    </tr>`;
                                })
                                .join('')
                          : loading
                            ? '<tr><td colspan="6" class="ad-cell-muted ent-loading"><span class="ad-spin"></span> Loading bookings&hellip;</td></tr>'
                            : '<tr><td colspan="6" class="ad-cell-muted">Nothing matches that.</td></tr>'
                  }
                </tbody>
              </table>
            </div>
          </section>
          ${side || calendarHtml()}
        </div>
      </div>`;
}

/* ---------- DJs tab ---------- */
const djRate = (slug) => (state.actRates || {})[slug] || {};
function djNextGig(slug) {
    const today = isoDay(new Date());
    return (state.schedule || []).filter((b) => b.slug === slug && b.date >= today).sort((x, y) => x.date.localeCompare(y.date))[0] || null;
}
function djMainHtml() {
    const acts = state.talent || [];
    const needle = String(state.djSearch || '')
        .trim()
        .toLowerCase();
    const rows = acts.filter((t) => !needle || searchMatch(needle, t.name, djRate(t.slug).location, ACT_LABELS[t.act]));
    const withRate = acts.filter((t) => djRate(t.slug).hourlyRateCents).length;
    const noEmail = acts.filter((t) => !djRate(t.slug).email).length;
    return `
      <div class="inv-main">
        ${entHead('djs')}
        <div class="ad-tiles">
          ${invTile('&#127911;', 'is-green', acts.length, 'DJs & acts', '')}
          ${invTile('&#128176;', 'is-blue', withRate, 'With a rate', '')}
          ${invTile('&#9993;', 'is-amber', noEmail, 'Missing email', '')}
          ${invTile('&#128197;', 'is-grey', (state.schedule || []).filter((b) => b.date >= isoDay(new Date())).length, 'Upcoming gigs', '')}
        </div>
        <div class="inv-toolbar">
          <input type="search" id="dj-search" class="ad-search" placeholder="Search DJs..." value="${attr(state.djSearch || '')}" aria-label="Search DJs">
        </div>
        <div class="ad-table-wrap inv-table-wrap">
          <table class="ad-table inv-table">
            <thead><tr><th>Name</th><th>Act</th><th>Location</th><th class="inv-num">Rate</th><th>Contact</th><th>Next gig</th><th></th></tr></thead>
            <tbody>
              ${
                  rows.length
                      ? rows
                            .map((t) => {
                                const r = djRate(t.slug);
                                const nx = djNextGig(t.slug);
                                return `<tr class="inv-row${state.openDj === t.slug ? ' is-open' : ''}" data-dj-open="${attr(t.slug)}">
                  <td><span class="inv-item-cell"><span class="ad-act-face ent-face" style="${t.photo ? `background-image:url('/${attr(t.photo)}')` : ''}"></span><span class="inv-item-name">${esc(t.name)}</span></span></td>
                  <td><span class="ad-pill ad-pill-blue">${esc(ACT_LABELS[t.act] || t.act || 'DJ')}</span></td>
                  <td>${r.location ? esc(r.location) : '<span class="ad-cell-muted">—</span>'}</td>
                  <td class="inv-num">${r.onRequest ? '<span class="ad-pill ad-pill-blue">On request</span>' : r.hourlyRateCents ? esc(money(r.hourlyRateCents)) + '<span class="inv-perday">/hr</span>' : '<span class="ad-cell-muted">—</span>'}</td>
                  <td>${r.phone || r.email ? esc([r.phone, r.email].filter(Boolean).join(' · ')) : '<span class="ad-pill ad-pill-amber">Add contact</span>'}</td>
                  <td>${nx ? esc(prettyDate(nx.date)) + ' <span class="ad-cell-muted">' + esc(String(nx.venue || '').split(',')[0]) + '</span>' : '<span class="ad-cell-muted">—</span>'}</td>
                  <td class="ad-cell-right"><button type="button" class="inv-open-btn" data-dj-open="${attr(t.slug)}" aria-label="Edit">&#8250;</button></td>
                </tr>`;
                            })
                            .join('')
                      : '<tr><td colspan="7" class="ad-cell-muted">No DJs match. Try clearing the search, or add one above.</td></tr>'
              }
            </tbody>
          </table>
        </div>
        ${regularNightsPanel()}
      </div>`;
}
/*  LOCATION IS A PICK LIST. The towns come from the DJ travel fees table
    (plus Bowen); add a town there to get it here. A saved town that isn't
    in the list shows "(check spelling)". */
function djTownOptions(current) {
    const towns = new Set(['Bowen']);
    (state.travelFees || []).forEach((f) => {
        if (f.from) towns.add(String(f.from).trim());
        if (f.to) towns.add(String(f.to).trim());
    });
    const list = [...towns].filter(Boolean).sort((x, y) => x.localeCompare(y));
    const cur = String(current || '').trim();
    const known = list.some((t) => t.toLowerCase() === cur.toLowerCase());
    return (
        '<option value="">Choose a town</option>' +
        (cur && !known ? '<option value="' + attr(cur) + '" selected>' + esc(cur) + ' (check spelling)</option>' : '') +
        list
            .map(
                (t) =>
                    '<option value="' +
                    attr(t) +
                    '"' +
                    (t.toLowerCase() === cur.toLowerCase() ? ' selected' : '') +
                    '>' +
                    esc(t) +
                    '</option>'
            )
            .join('')
    );
}

/*  MUSIC STYLES - shown as tags on the DJ's gig quotes instead of a bio */
const DJ_STYLES = [
    'Open Format',
    'Top 40 / Commercial',
    'House',
    'Throwbacks',
    'RnB & Hip Hop',
    'Hip-Hop',
    'R&B',
    'Latin',
    'Reggaeton',
    'Baile Funk',
    'Moombahton',
    'Dancehall',
    'Country',
    'Rock',
    'Drum & Bass',
    'Requests welcome'
]; // + Latin / Caribbean styles

/*  What a DJ plays, for their public card - the ticked
    music styles minus "Requests welcome", which isn't a style.        */
const publicStyles = (list) => (Array.isArray(list) ? list : []).filter((x) => x && x !== 'Requests welcome').slice(0, 16);

function djDetailHtml() {
    const isNew = state.openDj === '__new__';
    const t = isNew ? {} : (state.talent || []).find((x) => x.slug === state.openDj) || {};
    const r = isNew ? {} : djRate(state.openDj);
    const d = (c) => (c ? (c / 100).toFixed(2).replace(/\.00$/, '') : '');
    const today = isoDay(new Date());
    const gigs = isNew
        ? []
        : (state.schedule || [])
              .filter((b) => b.slug === state.openDj && b.date >= today)
              .sort((x, y) => x.date.localeCompare(y.date))
              .slice(0, 8);
    return `
    <aside class="inv-detail ent-detail" aria-label="DJ">
      <header class="inv-detail-head">
        <div><h2>${isNew ? 'New DJ' : esc(t.name || 'DJ')}</h2>${isNew ? '' : '<p class="inv-detail-sub">' + esc(ACT_LABELS[t.act] || 'DJ') + '</p>'}</div>
        <button type="button" class="inv-detail-close" data-ent-close aria-label="Close">&times;</button>
      </header>
      <div class="inv-detail-body">
        ${t.photo ? `<div class="ent-djphoto" style="background-image:url('/${attr(t.photo)}')"></div>` : ''}
        <label class="ad-field"><span>Name</span><input class="ad-input" id="dj-f-name" value="${attr(t.name || '')}" maxlength="60" placeholder="e.g. DJ Lucas"></label>
        <label class="ad-field"><span>Act</span><select class="ad-select" id="dj-f-act">${Object.keys(ACT_LABELS)
            .map((k) => `<option value="${attr(k)}"${(t.act || 'dj') === k ? ' selected' : ''}>${esc(ACT_LABELS[k])}</option>`)
            .join('')}</select></label>
        <label class="ad-field"><span>Photo (on the website)</span><input class="ad-input" id="dj-f-photo" value="${attr(t.photo || '')}" placeholder="images/talent/name.jpg"></label>
        <div class="ent-2col">
          <label class="ad-field"><span>Rate per hour ($)</span><input class="ad-input" type="number" min="0" step="1" id="dj-f-rate" value="${attr(d(r.hourlyRateCents))}"${r.onRequest ? ' placeholder="On request"' : ''}></label>
          <label class="ad-field"><span>Location (where they live)</span><select class="ad-select" id="dj-f-loc">${djTownOptions(r.location || '')}</select></label>
          <label class="ad-field"><span>Phone</span><input class="ad-input" type="tel" id="dj-f-phone" value="${attr(r.phone || '')}" placeholder="Mobile"></label>
          <label class="ad-field"><span>Email</span><input class="ad-input" type="email" id="dj-f-email" value="${attr(r.email || '')}" placeholder="For booking emails"></label>
        </div>
        <label class="ad-field ent-payfull"><input type="checkbox" id="dj-f-onreq"${r.onRequest ? ' checked' : ''}> Price on request (bigger DJ - ask them each time, then type their price on the quote)</label>
        <label class="ad-field ent-payfull"><input type="checkbox" id="dj-f-female"${t.female ? ' checked' : ''}> Female DJ (shows under "Female DJs" in the website's genre filter)</label>
        <div class="ad-field"><span>Music styles (shown on their gig quotes)</span>
          <div class="ent-styles">${DJ_STYLES.map((x) => `<label><input type="checkbox" data-dj-style value="${attr(x)}"${(r.styles || []).includes(x) ? ' checked' : ''}> ${esc(x)}</label>`).join('')}</div>
        </div>
        <label class="ad-field"><span>Bio (shown on their gig quotes - leave a blank line between paragraphs)</span><textarea class="ad-input" id="dj-f-bio" rows="6" maxlength="1200" placeholder="Who they are, what they play, where they fit best">${esc(t.bio || '')}</textarea></label>
        <label class="ad-field"><span>Their deck (what they bring - goes on the pick list)</span><input class="ad-input" id="dj-f-deck" value="${attr(r.deck || '')}" placeholder="e.g. Pioneer DDJ-1000 - needs 2x XLR. Or: none, uses ours"></label>
        <p class="ad-cell-muted ent-private">Rate, location, phone, email and deck are private - only the name, act and photo show on the website.</p>
        ${gigs.length ? '<p class="ent-sub">Upcoming gigs</p><ul class="ent-gigs">' + gigs.map((b) => '<li><b>' + esc(prettyDate(b.date)) + '</b> ' + esc(String(b.venue || '').split(',')[0]) + ' ' + gigDots(b) + '</li>').join('') + '</ul>' : ''}
      </div>
      <footer class="inv-detail-foot">
        <button type="button" class="ad-btn ad-btn-primary" id="dj-save">Save</button>
        ${isNew ? '' : '<button type="button" class="ad-btn" data-dj-book="' + attr(state.openDj) + '">Book this DJ</button><button type="button" class="ad-btn ad-btn-danger" data-act-remove="' + attr(state.openDj) + '">Remove</button>'}
        <span class="ad-quote-msg" id="dj-msg"></span>
      </footer>
    </aside>`;
}

function wireEntPage() {
    const desk = document.getElementById('ad-desk');
    const closePanels = () => {
        state.entPanel = false;
        state.bookEditing = false;
        state.openDj = null;
        state.openVenue = null;
        state.openAccom = null;
        render();
    };
    desk.querySelectorAll('[data-ent-tab]').forEach((b) =>
        b.addEventListener('click', () => {
            state.entTab = b.getAttribute('data-ent-tab');
            closePanels();
        })
    );
    desk.querySelectorAll('[data-ent-close]').forEach((b) => b.addEventListener('click', closePanels));
    wireVenuesTab(desk);
    wireAccomTab(desk);
    // DJs tab
    const ds = document.getElementById('dj-search');
    if (ds)
        ds.addEventListener('input', () => {
            state.djSearch = ds.value;
            renderKeepCaret('dj-search', ds.selectionStart);
        });
    desk.querySelectorAll('[data-dj-open]').forEach((r) =>
        r.addEventListener('click', () => {
            state.openDj = r.getAttribute('data-dj-open');
            render();
        })
    );
    // UPDATE QUOTE: rebuild this gig's quote with the DJ's current rate / location
    desk.querySelectorAll('[data-gig-resync]').forEach((b) =>
        b.addEventListener('click', async () => {
            b.disabled = true;
            b.textContent = 'Updating…';
            const notes = await gigSyncBookings([b.getAttribute('data-gig-resync')]);
            b.textContent = notes.length ? 'Done - see note' : 'Updated ✓';
            if (notes.length) window.alert(notes.join('\n\n'));
            setTimeout(() => render(), 900);
        })
    );
    desk.querySelectorAll('[data-book-night]').forEach((b) =>
        b.addEventListener('click', () => {
            state.bookDraft = {
                date: b.getAttribute('data-book-night'),
                venue: b.getAttribute('data-book-venue') || 'Grand View Hotel, Bowen',
                slug: (state.talent[0] || {}).slug || '',
                status: 'confirmed'
            };
            state.bookEditing = true;
            state.entPanel = true;
            state.bookingOpen = null;
            render();
        })
    );
    desk.querySelectorAll('[data-dj-new]').forEach((b) =>
        b.addEventListener('click', () => {
            state.openDj = '__new__';
            render();
        })
    );
    desk.querySelectorAll('[data-dj-book]').forEach((b) =>
        b.addEventListener('click', () => {
            state.entTab = 'gigs';
            state.openDj = null;
            state.entPanel = true;
            state.bookEditing = true;
            state.bookDraft = { date: '', slug: b.getAttribute('data-dj-book'), status: 'confirmed' };
            render();
        })
    );
    const save = document.getElementById('dj-save');
    if (save)
        save.addEventListener('click', async () => {
            const v = (id) => String((document.getElementById(id) || {}).value || '').trim();
            const msg = document.getElementById('dj-msg');
            const isNew = state.openDj === '__new__';
            const name = v('dj-f-name');
            if (!name) {
                setMsg(msg, 'Give the DJ a name.', 'is-bad');
                return;
            }
            const slug = isNew ? slugify(name.replace(/&/g, ' and '), 60) : state.openDj;
            if (!slug) {
                msg.textContent = 'That name has no letters or numbers in it.';
                return;
            }
            save.disabled = true;
            setMsg(msg, 'Saving…', '');
            try {
                const { doc, setDoc, serverTimestamp } = fb.f;
                await setDoc(
                    doc(fb.db, 'talent', slug),
                    {
                        name,
                        act: v('dj-f-act') || 'dj',
                        photo: v('dj-f-photo'),
                        bio: v('dj-f-bio').slice(0, 1200),
                        location: v('dj-f-loc').slice(0, 80),
                        female: !!(document.getElementById('dj-f-female') || {}).checked,
                        genres: publicStyles([...document.querySelectorAll('[data-dj-style]:checked')].map((x) => x.value)),
                        hidden: false,
                        updatedAt: serverTimestamp()
                    },
                    { merge: true }
                );
                await setDoc(
                    doc(fb.db, 'actRates', slug),
                    {
                        hourlyRateCents: parseCents(v('dj-f-rate')),
                        location: v('dj-f-loc').slice(0, 80),
                        phone: v('dj-f-phone').slice(0, 40),
                        email: v('dj-f-email').toLowerCase().slice(0, 200),
                        deck: v('dj-f-deck').slice(0, 300),
                        styles: [...document.querySelectorAll('[data-dj-style]:checked')].map((x) => x.value).slice(0, 16),
                        onRequest: !!(document.getElementById('dj-f-onreq') || {}).checked,
                        updatedAt: Date.now()
                    },
                    { merge: true }
                );
                await Promise.all([loadTalent(), loadPubSettings()]);
                // their upcoming gig quotes pick up the new rate / location straight away
                const today = isoDay(new Date());
                const ids = (state.schedule || []).filter((b) => b.slug === slug && b.date >= today && b.templateId).map((b) => b.id);
                if (ids.length) {
                    const notes = await gigSyncBookings(ids);
                    if (notes.length) window.alert(notes.join('\n\n'));
                }
                state.openDj = slug;
                render();
                const m = document.getElementById('dj-msg');
                setMsg(m, 'Saved.', 'is-ok');
            } catch (err) {
                save.disabled = false;
                setMsg(msg, friendly(err), 'is-bad');
            }
        });
}

/*  The month grid. Monday first, because that is how a week is read here,
    and every day carries a dot for each booking on it so the shape of the
    month is legible without reading a word.                             */
function calendarHtml() {
    const cursor = state.bookMonth;
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const days = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();

    /*  getDay() is Sunday-first; this shifts it so Monday starts the row. */
    const lead = (first.getDay() + 6) % 7;
    const today = isoDay(new Date());
    const noDjDays = state.scheduleLoaded ? new Set(openRegularNights(state.schedule, null, 56).map((n) => n.iso)) : new Set();

    const cells = [];
    /*  The days before the first, drawn greyed rather than left as holes -
      a row with a gap in it does not read as a week.                  */
    const before = new Date(cursor.getFullYear(), cursor.getMonth(), 0).getDate();
    for (let i = lead; i > 0; i--) {
        cells.push('<div class="ad-cal-day is-empty"><span class="ad-cal-num">' + (before - i + 1) + '</span></div>');
    }

    for (let d = 1; d <= days; d++) {
        const iso = isoDay(new Date(cursor.getFullYear(), cursor.getMonth(), d));
        const on = state.schedule.filter((b) => b.date === iso);
        const noDj = !on.length && noDjDays.has(iso);

        cells.push(`
      <div class="ad-cal-day${iso === today ? ' is-today' : ''}${on.length ? ' has-booking' : ''}${noDj ? ' is-nodj' : ''}${on.some((b) => b.status === 'unconfirmed') ? ' is-unconf' : ''}"
           ${on.length ? `data-book-open="${attr(on[0].id)}"` : noDj ? `data-book-night="${attr(iso)}" data-book-venue="Grand View Hotel, Bowen" title="No DJ booked - click to book"` : ''}>
        <span class="ad-cal-num">${d}</span>${noDj ? '<span class="ad-cal-nodj">No DJ</span>' : ''}
        ${on
            .map((b) => {
                const act = state.talent.find((t) => t.slug === b.slug) || {};
                return `<span class="ad-cal-act ${(b.status || 'confirmed') === 'pending' ? 'is-pending' : ''}${b.status === 'unconfirmed' ? 'is-unconf' : ''}">${b.status === 'unconfirmed' ? '? ' : ''}${esc(act.name || b.slug)}</span>`;
            })
            .join('')}
      </div>`);
    }

    return `
    <section class="ad-card ad-cal">
      <header class="ad-cal-head">
        <h2>${esc(cursor.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' }))}</h2>
        <div class="ad-cal-nav">
          <button type="button" class="ad-btn" data-cal="-1" aria-label="Previous month">‹</button>
          <button type="button" class="ad-btn" data-cal="0">Today</button>
          <button type="button" class="ad-btn" data-cal="1" aria-label="Next month">›</button>
        </div>
      </header>

      <div class="ad-cal-grid">
        ${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<div class="ad-cal-name">${d}</div>`).join('')}
        ${cells.join('')}
      </div>
    </section>`;
}

/*  The one booking being looked at. Doubles as the editor: the same panel
    fills in for a new booking, so there is one form on the page rather
    than one to add and another to change.                               */
function bookingPanel(b) {
    const acts = state.talent;
    const editing = state.bookEditing;

    if (!b && !editing) {
        return `
      <section class="ad-card ad-book-panel">
        <div class="ad-book-photo" aria-hidden="true"
             style="background-image:url('/images/venues/grand-view-hotel.jpg')"></div>
        <div class="ad-book-inner">
          <h3>Nothing booked yet</h3>
          <p class="ad-cell-muted">
            New booking puts one in, or pick a night on the calendar.
          </p>
        </div>
      </section>`;
    }

    if (editing) {
        const draft = state.bookDraft;
        return `
      <section class="ad-card ad-book-panel">
        <h3>${draft.id ? 'Edit booking' : 'New booking'}</h3>

        <label class="ad-field">Date
          <input type="date" id="ad-f-date" value="${attr(draft.date || '')}">
        </label>

        <label class="ad-field">Act
          <select id="ad-f-act">
            ${acts
                .map(
                    (t) => `
              <option value="${attr(t.slug)}"${draft.slug === t.slug ? ' selected' : ''}>${esc(t.name)}</option>`
                )
                .join('')}
          </select>
        </label>

        <label class="ad-field">Venue
          <select id="ad-f-venue">${venueOptions(draft.venue || 'Grand View Hotel, Bowen')}</select>
        </label>

        ${(() => {
            // DJ GIG INVOICE: who it's billed to + which template it copies
            const tpls = (state.quoteDocs || []).filter((q) => q.isTemplate && q.status !== 'cancelled');
            const custs = (state.customers || [])
                .slice()
                .sort((a, b) => String(a.business || a.name || '').localeCompare(String(b.business || b.name || '')));
            const lastAtVenue =
                (state.schedule || [])
                    .filter((x) => x.customerId && samePub(x.venue, draft.venue || 'Grand View Hotel, Bowen'))
                    .sort((a, b) => String(b.date).localeCompare(String(a.date)))[0] || {};
            const venRec = venueRecord(draft.venue || 'Grand View Hotel, Bowen') || {}; // set on the Venues tab
            const custSel = draft.customerId != null ? draft.customerId : draft.id ? '' : venRec.customerId || lastAtVenue.customerId || '';
            const tplSel =
                draft.templateId != null
                    ? draft.templateId
                    : draft.id
                      ? ''
                      : venRec.templateId || lastAtVenue.templateId || (tpls.length === 1 ? tpls[0].id : '');
            return `
        <label class="ad-field">Invoice to
          <select id="ad-f-cust"><option value="">No invoice</option>${custs.map((c) => `<option value="${attr(c.id)}"${c.id === custSel ? ' selected' : ''}>${esc(c.business || c.name || c.email || 'Customer')}${c.business && c.name ? ' (' + esc(c.name) + ')' : ''}</option>`).join('')}</select>
        </label>
        <label class="ad-field">Accommodation
          <select id="ad-f-accom">
            <option value=""${!draft.accomId ? ' selected' : ''}>Auto - the venue's place if the DJ is from out of town</option>
            <option value="none"${draft.accomId === 'none' ? ' selected' : ''}>None - driving home</option>
            ${accomOptions(draft.accomId === 'none' ? '' : draft.accomId || '')}
          </select>
        </label>
        <label class="ad-field">Template
          <select id="ad-f-tpl">${tpls.length ? '' : '<option value="">No templates yet - make one in Sales Pipeline &gt; Templates</option>'}${tpls.map((q) => `<option value="${attr(q.id)}"${q.id === tplSel ? ' selected' : ''}>${esc(q.templateName || (q.customer && q.customer.eventName) || q.number)}</option>`).join('')}</select>
        </label>`;
        })()}

        ${(() => {
            const rn = regularNightFor(draft.venue || 'Grand View Hotel, Bowen');
            const st = draft.start || (!draft.id && rn ? rn.start : '') || (!draft.id ? '21:30' : '');
            const fi = draft.finish || (!draft.id && rn ? rn.finish : '') || (!draft.id ? '01:30' : '');
            return `
        <div class="ad-book-times">
          <label class="ad-field">Start
            <select id="ad-f-start">${timeOpts15(st)}</select>
          </label>
          <label class="ad-field">Finish
            <select id="ad-f-finish">${timeOpts15(fi, 'Late')}</select>
          </label>
        </div>`;
        })()}
        <label class="ad-field">Time (shown on the website)
          <input type="text" id="ad-f-time" value="${attr(draft.time || '9:30 PM – Late')}">
        </label>

        <label class="ad-field">Status
          <select id="ad-f-status">
            <option value="confirmed"${!['pending', 'unconfirmed'].includes(draft.status) ? ' selected' : ''}>Confirmed</option>
            <option value="pending"${draft.status === 'pending' ? ' selected' : ''}>Pending</option>
            <option value="unconfirmed"${draft.status === 'unconfirmed' ? ' selected' : ''}>Unconfirmed (DJ held until paid)</option>
          </select>
        </label>
        <!--  Pay in full: no deposit option; once paid the booking turns Confirmed. -->
        <label class="ad-field ent-payfull"><input type="checkbox" id="ad-f-payfull"${draft.payFull ? ' checked' : ''}> Pay in full up front (no deposit)</label>

        <!--  Repeat: book a residency for several weeks at once. -->
        <label class="ad-field">Repeat
          <select id="ad-f-repeat">
            ${REPEATS.map(
                (r) => `
              <option value="${r.weeks}">${esc(r.label)}</option>`
            ).join('')}
          </select>
        </label>

        <label class="ad-field">Notes
          <textarea id="ad-f-notes" rows="2">${esc(draft.notes || '')}</textarea>
        </label>

        <div class="ad-actions-row" style="margin-top:12px">
          <button type="button" class="ad-btn ad-btn-primary" id="ad-f-save">Save booking</button>
          <button type="button" class="ad-btn" id="ad-f-cancel">Cancel</button>
        </div>

        <p class="ad-action-msg" id="ad-book-msg" hidden></p>
      </section>`;
    }

    const act = acts.find((t) => t.slug === b.slug) || {};
    const status = b.status || 'confirmed';
    const photo = venuePhoto(b.venue);

    return `
    <section class="ad-card ad-book-panel">
      ${
          photo
              ? `<div class="ad-book-photo" aria-hidden="true"
                      style="background-image:url('/${attr(photo)}')"></div>`
              : ''
      }

      <div class="ad-book-inner">
        <div class="ad-book-head">
          <div>
            <h3>${esc(prettyDate(b.date))}</h3>
            <span class="ad-pill ${status === 'unconfirmed' ? 'ent-unconf-tag' : status === 'pending' ? 'ad-pill-amber' : 'ad-pill-green'}">
              ${status === 'unconfirmed' ? 'Unconfirmed &middot; DJ held until paid' : status === 'pending' ? 'Pending' : 'Confirmed'}
            </span>
          </div>

          <button type="button" class="ad-btn" data-book-edit="${attr(b.id)}">Edit</button>
        </div>

        <div class="ad-book-split-2">
          <dl class="ad-book-facts">
            <dt>${ICON.act}Act</dt>
            <dd>
              <span class="ad-act">
                <span class="ad-act-face"
                      style="${act.photo ? `background-image:url('/${attr(act.photo)}')` : ''}"></span>
                ${esc(act.name || b.slug)}
              </span>
            </dd>

            <dt>${ICON.time}Time</dt><dd>${esc(b.time || '—')}</dd>
            <dt>${ICON.place}Venue</dt><dd>${esc(b.venue || '—')}</dd>
            ${b.notes ? `<dt>${ICON.note}Notes</dt><dd>${esc(b.notes)}</dd>` : ''}
          </dl>

          <div class="ad-book-actions">
            <!--  Opens the mail app with the booking already written out.
                  A real thing that works today - the site cannot send mail
                  itself yet, and a button that silently sends nothing would
                  be worse than this.                                    -->
            <a class="ad-btn ad-btn-primary" href="${attr(mailtoFor(b, act))}">
              Send details
            </a>

            <!--  Puts the same act on the same night next week, which is
                  what a residency is and most of this diary.          -->
            <button type="button" class="ad-btn" data-book-repeat="${attr(b.id)}">
              Repeat next week
            </button>

            <button type="button" class="ad-btn ad-btn-danger" data-book-remove="${attr(b.id)}">
              Remove
            </button>
            ${(() => {
                const inv = gigInvoice(b);
                const dk = djRate(b.slug).deck;
                // no invoice yet? say what's missing
                const missing = [
                    !b.customerId && 'Invoice to',
                    !b.templateId && 'Template',
                    (b.status || 'confirmed') !== 'confirmed' && 'Confirmed status'
                ].filter(Boolean);
                const noInv =
                    !inv && missing.length
                        ? '<p class="ent-noinv">&#9888; No invoice yet - press <b>Edit</b> and set ' +
                          missing.join(' + ') +
                          ', then Save.</p>'
                        : '';
                return `${noInv}${dk ? '<p class="ent-deck">&#127911; Their deck: <b>' + esc(dk) + '</b></p>' : ''}${
                    b.djConfirmedAt
                        ? '<button type="button" class="ad-btn ent-djok is-on" data-dj-confirm="' +
                          attr(b.id) +
                          '" data-undo="1" title="Click to undo">&#10003; DJ confirmed</button>'
                        : '<button type="button" class="ad-btn ent-djok" data-dj-confirm="' +
                          attr(b.id) +
                          '">&#10003; Mark DJ confirmed</button>'
                }<button type="button" class="ad-btn" data-pub-times="${attr(b.id)}">&#128241; Text DJ their link</button>' + (b.djPaidAt
                ? '<button type="button" class="ad-btn ent-djok is-on" data-dj-paid="' + attr(b.id) + '" data-undo="1" title="Click to undo">&#10003; Entertainer paid</button>'
                : '<button type="button" class="ad-btn ent-djok" data-dj-paid="' + attr(b.id) + '">&#36; Mark entertainer paid</button>') + '${inv ? '<button type="button" class="ad-btn" data-dj-brief="' + attr(b.id) + '">&#128203; Text DJ the brief &amp; gear</button>' : ''}
              ${b.templateId && b.customerId ? `<button type="button" class="ad-btn" data-gig-resync="${attr(b.id)}">&#8635; Update quote</button>` : ''}
              ${inv ? `<a class="ad-btn" href="#/quoteDocs?q=${attr(inv.id)}">${inv.kind === 'invoice' ? 'Invoice' : 'Quote'} ${esc(money(inv.totalCents))} &middot; ${esc({ approved: 'ready', sent: 'sent', accepted: 'accepted', invoiced: 'unpaid', paid: 'paid' }[inv.status] || inv.status)}</a>` : ''}`;
            })()}
          </div>
        </div>

        <p class="ad-action-msg" id="ad-book-msg" hidden></p>
      </div>
    </section>`;
}

/*  DJ BOOKING FEE: its own line on every DJ booking
    quote - a fixed $ or a % of the DJ's performance (not gear or travel).
    Saving it updates upcoming quotes that haven't been sent.          */
function djFeePanel() {
    const f = state.djFee || {};
    const mode = f.mode === 'percent' ? 'percent' : 'fixed';
    const cents = Number.isFinite(f.cents) ? f.cents : 8000;
    const pct = Number.isFinite(f.pct) ? f.pct : 15;
    const name = f.name || 'Booking & management';
    const desc = f.description == null ? 'Sourcing, scheduling and managing your DJ, with backup cover' : f.description;
    return `
      <header class="ad-panel-head"><h2>DJ booking fee</h2></header>
      <div class="ad-panel-intro"><p>Its own line on every DJ booking quote. A % is worked out on the DJ's performance only (not gear or travel). Saving updates upcoming quotes that haven't been sent.</p></div>
      <div class="ent-fee">
        <label class="ad-field"><span>How it's worked out</span>
          <select id="dj-fee-mode"><option value="fixed"${mode === 'fixed' ? ' selected' : ''}>Fixed amount ($)</option><option value="percent"${mode === 'percent' ? ' selected' : ''}>% of the DJ's performance</option></select></label>
        <label class="ad-field"><span>Amount (ex GST)</span>
          <input class="ad-rate-in" type="number" min="0" step="1" id="dj-fee-amt" value="${attr(String(mode === 'percent' ? pct : cents / 100))}"></label>
        <label class="ad-field ent-fee-wide"><span>Name on the quote</span><input class="ad-input" id="dj-fee-name" maxlength="120" value="${attr(name)}"></label>
        <label class="ad-field ent-fee-wide"><span>Small print under it</span><input class="ad-input" id="dj-fee-desc" maxlength="300" value="${attr(desc)}"></label>
        <div><button type="button" class="ad-btn ad-btn-primary" id="dj-fee-save">Save fee</button> <span class="ad-cell-muted" id="dj-fee-msg"></span></div>
      </div>`;
}

/*  REGULAR NIGHTS: pub + night + usual times (kept hidden), then the DJ
    booking fee and the DJ travel fees. */
function regularNightsPanel() {
    const rows = state.regularNights || [];
    const daySel = (cur, id) =>
        '<select ' +
        id +
        '>' +
        WEEKDAYS.map((d, i) => '<option value="' + i + '"' + (Number(cur) === i ? ' selected' : '') + '>' + d + '</option>').join('') +
        '</select>';
    return `
    <section class="ad-card ad-panel ad-regular">
      <div hidden>
      <div class="ad-panel-intro">
        <p>Pubs you play every week. Booking a DJ there makes that night's invoice by copying the pub's last one,
           with the DJ's hours &times; their rate (roster above), plus a fixed travel fee when the DJ lives in a different
           town (table below). It waits for you to send it.</p>
      </div>
      <div class="ad-table-wrap"><table class="ad-table">
        <thead><tr><th>Pub</th><th>Night</th><th>Usual start</th><th>Usual finish</th><th></th></tr></thead>
        <tbody>
          ${rows
              .map(
                  (n) => `<tr>
            <td><input class="ad-rate-in ad-rate-wide" data-rn="${attr(n.id)}" data-rnf="venue" value="${attr(n.venue || '')}"></td>
            <td>${daySel(n.weekday, 'data-rn="' + attr(n.id) + '" data-rnf="weekday"')}</td>
            <td><select data-rn="${attr(n.id)}" data-rnf="start">${timeOpts15(n.start || '')}</select></td>
            <td><select data-rn="${attr(n.id)}" data-rnf="finish">${timeOpts15(n.finish || '', 'Late')}</select></td>
            <td><button type="button" class="ad-btn" data-rn-save="${attr(n.id)}">Save</button>
                <button type="button" class="ad-btn ad-btn-danger" data-rn-del="${attr(n.id)}">Remove</button></td>
          </tr>`
              )
              .join('')}
          <tr class="ad-rn-new">
            <td><input class="ad-rate-in ad-rate-wide" id="ad-rn-venue" placeholder="e.g. Grand View Hotel, Bowen"></td>
            <td>${daySel(5, 'id="ad-rn-day"')}</td>
            <td><select id="ad-rn-start">${timeOpts15('21:30')}</select></td>
            <td><select id="ad-rn-finish">${timeOpts15('', 'Late')}</select></td>
            <td><button type="button" class="ad-btn ad-btn-primary" id="ad-rn-add">Add</button></td>
          </tr>
        </tbody>
      </table></div>
      </div>
      ${djFeePanel()}
      <header class="ad-panel-head"><h2>DJ travel fees</h2></header>
      <div class="ad-panel-intro"><p>A fixed fee when a DJ lives in a different town to the gig (works both ways). Same town = no travel.</p></div>
      <div class="ad-table-wrap"><table class="ad-table">
        <thead><tr><th>From</th><th>To</th><th>Fee</th><th></th></tr></thead>
        <tbody>
          ${(state.travelFees || [])
              .map(
                  (f) => `<tr>
            <td><input class="ad-rate-in ad-rate-mid" data-tfee="${attr(f.id)}" data-tff="from" value="${attr(f.from || '')}"></td>
            <td><input class="ad-rate-in ad-rate-mid" data-tfee="${attr(f.id)}" data-tff="to" value="${attr(f.to || '')}"></td>
            <td><input class="ad-rate-in" type="number" min="0" step="1" data-tfee="${attr(f.id)}" data-tff="fee" value="${attr(String((f.cents || 0) / 100))}"></td>
            <td><button type="button" class="ad-btn" data-tfee-save="${attr(f.id)}">Save</button>
                <button type="button" class="ad-btn ad-btn-danger" data-tfee-del="${attr(f.id)}">Remove</button></td>
          </tr>`
              )
              .join('')}
          <tr class="ad-rn-new">
            <td><input class="ad-rate-in ad-rate-mid" id="ad-tf-from" placeholder="e.g. Proserpine"></td>
            <td><input class="ad-rate-in ad-rate-mid" id="ad-tf-to" placeholder="e.g. Bowen"></td>
            <td><input class="ad-rate-in" type="number" min="0" step="1" id="ad-tf-fee" placeholder="$"></td>
            <td><button type="button" class="ad-btn ad-btn-primary" id="ad-tf-add">Add</button></td>
          </tr>
        </tbody>
      </table></div>
    </section>`;
}

function wirePubBits() {
    const { doc, setDoc, deleteDoc, addDoc, collection } = fb.f;
    // DJ booking fee setting
    const feeSave = document.getElementById('dj-fee-save');
    if (feeSave)
        feeSave.addEventListener('click', async () => {
            const mode = document.getElementById('dj-fee-mode').value === 'percent' ? 'percent' : 'fixed';
            const amt = Math.max(0, Number(document.getElementById('dj-fee-amt').value) || 0);
            const cur = state.djFee || {};
            const data = {
                mode,
                cents: mode === 'fixed' ? Math.round(amt * 100) : Number.isFinite(cur.cents) ? cur.cents : 8000,
                pct: mode === 'percent' ? Math.min(100, amt) : Number.isFinite(cur.pct) ? cur.pct : 15,
                name: document.getElementById('dj-fee-name').value.trim().slice(0, 120) || 'Booking & management',
                description: document.getElementById('dj-fee-desc').value.trim().slice(0, 300),
                updatedAt: Date.now()
            };
            feeSave.disabled = true;
            try {
                await setDoc(doc(fb.db, 'djSettings', 'fee'), data);
                state.djFee = data;
                const m = document.getElementById('dj-fee-msg');
                if (m) m.textContent = 'Saved - upcoming unsent quotes update in a minute.';
            } catch (err) {
                window.alert(friendly(err));
            }
            feeSave.disabled = false;
        });
    const feeMode = document.getElementById('dj-fee-mode');
    if (feeMode)
        feeMode.addEventListener('change', () => {
            const f = state.djFee || {};
            document.getElementById('dj-fee-amt').value =
                feeMode.value === 'percent' ? (Number.isFinite(f.pct) ? f.pct : 15) : (Number.isFinite(f.cents) ? f.cents : 8000) / 100;
        });
    // regular nights
    const rnVal = (id, f) => (document.querySelector('[data-rn="' + cssEsc(id) + '"][data-rnf="' + f + '"]') || {}).value || '';
    document.querySelectorAll('[data-rn-save]').forEach((btn) =>
        btn.addEventListener('click', async () => {
            const id = btn.getAttribute('data-rn-save');
            try {
                await setDoc(
                    doc(fb.db, 'regularNights', id),
                    {
                        venue: rnVal(id, 'venue').trim().slice(0, 120),
                        weekday: Number(rnVal(id, 'weekday')),
                        start: rnVal(id, 'start'),
                        finish: rnVal(id, 'finish'),
                        updatedAt: Date.now()
                    },
                    { merge: true }
                );
                await loadPubSettings();
                render();
            } catch (err) {
                window.alert(friendly(err));
            }
        })
    );
    document.querySelectorAll('[data-rn-del]').forEach((btn) =>
        btn.addEventListener('click', async () => {
            if (!window.confirm('Stop this regular night? Invoices already made are kept.')) return;
            try {
                await deleteDoc(doc(fb.db, 'regularNights', btn.getAttribute('data-rn-del')));
                await loadPubSettings();
                render();
            } catch (err) {
                window.alert(friendly(err));
            }
        })
    );
    const add = document.getElementById('ad-rn-add');
    if (add)
        add.addEventListener('click', async () => {
            const venue = String((document.getElementById('ad-rn-venue') || {}).value || '').trim();
            if (!venue) {
                window.alert('Type the pub first.');
                return;
            }
            try {
                await addDoc(collection(fb.db, 'regularNights'), {
                    venue: venue.slice(0, 120),
                    weekday: Number(document.getElementById('ad-rn-day').value),
                    start: document.getElementById('ad-rn-start').value,
                    finish: document.getElementById('ad-rn-finish').value,
                    createdAt: Date.now()
                });
                await loadPubSettings();
                render();
            } catch (err) {
                window.alert(friendly(err));
            }
        });
    // DJ travel fees
    const tfVal = (id, f) => (document.querySelector('[data-tfee="' + cssEsc(id) + '"][data-tff="' + f + '"]') || {}).value || '';
    document.querySelectorAll('[data-tfee-save]').forEach((btn) =>
        btn.addEventListener('click', async () => {
            const id = btn.getAttribute('data-tfee-save');
            try {
                await setDoc(
                    doc(fb.db, 'travelFees', id),
                    {
                        from: tfVal(id, 'from').trim(),
                        to: tfVal(id, 'to').trim(),
                        cents: parseCents(tfVal(id, 'fee')),
                        updatedAt: Date.now()
                    },
                    { merge: true }
                );
                await loadPubSettings();
                render();
            } catch (err) {
                window.alert(friendly(err));
            }
        })
    );
    document.querySelectorAll('[data-tfee-del]').forEach((btn) =>
        btn.addEventListener('click', async () => {
            if (!window.confirm('Remove this travel fee?')) return;
            try {
                await deleteDoc(doc(fb.db, 'travelFees', btn.getAttribute('data-tfee-del')));
                await loadPubSettings();
                render();
            } catch (err) {
                window.alert(friendly(err));
            }
        })
    );
    const tfAdd = document.getElementById('ad-tf-add');
    if (tfAdd)
        tfAdd.addEventListener('click', async () => {
            const from = document.getElementById('ad-tf-from').value.trim(),
                to = document.getElementById('ad-tf-to').value.trim();
            if (!from || !to) {
                window.alert('Fill in both towns.');
                return;
            }
            try {
                await addDoc(collection(fb.db, 'travelFees'), {
                    from,
                    to,
                    cents: parseCents(document.getElementById('ad-tf-fee').value),
                    createdAt: Date.now()
                });
                await loadPubSettings();
                render();
            } catch (err) {
                window.alert(friendly(err));
            }
        });
    // the booking form: picking a regular pub fills in its usual times
    const venueIn = document.getElementById('ad-f-venue');
    let venuePrev = venueIn ? venueIn.value : '';
    if (venueIn)
        venueIn.addEventListener('change', async () => {
            if (venueIn.value === '__new') {
                const v = await promptNewVenue();
                if (!v) {
                    venueIn.value = venuePrev;
                    return;
                }
                venueIn.innerHTML = venueOptions(venueFull(v));
            }
            venuePrev = venueIn.value;
            // the venue's client + template, if set on the Venues tab
            const vr = venueRecord(venueIn.value);
            const cs = document.getElementById('ad-f-cust'),
                ts = document.getElementById('ad-f-tpl');
            if (vr && vr.customerId && cs) cs.value = vr.customerId;
            if (vr && vr.templateId && ts) ts.value = vr.templateId;
            const rn = regularNightFor(venueIn.value);
            const s = document.getElementById('ad-f-start'),
                f = document.getElementById('ad-f-finish');
            if (rn && s && !s.value) s.value = rn.start || '';
            if (rn && f && !f.value) f.value = rn.finish || '';
        });
    /*  CONFIRM THE DJ BY HAND - when they've said yes by
      phone or message instead of tapping their link. Click again to undo. */
    document.querySelectorAll('[data-dj-confirm]').forEach((btn) =>
        btn.addEventListener('click', async () => {
            const id = btn.getAttribute('data-dj-confirm');
            const undo = btn.hasAttribute('data-undo');
            if (undo && !window.confirm('Mark the DJ as NOT confirmed?')) return;
            btn.disabled = true;
            try {
                await fb.f.setDoc(
                    fb.f.doc(fb.db, 'talentSchedule', id),
                    { djConfirmedAt: undo ? null : fb.f.serverTimestamp(), djConfirmedBy: undo ? '' : 'admin' },
                    { merge: true }
                );
                await loadSchedule();
                render();
            } catch (err) {
                btn.disabled = false;
                window.alert(friendly(err));
            }
        })
    );
    /*  ENTERTAINER PAID: ticked by hand once the DJ has been paid. Click again to undo. */
    document.querySelectorAll('[data-dj-paid]').forEach((btn) =>
        btn.addEventListener('click', async () => {
            const id = btn.getAttribute('data-dj-paid');
            const undo = btn.hasAttribute('data-undo');
            if (undo && !window.confirm('Mark the entertainer as NOT paid?')) return;
            btn.disabled = true;
            try {
                await fb.f.setDoc(
                    fb.f.doc(fb.db, 'talentSchedule', id),
                    { djPaidAt: undo ? null : fb.f.serverTimestamp() },
                    { merge: true }
                );
                await loadSchedule();
                render();
            } catch (err) {
                btn.disabled = false;
                window.alert(friendly(err));
            }
        })
    );
    /*  TEXT THE DJ THEIR BRIEF: the gear list link, which
      for a DJ gig opens with the brief - set times, notes, venue details. */
    document.querySelectorAll('[data-dj-brief]').forEach((btn) =>
        btn.addEventListener('click', async () => {
            const b = (state.schedule || []).find((x) => x.id === btn.getAttribute('data-dj-brief'));
            const inv = b ? gigInvoice(b) : null;
            if (!inv) {
                window.alert('This gig has no quote yet - add a client and template first.');
                return;
            }
            try {
                const res = await call('adminGearListLink', { id: inv.id });
                const act = (state.talent || []).find((t) => t.slug === b.slug) || {};
                const text =
                    'Hi ' +
                    String(act.name || '').split(' ')[0] +
                    ", it's Max - here's the brief for " +
                    String(b.venue || 'the gig').split(',')[0] +
                    ' on ' +
                    prettyDate(b.date) +
                    ': ' +
                    res.url;
                await textTheDj(djRate(b.slug).phone, text);
            } catch (err) {
                window.alert(err.message || 'Could not make the link.');
            }
        })
    );
    // text the DJ their times link
    document
        .querySelectorAll('[data-pub-times]')
        .forEach((b) => b.addEventListener('click', () => textDjTimes(b.getAttribute('data-pub-times'))));
}

/*  Small icons for the facts list. Inline rather than a font or a sprite:
    there are four of them and they never change.                      */
const ICON = {
    act: '<svg viewBox="0 0 24 24"><circle cx="6.5" cy="17" r="3"/><circle cx="16.5" cy="15" r="3"/><path d="M9 17V6l10.5-2v11"/></svg>',
    time: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5.5l3.5 2"/></svg>',
    place: '<svg viewBox="0 0 24 24"><path d="M12 21s7-7 7-11a7 7 0 10-14 0c0 4 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>',
    note: '<svg viewBox="0 0 24 24"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h3"/></svg>'
};

/*  The booking, written out for whoever is playing it, as a mailto link
    that opens their own mail app with it all filled in. */
function mailtoFor(b, act) {
    const lines = [
        `Act: ${act.name || b.slug}`,
        `Date: ${prettyDate(b.date)}`,
        `Time: ${b.time || 'TBC'}`,
        `Venue: ${b.venue || 'TBC'}`,
        b.notes ? `Notes: ${b.notes}` : '',
        '',
        'SoundzGood Events & Production'
    ]
        .filter(Boolean)
        .join('\n');

    return (
        'mailto:?subject=' +
        encodeURIComponent(`Booking - ${act.name || b.slug}, ${prettyDate(b.date)}`) +
        '&body=' +
        encodeURIComponent(lines)
    );
}

/*  A photograph of the venue, where we have one. */
const VENUE_PHOTOS = {
    'grand view': 'images/venues/grand-view-hotel.jpg'
};

function venuePhoto(venue) {
    const key = Object.keys(VENUE_PHOTOS).find((k) =>
        String(venue || '')
            .toLowerCase()
            .includes(k)
    );
    return key ? VENUE_PHOTOS[key] : '';
}

/*  How many weeks a booking can be laid down in one go (half a year).
    Each night stays editable on its own afterwards. */
const REPEATS = [
    { weeks: 1, label: 'Just this night' },
    { weeks: 4, label: 'Weekly, 4 weeks' },
    { weeks: 8, label: 'Weekly, 8 weeks' },
    { weeks: 13, label: 'Weekly, 3 months' },
    { weeks: 26, label: 'Weekly, 6 months' }
];

/*  The fixed tabs across the top of the bookings table (saved venues go
    in between - see bookTabs()). */
const BOOK_TABS = [
    { key: 'upcoming', label: 'Upcoming' },
    { key: 'all', label: 'All Bookings' },
    { key: 'grand-view', label: 'Grand View Hotel' },
    { key: 'other', label: 'Other Venues' }
];

function importable() {
    const inFile = window.SG_FRIDAY_SEED || {};
    const have = {};
    state.schedule.forEach((b) => {
        have[b.date] = true;
    });

    return Object.keys(inFile)
        .filter((date) => !have[date])
        .map((date) => ({ date, slug: inFile[date] }));
}

function importBanner() {
    const waiting = importable();
    if (!waiting.length) return '';

    return `
    <div class="ad-import">
      <p>
        <strong>${waiting.length} booking${waiting.length === 1 ? '' : 's'}
        set in the site file</strong> —
        ${waiting
            .map((w) => {
                const act = state.talent.find((t) => t.slug === w.slug) || {};
                return esc((act.name || w.slug) + ' on ' + prettyDate(w.date));
            })
            .join(', ')}.
        They show on the site but this page cannot edit or count them.
      </p>

      <button type="button" class="ad-btn ad-btn-primary" id="ad-import">
        Move into the diary
      </button>
    </div>`;
}
/* =========================================================================
   VENUES TAB - like Crew & Vehicles / the roster: one row
   per venue, click to edit in the side panel. Each venue can carry who the
   invoice goes to and which template it uses, so booking a DJ there fills
   both in. Removing a venue never touches its bookings.
   ========================================================================= */
const venueRecord = (venue) => (state.venues || []).find((v) => samePub(v.name, venue)) || null;
const venueGigs = (v) => (state.schedule || []).filter((b) => samePub(v.name, b.venue));
function venuesMainHtml() {
    const today = isoDay(new Date());
    const vs = state.venues || [];
    const needle = String(state.venueSearch || '')
        .trim()
        .toLowerCase();
    const rows = vs.filter((v) => !needle || searchMatch(needle, v.name, v.town, v.contactName));
    const custName = (id) => {
        const c = (state.customers || []).find((x) => x.id === id);
        return c ? c.business || c.name || c.email : '';
    };
    const tplName = (id) => {
        const q = (state.quoteDocs || []).find((x) => x.id === id);
        return q ? q.templateName || q.number : '';
    };
    const upcoming = (v) =>
        venueGigs(v)
            .filter((b) => b.date >= today)
            .sort((x, y) => x.date.localeCompare(y.date));
    return `
      <div class="inv-main">
        ${entHead('venues')}
        <div class="ad-tiles">
          ${invTile('&#127970;', 'is-green', vs.length, 'Venues', '')}
          ${invTile('&#129534;', 'is-blue', vs.filter((v) => v.customerId).length, 'With a client', '')}
          ${invTile(
              '&#128197;',
              'is-grey',
              vs.reduce((n, v) => n + upcoming(v).length, 0),
              'Upcoming gigs',
              ''
          )}
          ${invTile('&#9203;', 'is-amber', (state.schedule || []).filter((b) => b.status === 'unconfirmed' && b.date >= today).length, 'Unconfirmed', '')}
        </div>
        <div class="inv-toolbar">
          <input type="search" id="venue-search" class="ad-search" placeholder="Search venues..." value="${attr(state.venueSearch || '')}" aria-label="Search venues">
        </div>
        <div class="ad-table-wrap inv-table-wrap">
          <table class="ad-table inv-table">
            <thead><tr><th>Venue</th><th>Town</th><th>Invoice to</th><th>Template</th><th>Contact</th><th>Next gig</th><th></th></tr></thead>
            <tbody>
              ${
                  rows.length
                      ? rows
                            .map((v) => {
                                const nx = upcoming(v)[0];
                                const act = nx ? (state.talent || []).find((t) => t.slug === nx.slug) || {} : {};
                                return `<tr class="inv-row${state.openVenue === v.id ? ' is-open' : ''}" data-venue-open="${attr(v.id)}">
                  <td><span class="inv-item-name">${esc(v.name)}</span></td>
                  <td>${v.town ? esc(v.town) : '<span class="ad-cell-muted">—</span>'}</td>
                  <td>${v.customerId ? esc(custName(v.customerId) || '—') : '<span class="ad-pill ad-pill-amber">Add client</span>'}</td>
                  <td>${v.templateId ? esc(tplName(v.templateId) || '—') : '<span class="ad-cell-muted">—</span>'}</td>
                  <td>${v.contactName || v.phone || v.email ? esc([v.contactName, v.phone].filter(Boolean).join(' · ') || v.email) : '<span class="ad-cell-muted">—</span>'}</td>
                  <td>${nx ? esc(prettyDate(nx.date)) + ' <span class="ad-cell-muted">' + esc(act.name || nx.slug) + '</span>' + (nx.status === 'unconfirmed' ? ' <span class="ent-unconf-tag">Unconfirmed</span>' : '') : '<span class="ad-cell-muted">—</span>'}</td>
                  <td class="ad-cell-right"><button type="button" class="inv-open-btn" data-venue-open="${attr(v.id)}" aria-label="Edit">&#8250;</button></td>
                </tr>`;
                            })
                            .join('')
                      : '<tr><td colspan="7" class="ad-cell-muted">No venues match. Try clearing the search, or add one above.</td></tr>'
              }
            </tbody>
          </table>
        </div>
      </div>`;
}
function venueDetailHtml() {
    const isNew = state.openVenue === '__new__';
    const v = isNew ? {} : (state.venues || []).find((x) => x.id === state.openVenue) || {};
    const today = isoDay(new Date());
    const gigs = isNew
        ? []
        : venueGigs(v)
              .filter((b) => b.date >= today)
              .sort((x, y) => x.date.localeCompare(y.date))
              .slice(0, 8);
    const custs = (state.customers || [])
        .slice()
        .sort((x, y) => String(x.business || x.name || '').localeCompare(String(y.business || y.name || '')));
    const tpls = (state.quoteDocs || []).filter((q) => q.isTemplate && q.status !== 'cancelled');
    return `
    <aside class="inv-detail ent-detail" aria-label="Venue">
      <header class="inv-detail-head">
        <div><h2>${isNew ? 'New venue' : esc(v.name || 'Venue')}</h2>${isNew ? '' : '<p class="inv-detail-sub">' + esc(v.town || '') + '</p>'}</div>
        <button type="button" class="inv-detail-close" data-ent-close aria-label="Close">&times;</button>
      </header>
      <div class="inv-detail-body">
        <label class="ad-field"><span>Venue name</span><input class="ad-input" id="vn-f-name" maxlength="80" value="${attr(v.name || '')}" placeholder="e.g. Arcadia Bar"></label>
        <label class="ad-field"><span>Town</span><select class="ad-select" id="vn-f-town">${djTownOptions(v.town || '')}</select></label>
        <label class="ad-field"><span>Address</span><input class="ad-input" id="vn-f-addr" maxlength="200" value="${attr(v.address || '')}"></label>
        <div class="ent-2col">
          <label class="ad-field"><span>Contact name</span><input class="ad-input" id="vn-f-contact" maxlength="80" value="${attr(v.contactName || '')}"></label>
          <label class="ad-field"><span>Phone</span><input class="ad-input" id="vn-f-phone" maxlength="40" value="${attr(v.phone || '')}"></label>
        </div>
        <label class="ad-field"><span>Email</span><input class="ad-input" type="email" id="vn-f-email" maxlength="200" value="${attr(v.email || '')}"></label>
        <label class="ad-field"><span>Invoice to (client) - filled in when you book here</span>
          <select class="ad-select" id="vn-f-cust"><option value="">Not set</option>${custs.map((c) => `<option value="${attr(c.id)}"${c.id === v.customerId ? ' selected' : ''}>${esc(c.business || c.name || c.email || 'Customer')}</option>`).join('')}</select></label>
        <label class="ad-field"><span>Template - filled in when you book here</span>
          <select class="ad-select" id="vn-f-tpl"><option value="">Not set</option>${tpls.map((q) => `<option value="${attr(q.id)}"${q.id === v.templateId ? ' selected' : ''}>${esc(q.templateName || q.number)}</option>`).join('')}</select></label>
        <label class="ad-field"><span>Accommodation for out-of-town DJs</span>
          <select class="ad-select" id="vn-f-accom"><option value="">None</option>${accomOptions(v.accomId || '')}</select></label>
        <label class="ent-check"><input type="checkbox" id="vn-f-nodep"${v.noDeposit ? ' checked' : ''}> <span>Account venue - no deposit</span></label>
        <label class="ad-field"><span>Auto-accept the quote this many days before the gig (0 = off, no email is sent)</span><input class="ad-input" type="number" min="0" max="60" id="vn-f-autoacc" value="${attr(String(v.autoAcceptDays || 0))}"></label>
        <label class="ad-field"><span>Notes (parking, load-in, who to ask for...)</span><textarea class="ad-input" id="vn-f-notes" rows="3" maxlength="1000">${esc(v.notes || '')}</textarea></label>
        <div class="ent-actions">
          <button type="button" class="ad-btn ad-btn-primary" id="vn-save">${isNew ? 'Add venue' : 'Save'}</button>
          ${isNew ? '' : '<button type="button" class="ad-btn" data-venue-book="' + attr(v.id) + '">Book a DJ here</button><button type="button" class="ad-btn ad-btn-danger" id="vn-del">Remove</button>'}
          <span class="ad-quote-msg" id="vn-msg"></span>
        </div>
        ${
            isNew
                ? ''
                : `<div class="inv-detail-section"><h3>Upcoming gigs here</h3>${
                      gigs.length
                          ? gigs
                                .map((b) => {
                                    const act = (state.talent || []).find((t) => t.slug === b.slug) || {};
                                    return (
                                        '<p class="ent-gigline">' +
                                        esc(prettyDate(b.date)) +
                                        ' &middot; ' +
                                        esc(act.name || b.slug) +
                                        (b.status === 'unconfirmed' ? ' <span class="ent-unconf-tag">Unconfirmed</span>' : '') +
                                        '</p>'
                                    );
                                })
                                .join('')
                          : '<p class="ad-cell-muted">None booked.</p>'
                  }</div>`
        }
      </div>
    </aside>`;
}
function wireVenuesTab(desk) {
    const vs = document.getElementById('venue-search');
    if (vs)
        vs.addEventListener('input', () => {
            state.venueSearch = vs.value;
            renderKeepCaret('venue-search', vs.selectionStart);
        });
    desk.querySelectorAll('[data-venue-open]').forEach((r) =>
        r.addEventListener('click', () => {
            state.openVenue = r.getAttribute('data-venue-open');
            render();
        })
    );
    desk.querySelectorAll('[data-venue-new]').forEach((b) =>
        b.addEventListener('click', () => {
            state.openVenue = '__new__';
            render();
        })
    );
    desk.querySelectorAll('[data-venue-book]').forEach((b) =>
        b.addEventListener('click', () => {
            const v = (state.venues || []).find((x) => x.id === b.getAttribute('data-venue-book'));
            if (!v) return;
            state.entTab = 'gigs';
            state.openVenue = null;
            state.entPanel = true;
            state.bookEditing = true;
            state.bookingOpen = null;
            state.bookDraft = { date: '', venue: venueFull(v), slug: (state.talent[0] || {}).slug || '', status: 'confirmed' };
            render();
        })
    );
    const save = document.getElementById('vn-save');
    if (save)
        save.addEventListener('click', async () => {
            const val = (id) => String((document.getElementById(id) || {}).value || '').trim();
            const msg = document.getElementById('vn-msg');
            const name = val('vn-f-name').slice(0, 80);
            if (!name) {
                setMsg(msg, 'Give the venue a name.', 'is-bad');
                return;
            }
            const town = val('vn-f-town').slice(0, 60);
            const isNew = state.openVenue === '__new__';
            const id = isNew ? slugify(name + ' ' + town, 80) : state.openVenue;
            if (isNew && (state.venues || []).some((x) => x.id === id)) {
                setMsg(msg, name + ' is already saved.', 'is-bad');
                return;
            }
            save.disabled = true;
            setMsg(msg, 'Saving…', '');
            try {
                const { doc, setDoc } = fb.f;
                await setDoc(
                    doc(fb.db, 'venues', id),
                    {
                        name,
                        town,
                        address: val('vn-f-addr').slice(0, 200),
                        contactName: val('vn-f-contact').slice(0, 80),
                        phone: val('vn-f-phone').slice(0, 40),
                        email: val('vn-f-email').toLowerCase().slice(0, 200),
                        customerId: val('vn-f-cust'),
                        templateId: val('vn-f-tpl'),
                        accomId: val('vn-f-accom'),
                        notes: val('vn-f-notes').slice(0, 1000),
                        noDeposit: !!(document.getElementById('vn-f-nodep') || {}).checked,
                        autoAcceptDays: Math.max(0, Math.min(60, Math.round(Number(val('vn-f-autoacc')) || 0))),
                        updatedAt: Date.now(),
                        ...(isNew ? { createdAt: Date.now() } : {})
                    },
                    { merge: true }
                );
                await loadPubSettings();
                state.openVenue = id;
                render();
                const m = document.getElementById('vn-msg');
                setMsg(m, 'Saved.', 'is-ok');
            } catch (err) {
                save.disabled = false;
                setMsg(msg, friendly(err), 'is-bad');
            }
        });
    const del = document.getElementById('vn-del');
    if (del)
        del.addEventListener('click', async () => {
            const v = (state.venues || []).find((x) => x.id === state.openVenue) || {};
            if (!window.confirm('Remove ' + (v.name || 'this venue') + ' from your venues?\n\nIts bookings stay as they are.')) return;
            try {
                await fb.f.deleteDoc(fb.f.doc(fb.db, 'venues', state.openVenue));
                await loadPubSettings();
                state.openVenue = null;
                if (String(state.bookFilter.tab || '').startsWith('v:')) state.bookFilter.tab = 'upcoming';
                render();
            } catch (err) {
                window.alert(friendly(err));
            }
        });
}

/*  ACCOMMODATION: places DJs stay - a hotel a venue provides, or one we
    book for the festival. Kept as one list in djSettings/accommodation.
    Venues pick their usual place; each booking can pick one or "none".  */
function accomOptions(sel) {
    return (state.accomPlaces || [])
        .map((p) => `<option value="${attr(p.id)}"${p.id === sel ? ' selected' : ''}>${esc(p.name)}</option>`)
        .join('');
}
function accomMainHtml() {
    const ps = state.accomPlaces || [];
    const usedBy = (p) => (state.venues || []).filter((v) => v.accomId === p.id).map((v) => v.name);
    return `
      <div class="inv-main">
        ${entHead('accom')}
        <div class="ad-table-wrap inv-table-wrap">
          <table class="ad-table inv-table">
            <thead><tr><th>Place</th><th>Address</th><th>Paid by</th><th>Venues using it</th><th></th></tr></thead>
            <tbody>
              ${
                  ps.length
                      ? ps
                            .map(
                                (p) => `<tr class="inv-row${state.openAccom === p.id ? ' is-open' : ''}" data-accom-open="${attr(p.id)}">
                  <td><span class="inv-item-name">${esc(p.name)}</span></td>
                  <td>${p.address ? esc(p.address) : '<span class="ad-cell-muted">—</span>'}</td>
                  <td>${p.paidBy === 'us' ? 'Us' : 'The venue'}</td>
                  <td>${usedBy(p).length ? esc(usedBy(p).join(', ')) : '<span class="ad-cell-muted">—</span>'}</td>
                  <td class="ad-cell-right"><button type="button" class="inv-open-btn" data-accom-open="${attr(p.id)}" aria-label="Edit">&#8250;</button></td>
                </tr>`
                            )
                            .join('')
                      : '<tr><td colspan="5" class="ad-cell-muted">No places yet. Add one above.</td></tr>'
              }
            </tbody>
          </table>
        </div>
      </div>`;
}
function accomDetailHtml() {
    const isNew = state.openAccom === '__new__';
    const p = isNew ? {} : (state.accomPlaces || []).find((x) => x.id === state.openAccom) || {};
    return `
    <aside class="inv-detail ent-detail" aria-label="Accommodation">
      <header class="inv-detail-head">
        <div><h2>${isNew ? 'New place' : esc(p.name || 'Place')}</h2></div>
        <button type="button" class="inv-detail-close" data-ent-close aria-label="Close">&times;</button>
      </header>
      <div class="inv-detail-body">
        <label class="ad-field"><span>Name</span><input class="ad-input" id="ac-f-name" maxlength="80" value="${attr(p.name || '')}" placeholder="e.g. Grand View Hotel"></label>
        <label class="ad-field"><span>Address</span><input class="ad-input" id="ac-f-addr" maxlength="200" value="${attr(p.address || '')}"></label>
        <label class="ad-field"><span>Check-in (shown to the DJ)</span><input class="ad-input" id="ac-f-checkin" maxlength="200" value="${attr(p.checkIn || '')}" placeholder="e.g. From 2pm - key at the bar"></label>
        <label class="ad-field"><span>Contact (shown to the DJ)</span><input class="ad-input" id="ac-f-contact" maxlength="120" value="${attr(p.contact || '')}" placeholder="Name &amp; phone"></label>
        <label class="ad-field"><span>Paid by</span>
          <select class="ad-select" id="ac-f-paid">
            <option value="venue"${p.paidBy !== 'us' ? ' selected' : ''}>The venue (shows on the quote as provided by them)</option>
            <option value="us"${p.paidBy === 'us' ? ' selected' : ''}>Us (not on the quote)</option>
          </select></label>
        <label class="ad-field"><span>Notes for the DJ (parking, room, breakfast...)</span><textarea class="ad-input" id="ac-f-notes" rows="3" maxlength="600">${esc(p.notes || '')}</textarea></label>
        <div class="ent-actions">
          <button type="button" class="ad-btn ad-btn-primary" id="ac-save">${isNew ? 'Add place' : 'Save'}</button>
          ${isNew ? '' : '<button type="button" class="ad-btn ad-btn-danger" id="ac-del">Remove</button>'}
          <span class="ad-quote-msg" id="ac-msg"></span>
        </div>
      </div>
    </aside>`;
}
async function saveAccomPlaces(places) {
    await fb.f.setDoc(fb.f.doc(fb.db, 'djSettings', 'accommodation'), { places, updatedAt: Date.now() });
    state.accomPlaces = places;
}
function wireAccomTab(desk) {
    desk.querySelectorAll('[data-accom-open]').forEach((r) =>
        r.addEventListener('click', () => {
            state.openAccom = r.getAttribute('data-accom-open');
            render();
        })
    );
    desk.querySelectorAll('[data-accom-new]').forEach((b) =>
        b.addEventListener('click', () => {
            state.openAccom = '__new__';
            render();
        })
    );
    const save = document.getElementById('ac-save');
    if (save)
        save.addEventListener('click', async () => {
            const val = (id) => String((document.getElementById(id) || {}).value || '').trim();
            const msg = document.getElementById('ac-msg');
            const name = val('ac-f-name').slice(0, 80);
            if (!name) {
                setMsg(msg, 'Give the place a name.', 'is-bad');
                return;
            }
            const isNew = state.openAccom === '__new__';
            const id = isNew ? slugify(name, 60) + '-' + Date.now().toString(36) : state.openAccom;
            const place = {
                id,
                name,
                address: val('ac-f-addr').slice(0, 200),
                checkIn: val('ac-f-checkin').slice(0, 200),
                contact: val('ac-f-contact').slice(0, 120),
                paidBy: val('ac-f-paid') === 'us' ? 'us' : 'venue',
                notes: val('ac-f-notes').slice(0, 600)
            };
            const list = (state.accomPlaces || [])
                .filter((x) => x.id !== id)
                .concat(place)
                .sort((a, b) => String(a.name).localeCompare(String(b.name)));
            save.disabled = true;
            setMsg(msg, 'Saving…', '');
            try {
                await saveAccomPlaces(list);
                state.openAccom = id;
                render();
                const m = document.getElementById('ac-msg');
                setMsg(m, 'Saved. Upcoming gig quotes not yet sent are updated.', 'is-ok');
            } catch (err) {
                save.disabled = false;
                setMsg(msg, friendly(err), 'is-bad');
            }
        });
    const del = document.getElementById('ac-del');
    if (del)
        del.addEventListener('click', async () => {
            const p = (state.accomPlaces || []).find((x) => x.id === state.openAccom) || {};
            if (!window.confirm('Remove ' + (p.name || 'this place') + '?\n\nVenues and bookings using it will have no accommodation.'))
                return;
            try {
                await saveAccomPlaces((state.accomPlaces || []).filter((x) => x.id !== state.openAccom));
                state.openAccom = null;
                render();
            } catch (err) {
                window.alert(friendly(err));
            }
        });
}

/*  The tabs: the fixed ones with a tab for each saved venue slotted in
    before "Other Venues".                          */
function bookTabs() {
    const saved = (state.venues || []).filter((v) => !/grand view/i.test(v.name || '')).map((v) => ({ key: 'v:' + v.id, label: v.name }));
    return BOOK_TABS.slice(0, 3).concat(saved, BOOK_TABS.slice(3));
}
const venueFull = (v) => v.name + (v.town ? ', ' + v.town : '');
/*  The booking form's venue pick list: Grand View, the saved venues, and
    "+ Add a new venue" at the bottom. An old booking
    at a venue that isn't saved keeps it, shown first.                 */
function venueOptions(current) {
    const list = ['Grand View Hotel, Bowen'].concat((state.venues || []).filter((v) => !/grand view/i.test(v.name || '')).map(venueFull));
    const cur = String(current || '').trim();
    const opts = (cur && !list.includes(cur) ? [cur] : []).concat(list);
    return (
        opts.map((x) => '<option value="' + attr(x) + '"' + (x === cur ? ' selected' : '') + '>' + esc(x) + '</option>').join('') +
        '<option value="__new">+ Add a new venue...</option>'
    );
}
/*  Ask for a new venue's name + town and save it. Used by the "+ Add venue"
    tab button and the booking form. Gives back the saved venue, or null. */
async function promptNewVenue() {
    const name = (window.prompt('Venue name (e.g. Arcadia Bar)') || '').trim().slice(0, 80);
    if (!name) return null;
    const town = (window.prompt('Town (e.g. Mackay)') || '').trim().slice(0, 60);
    const id = slugify(name + ' ' + town, 80);
    const have = (state.venues || []).find((v) => v.id === id);
    if (have) return have;
    try {
        const { doc, setDoc } = fb.f;
        const v = { name, town, createdAt: Date.now() };
        await setDoc(doc(fb.db, 'venues', id), v);
        state.venues = (state.venues || []).concat({ id, ...v }).sort((a, b) => String(a.name).localeCompare(String(b.name)));
        return { id, ...v };
    } catch (err) {
        window.alert(friendly(err));
        return null;
    }
}

function filteredBookings() {
    const today = isoDay(new Date());
    const f = state.bookFilter;
    const text = (f.text || '').trim().toLowerCase();

    return state.schedule.filter((b) => {
        const atPub = /grand view/i.test(b.venue || '');

        if (f.tab === 'upcoming' && b.date < today) return false;
        if (f.tab === 'grand-view' && !atPub) return false;
        const savedAt = (state.venues || []).find((v) => samePub(v.name, b.venue));
        if (f.tab === 'other' && (atPub || savedAt)) return false;
        if (String(f.tab || '').startsWith('v:') && !(savedAt && 'v:' + savedAt.id === f.tab)) return false;

        if (text) {
            const act = state.talent.find((t) => t.slug === b.slug) || {};
            const hay = ((act.name || b.slug) + ' ' + (b.venue || '')).toLowerCase();
            if (hay.indexOf(text) < 0) return false;
        }
        return true;
    });
}
/*  Lower case, dashes for anything else, trimmed to max - used for ids. */
function slugify(text, max) {
    return String(text)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, max);
}

function isoDay(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function bookingId(date, slug) {
    return date + '__' + slug;
}

/* ---- wiring ---------------------------------------------------------- */
function wireEntertainment() {
    const say = (id, text, ok) => showMsg(document.getElementById(id), text, ok ? 'is-ok' : 'is-bad');

    /* the month */
    document.querySelectorAll('[data-cal]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const step = parseInt(btn.getAttribute('data-cal'), 10);
            state.bookMonth = step === 0 ? new Date() : new Date(state.bookMonth.getFullYear(), state.bookMonth.getMonth() + step, 1);
            render();
        });
    });

    /* opening one */
    document.querySelectorAll('[data-book-open]').forEach((el) => {
        el.addEventListener('click', (ev) => {
            if (ev.target.closest('[data-book-remove]')) return;
            state.bookingOpen = el.getAttribute('data-book-open');
            state.bookEditing = false;
            state.entPanel = true;
            render();
        });
    });

    /* new / edit / cancel */
    const fresh = document.getElementById('ad-book-new');
    if (fresh) {
        fresh.addEventListener('click', () => {
            state.bookDraft = { date: '', slug: (state.talent[0] || {}).slug || '', status: 'confirmed' };
            state.bookEditing = true;
            state.entPanel = true;
            render();
        });
    }

    document.querySelectorAll('[data-book-edit]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const b = state.schedule.find((x) => x.id === btn.getAttribute('data-book-edit'));
            if (!b) return;
            state.bookDraft = { ...b };
            state.bookEditing = true;
            render();
        });
    });

    const cancel = document.getElementById('ad-f-cancel');
    if (cancel) {
        cancel.addEventListener('click', () => {
            state.bookEditing = false;
            render();
        });
    }

    const save = document.getElementById('ad-f-save');
    if (save) {
        save.addEventListener('click', async () => {
            const date = document.getElementById('ad-f-date').value;
            const slug = document.getElementById('ad-f-act').value;

            if (!date) {
                say('ad-book-msg', 'Pick a date.', false);
                return;
            }
            if (!slug) {
                say('ad-book-msg', 'Pick an act.', false);
                return;
            }

            const startT = (document.getElementById('ad-f-start') || {}).value || '';
            const finishT = (document.getElementById('ad-f-finish') || {}).value || '';
            const shout = (t) =>
                ampmT(t)
                    .toUpperCase()
                    .replace(/(AM|PM)$/, ' $1');
            const base = {
                slug,
                venue: document.getElementById('ad-f-venue').value.trim(),
                start: startT,
                finish: finishT, // pub invoices work the hours out from these
                customerId: (document.getElementById('ad-f-cust') || {}).value || '',
                templateId: (document.getElementById('ad-f-tpl') || {}).value || '',
                accomId: (document.getElementById('ad-f-accom') || {}).value || '',
                time: startT && finishT ? shout(startT) + ' – ' + shout(finishT) : document.getElementById('ad-f-time').value.trim(),
                status: document.getElementById('ad-f-status').value,
                payFull: !!(document.getElementById('ad-f-payfull') || {}).checked,
                notes: document.getElementById('ad-f-notes').value.trim()
            };

            const weeks = parseInt(document.getElementById('ad-f-repeat').value, 10) || 1;
            const p = date.split('-');
            const nights = [];
            for (let i = 0; i < weeks; i++) nights.push(isoDay(new Date(+p[0], +p[1] - 1, +p[2] + i * 7)));

            /*  One DJ, one night: if they're already booked or held that night, ask first. */
            for (const night of nights) {
                const clash = (state.schedule || []).find((x) => x.id === bookingId(night, slug) && x.id !== state.bookDraft.id);
                if (clash) {
                    const act = (state.talent || []).find((t) => t.slug === slug) || {};
                    const what = clash.status === 'unconfirmed' ? 'held (unconfirmed)' : 'booked';
                    if (
                        !window.confirm(
                            (act.name || slug) +
                                ' is already ' +
                                what +
                                ' on ' +
                                prettyDate(night) +
                                ' at ' +
                                (clash.venue || 'another venue') +
                                '.\n\nReplace that booking with this one?'
                        )
                    )
                        return;
                }
            }

            save.disabled = true;

            try {
                const old = state.bookDraft.id;
                const made = [];

                /*  One write per night (not a batch), so a failure halfway keeps the
            nights already written. */
                for (const night of nights) {
                    const id = bookingId(night, slug);

                    await fb.f.setDoc(
                        fb.f.doc(fb.db, 'talentSchedule', id),
                        {
                            ...base,
                            date: night,
                            updatedAt: fb.f.serverTimestamp()
                        },
                        { merge: true }
                    ); // keeps DJ confirmed / times / links when a booking is edited
                    made.push({ id, date: night });
                }

                /*  Moving a booking to another night or another act changes its
            id, so the one it used to be has to go or there would be two. */
                const oldB = old ? (state.schedule || []).find((x) => x.id === old) : null;
                if (old && !made.some((m) => m.id === old)) {
                    await fb.f.deleteDoc(fb.f.doc(fb.db, 'talentSchedule', old));
                }
                // the pub's invoice for each of those nights (and the night it moved from)
                for (const m of made) call('adminDjBooked', { bookingId: m.id }).catch(() => {}); // "you're booked - please confirm"
                const pubNotes = await gigSyncBookings(
                    made.map((m) => m.id).concat(oldB && !made.some((m) => m.id === oldB.id) ? [oldB.id] : [])
                );
                if (pubNotes.length) window.alert(pubNotes.join('\n\n'));
                await loadSchedule();
                state.bookEditing = false;
                state.bookingOpen = made[0].id;
                render();

                say(
                    'ad-book-msg',
                    made.length === 1 ? 'Saved.' : `${made.length} nights booked, through ${prettyDate(made[made.length - 1].date)}.`,
                    true
                );
            } catch (err) {
                say('ad-book-msg', friendly(err), false);
                save.disabled = false;
            }
        });
    }

    document.querySelectorAll('[data-book-repeat]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const b = state.schedule.find((x) => x.id === btn.getAttribute('data-book-repeat'));
            if (!b) return;

            const p = b.date.split('-');
            const next = new Date(+p[0], +p[1] - 1, +p[2] + 7);
            const date = isoDay(next);

            btn.disabled = true;

            try {
                await fb.f.setDoc(fb.f.doc(fb.db, 'talentSchedule', bookingId(date, b.slug)), {
                    date,
                    slug: b.slug,
                    venue: b.venue || '',
                    time: b.time || '',
                    start: b.start || '',
                    finish: b.finish || '',
                    customerId: b.customerId || '',
                    templateId: b.templateId || '',
                    accomId: b.accomId || '',
                    status: b.status || 'confirmed',
                    notes: b.notes || '',
                    updatedAt: fb.f.serverTimestamp()
                });

                const pn = await gigSyncBookings([bookingId(date, b.slug)]);
                if (pn.length) window.alert(pn.join('\n\n'));
                await loadSchedule();
                state.bookingOpen = bookingId(date, b.slug);
                render();
                say('ad-book-msg', 'Booked for ' + prettyDate(date) + '.', true);
            } catch (err) {
                say('ad-book-msg', friendly(err), false);
                btn.disabled = false;
            }
        });
    });

    document.querySelectorAll('[data-book-remove]').forEach((btn) => {
        btn.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            const id = btn.getAttribute('data-book-remove');
            if (!window.confirm('Remove this booking?')) return;

            btn.disabled = true;

            try {
                const gone = (state.schedule || []).find((x) => x.id === id);
                await fb.f.deleteDoc(fb.f.doc(fb.db, 'talentSchedule', id));
                if (gone) await gigSyncBookings([gone.id]); // cancels that gig's invoice
                if (state.bookingOpen === id) {
                    state.bookingOpen = null;
                    state.entPanel = false;
                }
                await loadSchedule();
                render();
            } catch (err) {
                say('ad-book-msg', friendly(err), false);
                btn.disabled = false;
            }
        });
    });

    /* filters */
    const search = document.getElementById('ad-book-search');
    if (search) {
        search.addEventListener('input', () => {
            state.bookFilter.text = search.value;
            renderKeepCaret('ad-book-search');
        });
    }

    const addVenue = document.getElementById('ad-add-venue');
    if (addVenue)
        addVenue.addEventListener('click', async () => {
            const v = await promptNewVenue();
            if (!v) return;
            state.bookFilter.tab = 'v:' + v.id;
            render();
        });
    document.querySelectorAll('[data-book-tab]').forEach((btn) => {
        btn.addEventListener('click', () => {
            state.bookFilter.tab = btn.getAttribute('data-book-tab');
            render();
        });
    });
    const imp = document.getElementById('ad-import');
    if (imp) {
        imp.addEventListener('click', async () => {
            const waiting = importable();
            imp.disabled = true;

            try {
                for (const w of waiting) {
                    await fb.f.setDoc(fb.f.doc(fb.db, 'talentSchedule', w.date + '__' + w.slug), {
                        date: w.date,
                        slug: w.slug,
                        venue: 'Grand View Hotel, Bowen',
                        time: '9:30 PM – Late',
                        status: 'confirmed',
                        notes: '',
                        updatedAt: fb.f.serverTimestamp()
                    });
                }

                await loadSchedule();
                render();
            } catch (err) {
                window.alert(friendly(err));
                imp.disabled = false;
            }
        });
    }

    document.querySelectorAll('[data-act-remove]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const slug = btn.getAttribute('data-act-remove');
            const act = state.talent.find((t) => t.slug === slug) || {};

            if (!window.confirm('Remove ' + (act.name || slug) + ' from the roster?')) return;

            btn.disabled = true;

            try {
                /*  An act that exists only in js/site/roster.js has no row to delete,
            so it is marked hidden and the merge there drops it.        */
                await fb.f.setDoc(
                    fb.f.doc(fb.db, 'talent', slug),
                    {
                        name: act.name || slug,
                        hidden: true,
                        updatedAt: fb.f.serverTimestamp()
                    },
                    { merge: true }
                );

                await loadTalent();
                state.openDj = null;
                render();
                say('ad-act-msg', (act.name || slug) + ' removed.', true);
            } catch (err) {
                say('ad-act-msg', friendly(err), false);
                btn.disabled = false;
            }
        });
    });
}
