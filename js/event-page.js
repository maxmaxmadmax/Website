/* ==========================================================================
   EVENT PAGE (for punters) - /eatz-beatz-halloween-2026

   Two small jobs:
     1. The Share button - the phone's share sheet, or copy the link.
     2. "Who's coming" - asks the eventLineup function for the confirmed,
        paid vendors (business name and category only) and lists them.
        No vendors yet, or the call fails -> the section stays hidden.
        Fetched fresh on every visit, so new paid vendors appear on their
        own (the function caches for 5 minutes). "Other ..." categories
        are left off - they say nothing to a punter.
   ========================================================================== */
(function () {
    'use strict';

    /* ---- 1. Share ---- */
    var share = document.getElementById('ep-share');
    if (share) {
        share.addEventListener('click', function () {
            var data = { title: document.title, url: location.href.split('#')[0] };
            if (navigator.share) {
                navigator.share(data).catch(function () { /* they closed it */ });
                return;
            }
            var note = document.getElementById('ep-share-note');
            (navigator.clipboard ? navigator.clipboard.writeText(data.url) : Promise.reject())
                .then(function () { if (note) note.hidden = false; })
                .catch(function () { prompt('Copy this link:', data.url); });
        });
    }

    /* ---- 2. Who's coming ---- */
    var box = document.getElementById('ep-lineup');
    if (!box) return;

    var URL = 'https://australia-southeast1-soundzgood-8c86f.cloudfunctions.net/eventLineup?event=' +
              encodeURIComponent(box.getAttribute('data-event'));

    function esc(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function fill(id, rows) {
        var el = document.getElementById(id);
        if (!el || !rows || !rows.length) return false;
        el.querySelector('ul').innerHTML = rows.map(function (r) {
            /*  The vendor's own link (checked server side: http/https only).
                Opens in a new tab; nofollow because we don't vouch for it. */
            var name = r.link && /^https?:\/\//i.test(r.link)
                ? '<a href="' + esc(r.link).replace(/"/g, '&quot;') + '" target="_blank" rel="noopener nofollow ugc">' +
                  esc(r.name) + ' <i aria-hidden="true">&#8599;</i></a>'
                : esc(r.name);
            return '<li><b>' + name + '</b>' +
                   (r.category && !/^other/i.test(r.category) ? ' <span>' + esc(r.category) + '</span>' : '') + '</li>';
        }).join('');
        el.hidden = false;
        return true;
    }

    fetch(URL)
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
            if (!d) return;
            var any = fill('ep-food', d.food);
            any = fill('ep-market', d.market) || any;
            if (any) box.hidden = false;
        })
        .catch(function () { /* stays hidden */ });
}());
