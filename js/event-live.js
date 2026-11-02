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

        // "I'm coming": a tap, how many, then the count. Remembered on this phone so it only counts once.
        var going = document.getElementById('ep-going');
        if (going) {
            var btn = document.getElementById('ep-going-btn'), ask = document.getElementById('ep-going-ask'), count = document.getElementById('ep-going-count');
            var key = 'sg-going-' + id;
            var mine = 0;
            try { mine = +(localStorage.getItem(key) || 0); } catch (e) { /* private mode */ }
            var paint = function (n) { count.textContent = n ? n + (n === 1 ? ' person is coming' : ' people are coming') : 'Be the first to say you\'re coming'; };
            paint(ev.going || 0);
            going.hidden = false;
            if (mine) { btn.textContent = '\u2713 You\u2019re coming' + (mine > 1 ? ' (' + mine + ')' : ''); btn.disabled = true; }
            btn.addEventListener('click', function () { ask.hidden = !ask.hidden; });
            ask.querySelectorAll('[data-going]').forEach(function (b) {
                b.addEventListener('click', function () {
                    var n = +b.getAttribute('data-going');
                    ask.hidden = true; btn.disabled = true; btn.textContent = 'Counting you in\u2026';
                    fetch('https://australia-southeast1-soundzgood-8c86f.cloudfunctions.net/rsvpEvent', {
                        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: { eventId: id, people: n } }),
                    }).then(function (r) { return r.json(); }).then(function (j) {
                        var res = (j && j.result) || {};
                        if (!res.ok) throw new Error((j && j.error && j.error.message) || 'no');
                        try { localStorage.setItem(key, String(n)); } catch (e) { /* fine */ }
                        btn.textContent = '\u2713 You\u2019re coming' + (n > 1 ? ' (' + n + ')' : '');
                        paint(res.going);
                    }).catch(function () { btn.disabled = false; btn.textContent = '\uD83C\uDF89 I\u2019m coming'; alert('That didn\u2019t go through - try again in a moment.'); });
                });
            });
        }

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
        var timed = (d.programme || []).filter(function (p) { return p.start; });
        var timesHtml = timed.map(function (p) {
            return '<li><b>' + esc(ampm(p.start)) + '</b> <span>' + esc(p.title)
                + (p.who ? ' <small>' + esc(p.who) + '</small>' : '') + '</span></li>';
        }).join('');
        ['ep-programme', 'ep-programme-cover'].forEach(function (id) {
            var list = document.getElementById(id);
            if (!list || !timed.length) return;
            list.innerHTML = timesHtml;
            list.hidden = false;
            var sec = list.closest('[data-ep-programme]');
            if (sec) sec.hidden = false;
        });

        // the entertainment cards: the hand-made Halloween layout, built from the featured programme lines.
        // Two wide text cards on top; then the headline (photo on top) tall on the left, the rest stacked on the right -
        // photo cards as photo-beside-text, plain ones alternating lime and cream.
        var ent = document.getElementById('ep-ent');
        var feats = (d.programme || []).filter(function (p) { return p.featured || p.headline; });
        if (ent && feats.length) {
            var KIND = { act: 'Live on stage', activity: 'On the night', food: 'Food & drink', moment: "Don't miss" };
            var kicker = function (p) { return esc(KIND[p.kind] || 'On the night') + (p.start ? ' &middot; ' + esc(ampm(p.start)) : ''); };
            var head = feats.find(function (p) { return p.headline; });
            var rest = feats.filter(function (p) { return p !== head; });
            var top = [], side = [];
            rest.forEach(function (p) { if (!p.photo && top.length < 2) top.push(p); else side.push(p); });
            if (!side.length && top.length) side.push(top.pop());
            var h3 = function (p) { return '<h3>' + esc(p.title) + (p.who ? '<br><span>' + esc(p.who) + '</span>' : '') + '</h3>'; };
            var text = function (p) { return (p.blurb ? '<p>' + esc(p.blurb) + '</p>' : '') + (p.link ? '<a class="ep-ent-link" href="' + esc(p.link) + '" target="_blank" rel="noopener">More &rarr;</a>' : ''); };
            var html = '';
            if (top.length) {
                html += '<div class="ep-top2">' + top.map(function (p, i) {
                    return '<article class="ep-ent-card ' + (i === 0 ? 'ep-ent-treat' : 'ep-ent-dress') + '"><p class="ep-kicker">' + kicker(p) + '</p>' + h3(p) + text(p) + '</article>';
                }).join('') + '</div>';
            }
            var n = Math.max(1, side.length);
            html += '<div class="ep-ent ep-ent-gen" style="grid-template-rows:repeat(' + n + ', auto)">';
            if (head) {
                html += '<article class="ep-ent-card ep-ent-band" style="grid-column:1;grid-row:1 / span ' + n + '">'
                    + (head.photo ? '<img class="ep-ent-photo" src="' + esc(head.photo) + '" alt="">' : '')
                    + '<div class="ep-ent-band-text"><p class="ep-kicker">' + kicker(head) + '</p>' + h3(head) + text(head) + '</div></article>';
            }
            var lime = 0;
            side.forEach(function (p, i) {
                var row = 'style="grid-column:' + (head ? 2 : (i % 2 ? 2 : 1)) + ';grid-row:' + (head ? i + 1 : Math.floor(i / 2) + 1) + '"';
                if (p.photo) {
                    html += '<article class="ep-ent-card ep-ent-hosts ep-ent-side" ' + row + '><img class="ep-ent-hosts-pic" src="' + esc(p.photo) + '" alt=""><div><p class="ep-kicker">' + kicker(p) + '</p>' + h3(p) + text(p) + '</div></article>';
                } else {
                    html += '<article class="ep-ent-card ' + (lime++ % 2 ? 'ep-ent-dress' : 'ep-ent-bingo') + ' ep-ent-side" ' + row + '><p class="ep-kicker">' + kicker(p) + '</p>' + h3(p) + text(p) + '</article>';
                }
            });
            html += '</div>';
            ent.innerHTML = html;
            var es = ent.closest('[data-ep-ent]');
            if (es) es.hidden = false;
        }

        // the FAQs
        var faq = document.getElementById('ep-faq');
        if (faq && ev.faq && ev.faq.length) {
            faq.innerHTML = ev.faq.map(function (x) {
                return '<li class="ep-faq-item"><span class="ep-faq-ic" aria-hidden="true"><b>?</b></span><div><b>' + esc(x.q) + '</b><p>' + esc(x.a) + '</p></div></li>';
            }).join('');
            var fs2 = faq.closest('[data-ep-faq]');
            if (fs2) fs2.hidden = false;
        }

        // the sponsors
        var sp = document.getElementById('ep-sponsors-live');
        if (sp && d.sponsors && d.sponsors.length) {
            sp.innerHTML = d.sponsors.map(function (s) {
                var inner = s.logo ? '<img src="' + esc(s.logo) + '" alt="' + esc(s.business) + '">' : '<span class="ep-sponsor-name">' + esc(s.business) + '</span>';
                return '<li>' + (s.website ? '<a href="' + esc(s.website) + '" target="_blank" rel="noopener">' + inner + '</a>' : inner) + '</li>';
            }).join('');
            var ss = sp.closest('[data-ep-sponsors]');
            if (ss) ss.hidden = false;
        }
    }

    fetch(URL).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) { if (d) fill(d); }).catch(function () { /* the page keeps its own words */ });

    // VOLUNTEER FORM -> volunteerApply
    var vf = document.getElementById('ep-vol-form');
    if (vf) vf.addEventListener('submit', function (e) {
        e.preventDefault();
        var msg = document.getElementById('ep-vol-msg'), btn = vf.querySelector('button[type="submit"]');
        var fd = new FormData(vf);
        var data = { eventId: id, name: fd.get('name'), email: fd.get('email'), phone: fd.get('phone'), roles: fd.getAll('roles'), availability: fd.get('availability'), message: fd.get('message') };
        btn.disabled = true; btn.textContent = 'Sending\u2026'; msg.hidden = true;
        fetch('https://australia-southeast1-soundzgood-8c86f.cloudfunctions.net/volunteerApply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: data }) })
            .then(function (r) { return r.json(); })
            .then(function (j) {
                var res = (j && j.result) || {};
                if (!res.ok) throw new Error((j && j.error && j.error.message) || 'Could not send.');
                vf.querySelectorAll('input, textarea, fieldset').forEach(function (el) { el.disabled = true; });
                btn.textContent = res.already ? '\u2713 Already on the list' : '\u2713 Thanks - we\u2019ll be in touch';
                msg.hidden = false; msg.textContent = res.already ? 'You\u2019ve already put your hand up for this one - we have your details.' : 'Thank you! Max will text or email you before the event.';
            })
            .catch(function (err) { btn.disabled = false; btn.textContent = 'Count me in \u2192'; msg.hidden = false; msg.textContent = err.message || 'That didn\u2019t go through - try again.'; });
    });
}());
