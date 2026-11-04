/* SOUNDZGOOD ADMIN - map.js
   Sites & Map: the ground plan and the sites on it.
   A plain script: every admin file shares one page scope, loaded in order by admin.html. */
'use strict';

/* =========================================================================
   MAP AND SITES
   The ground, drawn from the same x/y/w/h as the public map, coloured by
   what is on each site. Click a site to free it, block it or seat someone.
   It has its own SVG (not js/vendor-map.js) so a change to one can't break
   the other.
   ========================================================================= */

const SITE_FILL = {
    available: '#e7f6ee',
    held: '#fdf0dc',
    booked: '#ffe3d2',
    blocked: '#e4e6eb'
};

const SITE_EDGE = {
    available: '#0f9d58',
    held: '#b26a00',
    booked: '#ff6b00',
    blocked: '#9aa1ac'
};

/*  Site status is about the ground; the words admins use are about people.
    Held by a vendor mid-checkout and held because staff seated them look
    identical on the site document, so the booking decides the wording. */
function siteWord(status) {
    return { available: 'Available', held: 'Reserved', booked: 'Confirmed', blocked: 'Blocked off' }[status] || status;
}

function bookingOnSite(site) {
    if (!site.bookingId) return null;
    return state.bookings.find((b) => b.id === site.bookingId) || null;
}

VIEWS.map = {
    html() {
        const ev = state.events.find((e) => e.id === state.activeEventId) || {};
        const size = ev.map || { width: 760, height: 1420 };
        // the ENTRY box would sit on top of bays M20 / M30 - not drawn
        const marks = (ev.landmarks || []).filter((m) => m.kind !== 'entry');

        const tally = { available: 0, held: 0, booked: 0, blocked: 0 };
        state.sites.forEach((s) => {
            tally[s.status] = (tally[s.status] || 0) + 1;
        });

        const selected = state.sites.find((s) => s.id === state.openSiteId);

        return `
      <div class="ad-page-head">
        <div>
          <h1>Map &amp; Sites</h1>
          <p>Click a site to see who is on it and move them.</p>
        </div>
        <div class="ad-page-actions"><button type="button" class="ad-btn" id="ad-map-print">Print vendor report</button></div>
      </div>

      <div class="ad-legend">
        ${['available', 'held', 'booked', 'blocked']
            .map(
                (k) => `
          <span class="ad-legend-item">
            <span class="ad-swatch" style="background:${SITE_FILL[k]};border-color:${SITE_EDGE[k]}"></span>
            ${esc(siteWord(k))} <strong>${tally[k] || 0}</strong>
          </span>`
            )
            .join('')}
      </div>

      <div class="ad-map-split">
        <div class="ad-card ad-map-wrap">
          <svg viewBox="0 0 ${size.width} ${size.height}" class="ad-map"
               role="img" aria-label="Site map">
            ${marks
                .map(
                    (m) => `
              <g>
                <rect x="${m.x}" y="${m.y}" width="${m.w}" height="${m.h}"
                      rx="4" class="ad-mark ad-mark-${attr(m.kind)}"></rect>
                ${
                    m.label
                        ? `<text x="${m.x + m.w / 2}" y="${m.y + m.h / 2 + 6}"
                      class="ad-mark-label">${esc(m.label)}</text>`
                        : ''
                }
              </g>`
                )
                .join('')}

            ${state.sites
                .map((s) => {
                    const on = state.openSiteId === s.id;
                    const spin = s.rotate ? ` transform="rotate(${s.rotate} ${s.x + s.w / 2} ${s.y + s.h / 2})"` : '';
                    return `
                <g class="ad-site${on ? ' is-on' : ''}" data-site="${attr(s.id)}"${spin}>
                  <rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="3"
                        fill="${SITE_FILL[s.status] || '#fff'}"
                        stroke="${SITE_EDGE[s.status] || '#ccc'}"
                        stroke-width="${on ? 4 : 1.5}"></rect>
                  <text x="${s.x + s.w / 2}" y="${s.y + s.h / 2 + 5}"
                        class="ad-site-label">${esc(s.label)}</text>
                </g>`;
                })
                .join('')}
          </svg>
        </div>

        <aside class="ad-card ad-site-panel">
          ${
              selected
                  ? sitePanel(selected)
                  : `
            <p class="ad-empty">Pick a site on the map.</p>`
          }
        </aside>
      </div>`;
    },

    wire() {
        document.querySelectorAll('[data-site]').forEach((g) => {
            g.addEventListener('click', () => {
                const id = g.getAttribute('data-site');
                state.openSiteId = state.openSiteId === id ? null : id;
                render();
            });
        });

        const printBtn = document.getElementById('ad-map-print');
        if (printBtn) printBtn.addEventListener('click', printVendorReport);

        wireSitePanel();
    }
};

/*  VENDOR REPORT FOR THE NIGHT: page 1 the map with each business's name
    on its site, then a list by site - business, contact, phone, type.
    Opens in its own tab and goes straight to print / PDF. */
function printVendorReport() {
    const ev = state.events.find((e) => e.id === state.activeEventId) || {};
    const size = ev.map || { width: 760, height: 1420 };
    const marks = (ev.landmarks || []).filter((m) => m.kind !== 'entry');
    // a business name over up to 3 short lines
    const lines = (text, max) => {
        const words = String(text || '')
            .split(/\s+/)
            .filter(Boolean);
        const out = [];
        let cur = '';
        words.forEach((w) => {
            if ((cur + ' ' + w).trim().length > max && cur) {
                out.push(cur);
                cur = w;
            } else cur = (cur + ' ' + w).trim();
        });
        if (cur) out.push(cur);
        if (out.length > 3) {
            out.length = 3;
            out[2] = out[2].slice(0, max - 1) + '\u2026';
        }
        return out;
    };
    const svg =
        '<svg viewBox="0 0 ' +
        size.width +
        ' ' +
        size.height +
        '" class="map">' +
        marks
            .map(
                (m) =>
                    '<rect x="' +
                    m.x +
                    '" y="' +
                    m.y +
                    '" width="' +
                    m.w +
                    '" height="' +
                    m.h +
                    '" rx="4" fill="#eceef1" stroke="#c9ccd2"/>' +
                    (m.label
                        ? '<text x="' + (m.x + m.w / 2) + '" y="' + (m.y + m.h / 2 + 6) + '" class="mk">' + esc(m.label) + '</text>'
                        : '')
            )
            .join('') +
        state.sites
            .map((s) => {
                const b = bookingOnSite(s);
                const spin = s.rotate ? ' transform="rotate(' + s.rotate + ' ' + (s.x + s.w / 2) + ' ' + (s.y + s.h / 2) + ')"' : '';
                const name = b ? lines((b.business || {}).name, s.type === 'food' ? 11 : 9) : [];
                const fs2 = s.type === 'food' ? 12 : 9.5;
                const top = s.y + 15;
                return (
                    '<g' +
                    spin +
                    '><rect x="' +
                    s.x +
                    '" y="' +
                    s.y +
                    '" width="' +
                    s.w +
                    '" height="' +
                    s.h +
                    '" rx="3" fill="' +
                    (b ? '#fff1e4' : '#fff') +
                    '" stroke="' +
                    (b ? '#ff6b00' : '#bbb') +
                    '" stroke-width="1.5"/>' +
                    '<text x="' +
                    (s.x + s.w / 2) +
                    '" y="' +
                    top +
                    '" class="sl">' +
                    esc(s.label) +
                    '</text>' +
                    name
                        .map(
                            (t, i) =>
                                '<text x="' +
                                (s.x + s.w / 2) +
                                '" y="' +
                                (top + 4 + (i + 1) * (fs2 + 2)) +
                                '" class="nm" style="font-size:' +
                                fs2 +
                                'px">' +
                                esc(t) +
                                '</text>'
                        )
                        .join('') +
                    '</g>'
                );
            })
            .join('') +
        '</svg>';
    const rows = state.sites
        .map((s) => ({ s, b: bookingOnSite(s) }))
        .filter((x) => x.b)
        .sort((x, y) => String(x.s.label).localeCompare(String(y.s.label), undefined, { numeric: true }));
    // one row per booking (a market stall can take several bays)
    const byId = new Map();
    rows.forEach(({ s, b }) => {
        if (byId.has(b.id)) byId.get(b.id).sites.push(s.label);
        else byId.set(b.id, { b, sites: [s.label] });
    });
    const list = [...byId.values()];
    const free = state.sites.filter((s) => s.status === 'available').length;
    const table =
        '<table><thead><tr><th>Site</th><th>Business</th><th>Contact</th><th>Phone</th><th>Type</th><th>&#10003;</th></tr></thead><tbody>' +
        list
            .map(({ b, sites }) => {
                const biz = b.business || {};
                return (
                    '<tr><td><b>' +
                    esc(sites.join(', ')) +
                    '</b></td><td>' +
                    esc(biz.name || '') +
                    (b.categoryName ? '<br><small>' + esc(b.categoryName) + '</small>' : '') +
                    '</td><td>' +
                    esc(biz.contactName || '') +
                    '</td><td>' +
                    esc(biz.phone || '') +
                    '</td><td>' +
                    (b.vendorType === 'food' ? 'Food' : 'Market') +
                    '</td><td class="tick"></td></tr>'
                );
            })
            .join('') +
        '</tbody></table>';
    const when = new Date().toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    const html =
        '<!doctype html><html><head><meta charset="utf-8"><title>Vendor report - ' +
        esc(ev.name || '') +
        '</title><style>' +
        '@page{size:A4;margin:10mm}body{font-family:Arial,Helvetica,sans-serif;color:#111;margin:0}' +
        'h1{font-size:20px;margin:0}p.sub{margin:2px 0 8px;color:#555;font-size:12px}' +
        '.p1{height:270mm;display:flex;flex-direction:column}.map{flex:1;width:100%;height:100%;min-height:0}' +
        'text{text-anchor:middle;font-family:Arial}.mk{font-size:16px;font-weight:700;fill:#888}.sl{font-size:12px;font-weight:800;fill:#111}.nm{fill:#7a3c00;font-weight:700}' +
        '.p2{break-before:page}table{width:100%;border-collapse:collapse;font-size:12px}th{text-align:left;background:#111;color:#fff;padding:6px 8px}' +
        'td{padding:6px 8px;border-bottom:1px solid #ddd;vertical-align:top}small{color:#777}td.tick{width:28px;border:1px solid #bbb}tr{break-inside:avoid}' +
        '</style></head><body>' +
        '<section class="p1"><h1>' +
        esc(ev.name || 'Event') +
        ' &mdash; vendor map</h1><p class="sub">' +
        esc(ev.dateLabel || '') +
        (ev.venue ? ' &middot; ' + esc(ev.venue) : '') +
        ' &middot; ' +
        list.length +
        ' vendors &middot; ' +
        free +
        ' sites free &middot; printed ' +
        esc(when) +
        '</p>' +
        svg +
        '</section>' +
        '<section class="p2"><h1>Vendors by site</h1><p class="sub">Tick each one off as they arrive.</p>' +
        table +
        '</section>' +
        '<script>window.onload=function(){setTimeout(function(){window.print()},300)}</script></body></html>';
    const w = window.open('', '_blank');
    if (!w) {
        window.alert('Your browser blocked the report window - allow pop-ups for this site and try again.');
        return;
    }
    w.document.open();
    w.document.write(html);
    w.document.close();
}

const SITE_PILL = { available: 'ad-pill-green', held: 'ad-pill-amber', booked: 'ad-pill-red' };

function sitePanel(site) {
    const on = bookingOnSite(site);

    // vendors of this site's type: those without a site, and those who could be moved here
    const sameType = realApplications().filter(
        (b) => bucket(b) !== 'declined' && (b.vendorType === 'food' ? 'food' : 'market') === site.type
    );
    const hasSite = (b) => !!((b.siteIds && b.siteIds.length) || b.siteId);
    const candidates = sameType.filter((b) => !hasSite(b));
    const movable = sameType.filter((b) => hasSite(b) && !(b.siteIds || [b.siteId]).includes(site.id));

    return `
    <header class="ad-site-panel-head">
      <h2>${esc(site.label)}</h2>
      <span class="ad-pill ${SITE_PILL[site.status] || 'ad-pill-grey'}">${esc(siteWord(site.status))}</span>
    </header>

    <dl class="ad-kvs">
      ${row('Type', typePill(site.type))}
      ${row('Column', esc(site.column || '—'))}
      ${site.notes ? row('Notes', esc(site.notes)) : ''}
    </dl>

    ${
        on
            ? `
      <h3 class="ad-drawer-h">Who is here</h3>
      <p class="ad-site-who">
        <button type="button" class="ad-linkish" data-open-booking="${attr(on.id)}">
          ${esc(vendorName(on))}
        </button>
      </p>
      <dl class="ad-kvs">
        ${row('Contact', esc((on.business && on.business.email) || '—'))}
        ${row('Status', statusPill(on))}
        ${row('Payment', paymentPill(on))}
      </dl>
      <div class="ad-actions-row" style="margin-top:14px">
        <button type="button" class="ad-btn ad-btn-danger" id="ad-site-unseat"
                data-confirm="Take ${attr(vendorName(on))} off ${attr(site.label)}? They stay in the list, just without a site.">
          Free this site
        </button>
      </div>`
            : `
      <h3 class="ad-drawer-h">Put someone here</h3>
      ${
          candidates.length || movable.length
              ? `
        <select id="ad-site-who-pick">
          <option value="">Choose a vendor…</option>
          ${
              candidates.length
                  ? '<optgroup label="Without a site">' +
                    candidates
                        .map(
                            (b) => `
            <option value="${attr(b.id)}">${esc(vendorName(b))}</option>`
                        )
                        .join('') +
                    '</optgroup>'
                  : ''
          }
          ${
              movable.length
                  ? '<optgroup label="Move here from another site">' +
                    movable
                        .map(
                            (b) => `
            <option value="${attr(b.id)}" data-from="${attr(b.siteLabel || '')}">${esc(vendorName(b))} &middot; now on ${esc(b.siteLabel || '?')}</option>`
                        )
                        .join('') +
                    '</optgroup>'
                  : ''
          }
        </select>
        <div class="ad-actions-row" style="margin-top:10px">
          <button type="button" class="ad-btn ad-btn-primary" id="ad-site-seat">Assign</button>
        </div>`
              : `<p class="ad-drawer-text ad-cell-muted">
           Nobody is waiting for a ${esc(site.type)} site.
         </p>`
      }

      <h3 class="ad-drawer-h">The site itself</h3>
      <div class="ad-actions-row">
        ${
            site.status === 'blocked'
                ? `<button type="button" class="ad-btn" id="ad-site-open">Put back on the market</button>`
                : `<button type="button" class="ad-btn" id="ad-site-block"
                     data-confirm="Block ${attr(site.label)} off so nobody can book it?">
               Block off
             </button>`
        }
      </div>`
    }

    <p class="ad-action-msg" id="ad-action-msg" hidden></p>`;
}

function wireSitePanel() {
    const site = state.sites.find((s) => s.id === state.openSiteId);
    if (!site) return;

    const jump = document.querySelector('[data-open-booking]');
    if (jump)
        jump.addEventListener('click', () => {
            state.openBookingId = jump.getAttribute('data-open-booking');
            location.hash = '#/vendors'; // Applications is not in the menu
        });

    const unseat = document.getElementById('ad-site-unseat');
    guarded(unseat, () =>
        runAction(unseat, 'adminAssignSite', {
            bookingId: site.bookingId,
            siteIds: []
        })
    );

    const seat = document.getElementById('ad-site-seat');
    if (seat)
        seat.addEventListener('click', () => {
            const pick = document.getElementById('ad-site-who-pick');
            if (!pick.value) {
                window.alert('Choose a vendor first.');
                return;
            }
            const from = pick.selectedOptions[0] && pick.selectedOptions[0].getAttribute('data-from');
            if (
                from &&
                !window.confirm(
                    'Move ' +
                        pick.selectedOptions[0].textContent.split(' · ')[0].trim() +
                        ' from ' +
                        from +
                        ' to ' +
                        site.label +
                        '? ' +
                        from +
                        ' becomes free.'
                )
            )
                return;
            runAction(seat, 'adminAssignSite', { bookingId: pick.value, siteIds: [site.id] });
        });

    const block = document.getElementById('ad-site-block');
    guarded(block, () =>
        runAction(block, 'adminSetSiteStatus', {
            eventId: state.activeEventId,
            siteId: site.id,
            status: 'blocked'
        })
    );

    const unblock = document.getElementById('ad-site-open');
    guarded(unblock, () =>
        runAction(unblock, 'adminSetSiteStatus', {
            eventId: state.activeEventId,
            siteId: site.id,
            status: 'available'
        })
    );
}
