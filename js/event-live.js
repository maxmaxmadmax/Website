/* ==========================================================================
   EVENT LIVE - keeps an event page current with the admin.

   Any page with data-event="<id>" asks the eventLineup function (cached one
   minute) and fills in what the admin has set. A hand-written page keeps its
   own words wherever the admin has nothing to say.

   FACTS        [data-ev="name|subtitle|intro|when|time|where|entry"]
   GOING        the "I'm coming" button and count
   POSTER       [data-ev-poster] image / link
   NOTICE       venue change, new date, cancelled, update (sticky bar)
   PROGRAMME    #ep-programme and the cover copy
   ENTERTAINMENT   #ep-ent, built from the featured programme lines
   FAQ          #ep-faq
   SPONSORS     #ep-sponsors-live
   ========================================================================== */
(function () {
    'use strict';

    var root = document.querySelector('[data-event]');
    var id = root && root.getAttribute('data-event');
    if (!id) return;

    var FN = 'https://australia-southeast1-soundzgood-8c86f.cloudfunctions.net/';
    var esc = window.SG.esc;

    /* "19:30" -> "7:30 PM" */
    function ampm(t) {
        var r = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
        if (!r) return '';
        var h = +r[1];
        return (h % 12 || 12) + (r[2] === '00' ? '' : ':' + r[2]) + ' ' + (h < 12 ? 'AM' : 'PM');
    }

    /* Shows a section once its list has something in it */
    function reveal(el, attr) {
        var sec = el.closest('[' + attr + ']');
        if (sec) sec.hidden = false;
    }

    fetch(FN + 'eventLineup?event=' + encodeURIComponent(id))
        .then(function (r) {
            return r.ok ? r.json() : null;
        })
        .then(function (d) {
            if (!d) return;
            var ev = d.event || {};
            fillFacts(ev);
            fillGoing(ev);
            fillPoster(ev);
            fillNotice(ev);
            fillProgramme(d.programme || []);
            fillEntertainment(d.programme || []);
            fillFaq(ev);
            fillSponsors(d.sponsors || []);
        })
        .catch(function () {
            /* the page keeps its own words */
        });

    /* ======================================================================
       FACTS
       ====================================================================== */
    function fillFacts(ev) {
        var text = {
            name: ev.name,
            subtitle: ev.subtitle,
            intro: ev.intro,
            when: ev.dateLabel,
            where: ev.venue,
            entry: ev.entryText,
            time: ev.startTime ? ampm(ev.startTime) + (ev.finishTime ? ' – ' + ampm(ev.finishTime) : '') : ''
        };
        document.querySelectorAll('[data-ev]').forEach(function (el) {
            var v = text[el.getAttribute('data-ev')];
            if (v) el.textContent = v;
        });
        if (ev.name && document.body.hasAttribute('data-ev-title')) document.title = ev.name + ' | SoundzGood Whitsundays';
    }

    /* ======================================================================
       GOING - a tap, how many, then the count. Remembered on this phone so
       it only counts once.
       ====================================================================== */
    function fillGoing(ev) {
        var going = document.getElementById('ep-going');
        if (!going) return;

        var btn = document.getElementById('ep-going-btn');
        var ask = document.getElementById('ep-going-ask');
        var count = document.getElementById('ep-going-count');
        var key = 'sg-going-' + id;
        var mine = 0;
        try {
            mine = +(localStorage.getItem(key) || 0);
        } catch (e) {
            /* private mode */
        }

        var paint = function (n) {
            count.textContent = n ? n + (n === 1 ? ' person is coming' : ' people are coming') : "Be the first to say you're coming";
        };
        var done = function (n) {
            btn.textContent = '✓ You’re coming' + (n > 1 ? ' (' + n + ')' : '');
            btn.disabled = true;
        };

        paint(ev.going || 0);
        going.hidden = false;
        if (mine) done(mine);

        btn.addEventListener('click', function () {
            ask.hidden = !ask.hidden;
        });

        ask.querySelectorAll('[data-going]').forEach(function (b) {
            b.addEventListener('click', function () {
                var n = +b.getAttribute('data-going');
                ask.hidden = true;
                btn.disabled = true;
                btn.textContent = 'Counting you in…';
                fetch(FN + 'rsvpEvent', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ data: { eventId: id, people: n } })
                })
                    .then(function (r) {
                        return r.json();
                    })
                    .then(function (j) {
                        var res = (j && j.result) || {};
                        if (!res.ok) throw new Error((j && j.error && j.error.message) || 'no');
                        try {
                            localStorage.setItem(key, String(n));
                        } catch (e) {
                            /* fine */
                        }
                        done(n);
                        paint(res.going);
                    })
                    .catch(function () {
                        btn.disabled = false;
                        btn.textContent = '🎉 I’m coming';
                        alert('That didn’t go through - try again in a moment.');
                    });
            });
        });
    }

    /* ======================================================================
       POSTER
       ====================================================================== */
    function fillPoster(ev) {
        if (!ev.image || !/^(https:\/\/|\/)[^\s'"()<>\\]*$/.test(ev.image)) return;
        document.querySelectorAll('[data-ev-poster]').forEach(function (el) {
            if (el.tagName === 'IMG') el.src = ev.image;
            else if (el.tagName === 'A') el.href = ev.image;
            var img = el.querySelector && el.querySelector('img');
            if (img) img.src = ev.image;
            el.hidden = false;
        });
    }

    /* ======================================================================
       NOTICE
       ====================================================================== */
    var NOTICE = { venue: 'Venue change', postponed: 'New date', cancelled: 'Cancelled', info: 'Update' };

    function fillNotice(ev) {
        var n = ev.notice || {};
        var box = document.getElementById('ep-notice');

        if (!box && n.kind) {
            box = document.createElement('div');
            box.id = 'ep-notice';
            var nav = document.getElementById('navbar');
            (nav && nav.parentNode ? nav.parentNode : document.body).insertBefore(box, nav ? nav.nextSibling : document.body.firstChild);
        }
        if (!box) return;

        if (!n.kind || !NOTICE[n.kind]) {
            box.hidden = true;
            return;
        }

        var was = n.was ? ' <small>(was ' + esc(n.was) + ')</small>' : '';
        var now = '';
        if (n.kind === 'venue' && ev.venue)
            now = '<p class="ep-notice-now"><b>Now at:</b> ' + esc(ev.venue) + (ev.location ? ', ' + esc(ev.location) : '') + was + '</p>';
        if (n.kind === 'postponed' && ev.dateLabel) now = '<p class="ep-notice-now"><b>New date:</b> ' + esc(ev.dateLabel) + was + '</p>';

        box.className = 'ep-notice is-' + n.kind;
        box.innerHTML =
            '<div class="ep-notice-in">' +
            '<p class="ep-notice-k">' +
            esc(NOTICE[n.kind]) +
            '</p>' +
            '<h2>' +
            esc(n.title || NOTICE[n.kind]) +
            '</h2>' +
            (n.text ? '<p>' + esc(n.text) + '</p>' : '') +
            now +
            '</div>';
        box.hidden = false;
        document.body.classList.add('has-notice', 'has-notice-' + n.kind);
    }

    /* ======================================================================
       PROGRAMME - the run sheet, on the page and again on the print cover
       ====================================================================== */
    function fillProgramme(programme) {
        var timed = programme.filter(function (p) {
            return p.start;
        });
        if (!timed.length) return;

        var html = timed
            .map(function (p) {
                return (
                    '<li><b>' +
                    esc(ampm(p.start)) +
                    '</b> <span>' +
                    esc(p.title) +
                    (p.who ? ' <small>' + esc(p.who) + '</small>' : '') +
                    '</span></li>'
                );
            })
            .join('');

        ['ep-programme', 'ep-programme-cover'].forEach(function (listId) {
            var list = document.getElementById(listId);
            if (!list) return;
            list.innerHTML = html;
            list.hidden = false;
            reveal(list, 'data-ep-programme');
        });
    }

    /* ======================================================================
       ENTERTAINMENT - the Halloween layout from the featured lines: two wide
       text tiles on top, then the headline tall on the left (photo on top)
       and the rest stacked on the right - photo tiles as photo-beside-text,
       plain ones alternating lime and cream.
       ====================================================================== */
    var KIND = { act: 'Live on stage', activity: 'On the night', food: 'Food & drink', moment: "Don't miss" };

    function fillEntertainment(programme) {
        var ent = document.getElementById('ep-ent');
        var feats = programme.filter(function (p) {
            return p.featured || p.headline;
        });
        if (!ent || !feats.length) return;

        var kicker = function (p) {
            return (
                '<p class="ep-kicker">' + esc(KIND[p.kind] || 'On the night') + (p.start ? ' &middot; ' + esc(ampm(p.start)) : '') + '</p>'
            );
        };
        var h3 = function (p) {
            return '<h3>' + esc(p.title) + (p.who ? '<br><span>' + esc(p.who) + '</span>' : '') + '</h3>';
        };
        var text = function (p) {
            return (
                (p.blurb ? '<p>' + esc(p.blurb) + '</p>' : '') +
                (p.link ? '<a class="ep-ent-link" href="' + esc(p.link) + '" target="_blank" rel="noopener">More &rarr;</a>' : '')
            );
        };
        var words = function (p) {
            return kicker(p) + h3(p) + text(p);
        };

        var head = feats.find(function (p) {
            return p.headline;
        });
        var top = [];
        var side = [];
        feats.forEach(function (p) {
            if (p === head) return;
            if (!p.photo && top.length < 2) top.push(p);
            else side.push(p);
        });
        if (!side.length && top.length) side.push(top.pop());

        var html = '';
        if (top.length) {
            html +=
                '<div class="ep-top2">' +
                top
                    .map(function (p, i) {
                        return (
                            '<article class="ep-ent-card ' + (i === 0 ? 'ep-ent-treat' : 'ep-ent-dress') + '">' + words(p) + '</article>'
                        );
                    })
                    .join('') +
                '</div>';
        }

        var rows = Math.max(1, side.length);
        html += '<div class="ep-ent ep-ent-gen" style="grid-template-rows:repeat(' + rows + ', auto)">';

        if (head) {
            html +=
                '<article class="ep-ent-card ep-ent-band" style="grid-column:1;grid-row:1 / span ' +
                rows +
                '">' +
                (head.photo ? '<img class="ep-ent-photo" src="' + esc(head.photo) + '" alt="">' : '') +
                '<div class="ep-ent-band-text">' +
                words(head) +
                '</div></article>';
        }

        var lime = 0;
        side.forEach(function (p, i) {
            var place = 'style="grid-column:' + (head ? 2 : i % 2 ? 2 : 1) + ';grid-row:' + (head ? i + 1 : Math.floor(i / 2) + 1) + '"';
            if (p.photo) {
                html +=
                    '<article class="ep-ent-card ep-ent-hosts ep-ent-side" ' +
                    place +
                    '><img class="ep-ent-hosts-pic" src="' +
                    esc(p.photo) +
                    '" alt=""><div>' +
                    words(p) +
                    '</div></article>';
            } else {
                html +=
                    '<article class="ep-ent-card ' +
                    (lime++ % 2 ? 'ep-ent-dress' : 'ep-ent-bingo') +
                    ' ep-ent-side" ' +
                    place +
                    '>' +
                    words(p) +
                    '</article>';
            }
        });

        ent.innerHTML = html + '</div>';
        reveal(ent, 'data-ep-ent');
    }

    /* ======================================================================
       FAQ
       ====================================================================== */
    function fillFaq(ev) {
        var faq = document.getElementById('ep-faq');
        if (!faq || !ev.faq || !ev.faq.length) return;

        faq.innerHTML = ev.faq
            .map(function (x) {
                return (
                    '<li class="ep-faq-item"><span class="ep-faq-ic" aria-hidden="true"><b>?</b></span><div><b>' +
                    esc(x.q) +
                    '</b><p>' +
                    esc(x.a) +
                    '</p></div></li>'
                );
            })
            .join('');
        reveal(faq, 'data-ep-faq');
    }

    /* ======================================================================
       SPONSORS - the ones who said yes; a logo, or the name
       ====================================================================== */
    function fillSponsors(sponsors) {
        var sp = document.getElementById('ep-sponsors-live');
        if (!sp || !sponsors.length) return;

        sp.innerHTML = sponsors
            .map(function (s) {
                var inner = s.logo
                    ? '<img src="' + esc(s.logo) + '" alt="' + esc(s.business) + '">'
                    : '<span class="ep-sponsor-name">' + esc(s.business) + '</span>';
                return (
                    '<li>' +
                    (s.website ? '<a href="' + esc(s.website) + '" target="_blank" rel="noopener">' + inner + '</a>' : inner) +
                    '</li>'
                );
            })
            .join('');
        reveal(sp, 'data-ep-sponsors');
    }
})();
