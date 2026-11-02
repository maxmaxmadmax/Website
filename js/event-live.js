/* ==========================================================================
   EVENT LIVE - keeps an event page current with the admin.

   Any page with an element carrying data-event="<id>" asks the eventLineup
   function (cached one minute) and fills in:
     - the NOTICE banner: venue change, postponed, cancelled, or an update
     - [data-ev="name|subtitle|intro|when|time|where"]  the facts
     - [data-ev-poster]                                 the poster image / link
     - #ep-programme                                    the night's programme
     - #ep-sponsors-live                                the sponsors who said yes
   Nothing here is required: a hand-written page keeps its own words
   wherever the admin has nothing to say.
   ========================================================================== */
(function () {
    'use strict';

    var root = document.querySelector('[data-event]');
    var id = root && root.getAttribute('data-event');
    if (!id) return;

    var URL = 'https://australia-southeast1-soundzgood-8c86f.cloudfunctions.net/eventLineup?event=' + encodeURIComponent(id);

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function ampm(t) {
        var r = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
        if (!r) return '';
        var h = +r[1];
        return (h % 12 || 12) + (r[2] === '00' ? '' : ':' + r[2]) + ' ' + (h < 12 ? 'AM' : 'PM');
    }
    var NOTICE = {
        venue: 'Venue change', postponed: 'New date', cancelled: 'Cancelled', info: 'Update',
    };

    function fill(d) {
        var ev = d.event || {};

        // the facts
        document.querySelectorAll('[data-ev]').forEach(function (el) {
            var k = el.getAttribute('data-ev'), v = '';
            if (k === 'when') v = ev.dateLabel;
            else if (k === 'where') v = ev.venue;
            else if (k === 'time') v = ev.startTime ? ampm(ev.startTime) + (ev.finishTime ? ' – ' + ampm(ev.finishTime) : '') : '';
            else if (k === 'name') v = ev.name;
            else if (k === 'subtitle') v = ev.subtitle;
            else if (k === 'intro') v = ev.intro;
            else if (k === 'entry') v = ev.entryText;
            if (v) el.textContent = v;
        });
        if (ev.name && document.body.hasAttribute('data-ev-title')) document.title = ev.name + ' | SoundzGood Whitsundays';

        // the poster
        if (ev.image && /^(https:\/\/|\/)[^\s'"()<>\\]*$/.test(ev.image)) {
            document.querySelectorAll('[data-ev-poster]').forEach(function (el) {
                if (el.tagName === 'IMG') el.src = ev.image;
                else if (el.tagName === 'A') el.href = ev.image;
                var img = el.querySelector && el.querySelector('img');
                if (img) img.src = ev.image;
                el.hidden = false;
            });
        }

        // the notice
        var n = ev.notice || {};
        var box = document.getElementById('ep-notice');
        if (!box && n.kind) {
            box = document.createElement('div');
            box.id = 'ep-notice';
            var nav = document.getElementById('navbar');
            (nav && nav.parentNode ? nav.parentNode : document.body).insertBefore(box, nav ? nav.nextSibling : document.body.firstChild);
        }
        if (box) {
            if (n.kind && NOTICE[n.kind]) {
                box.className = 'ep-notice is-' + n.kind;
                box.innerHTML = '<div class="ep-notice-in">'
                    + '<p class="ep-notice-k">' + esc(NOTICE[n.kind]) + '</p>'
                    + '<h2>' + esc(n.title || NOTICE[n.kind]) + '</h2>'
                    + (n.text ? '<p>' + esc(n.text) + '</p>' : '')
                    + (n.kind === 'venue' && ev.venue ? '<p class="ep-notice-now"><b>Now at:</b> ' + esc(ev.venue) + (ev.location ? ', ' + esc(ev.location) : '') + (n.was ? ' <small>(was ' + esc(n.was) + ')</small>' : '') + '</p>' : '')
                    + (n.kind === 'postponed' && ev.dateLabel ? '<p class="ep-notice-now"><b>New date:</b> ' + esc(ev.dateLabel) + (n.was ? ' <small>(was ' + esc(n.was) + ')</small>' : '') + '</p>' : '')
                    + '</div>';
                box.hidden = false;
                document.body.classList.add('has-notice', 'has-notice-' + n.kind);
            } else {
                box.hidden = true;
            }
        }

        // the programme
        var list = document.getElementById('ep-programme');
        if (list && d.programme && d.programme.length) {
            list.innerHTML = d.programme.map(function (p) {
                return '<li><b>' + esc(ampm(p.start) || '—') + '</b> <span>' + esc(p.title)
                    + (p.who ? ' <small>' + esc(p.who) + '</small>' : '') + '</span></li>';
            }).join('');
            var sec = list.closest('[data-ep-programme]');
            if (sec) sec.hidden = false;
        }

        // the sponsors
        var sp = document.getElementById('ep-sponsors-live');
        if (sp && d.sponsors && d.sponsors.length) {
            sp.innerHTML = d.sponsors.map(function (s) { return '<li>' + esc(s.business) + '</li>'; }).join('');
            var ss = sp.closest('[data-ep-sponsors]');
            if (ss) ss.hidden = false;
        }
    }

    fetch(URL).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) { if (d) fill(d); }).catch(function () { /* the page keeps its own words */ });
}());
