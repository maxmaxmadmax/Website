/* ==========================================================================
   WHAT IS ON, SHARED

   Which events there are, which weekend is "this weekend", and what a card
   looks like - defined once here so the two pages can never disagree.

   Used by:
     js/gig-guide.js     the full guide at /gig-guide
     js/events.js        the This Weekend strip under the featured event

   Loaded before both of those scripts, and publishes itself as
   window.SGWeekend. A plain script with defer, like the other page scripts.
   ========================================================================== */
(function (global) {
    'use strict';

    /*  Public on purpose: a Firebase web key is an identifier, not a
        password. firestore.rules protect the data (anyone can read gigs,
        nobody can write them). Same key as js/firebase-config.js.        */
    var PROJECT = 'soundzgood-8c86f';
    var WEB_KEY = 'AIzaSyCVWdD7fE24MuN-v5XQLObJbSHYRUbPlPY';
    var REST = 'https://firestore.googleapis.com/v1/projects/' + PROJECT +
               '/databases/(default)/documents/';

    var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    function midnight(d) {
        return new Date(d.getFullYear(), d.getMonth(), d.getDate());
    }

    function today() {
        return midnight(new Date());
    }

    /*  A date written 'YYYY-MM-DD' read as a local date. new Date(string)
        would read it as UTC and hand back the evening before for anybody
        in Queensland, which is how a Saturday gig turns into a Friday one. */
    function parseDay(iso) {
        var p = String(iso).split('-');
        return new Date(+p[0], +p[1] - 1, +p[2]);
    }

    /* ----------------------------------------------------------------------
       THIS WEEKEND

       Friday through Sunday. On a Saturday or Sunday that means the
       weekend you are in, not the next one.
       ---------------------------------------------------------------------- */
    function weekendRange(from) {
        var now = from ? midnight(from) : today();
        var dow = now.getDay();              /* 0 Sunday ... 6 Saturday */
        var start = new Date(now);

        if (dow === 0) start.setDate(start.getDate() - 2);        /* Sunday */
        else if (dow === 6) start.setDate(start.getDate() - 1);   /* Saturday */
        else start.setDate(start.getDate() + (5 - dow));          /* the Friday ahead */

        var end = new Date(start);
        end.setDate(end.getDate() + 2);

        return { start: start, end: end };
    }

    function isThisWeekend(day, range) {
        if (!day) return false;
        var w = range || weekendRange();
        return day >= w.start && day <= w.end;
    }

    /* ----------------------------------------------------------------------
       READING THEM

       Straight from Firestore's REST interface - much lighter than loading
       the Firebase library for one small public collection.
       ---------------------------------------------------------------------- */
    function plain(fields) {
        var out = {};
        Object.keys(fields || {}).forEach(function (k) {
            var v = fields[k];
            out[k] = v.stringValue !== undefined ? v.stringValue
                   : v.integerValue !== undefined ? parseInt(v.integerValue, 10)
                   : v.timestampValue !== undefined ? v.timestampValue
                   : v.booleanValue !== undefined ? v.booleanValue
                   : '';
        });
        return out;
    }

    function loadGigs() {
        return fetch(REST + 'gigs?pageSize=300&key=' + WEB_KEY)
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function (body) {
                return (body.documents || []).map(function (doc) {
                    var d = plain(doc.fields);

                    return {
                        name: d.name,
                        day: d.start ? parseDay(d.start) : null,
                        time: d.time,
                        venue: d.venue + (d.suburb && d.venue.indexOf(d.suburb) < 0
                                            ? ', ' + d.suburb : ''),
                        area: d.area,
                        img: d.image,
                        url: d.url,
                        source: d.source,
                        tags: [],
                        cats: []
                    };
                }).sort(function (a, b) {
                    if (!a.day && !b.day) return 0;
                    if (!a.day) return 1;
                    if (!b.day) return -1;
                    return a.day - b.day;
                });
            });
    }

    /*  Any small public collection, as plain objects with their document
        id attached. Used for the Friday Nights line up; the gigs above
        get their own reader because they need shaping.                  */
    function loadCollection(name) {
        return fetch(REST + encodeURIComponent(name) + '?pageSize=200&key=' + WEB_KEY)
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function (body) {
                return (body.documents || []).map(function (doc) {
                    var out = plain(doc.fields);
                    /*  ".../documents/fridayNights/2026-09-18" - the id is
                        the date, which is what the caller looks up by. */
                    out.id = doc.name.split('/').pop();
                    return out;
                });
            });
    }

    function loadStatus() {
        return fetch(REST + 'gigGuide/status?key=' + WEB_KEY)
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (body) { return body ? plain(body.fields) : null; });
    }

    /* ----------------------------------------------------------------------
       DRAWING ONE
       ---------------------------------------------------------------------- */
    function esc(s) {
        return String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function chip(ev) {
        if (!ev.day) {
            return '<span class="gg-chip is-tba"><b>' +
                   esc(ev.dateText || 'TBA') + '</b></span>';
        }

        return '<span class="gg-chip">' +
               '<i>' + DAYS[ev.day.getDay()].toUpperCase() + '</i>' +
               '<b>' + ev.day.getDate() + '</b>' +
               '<i>' + MONTHS[ev.day.getMonth()].toUpperCase() + '</i>' +
               '</span>';
    }

    function card(ev) {
        var art = ev.img ? ' style="--gg-art:url(\'' + esc(ev.img) + '\')"' : '';

        return '' +
            '<article class="gg-card"' + art + '>' +
              '<div class="gg-card-art" aria-hidden="true"></div>' +
              chip(ev) +
              '<div class="gg-card-body">' +
                '<h3>' + esc(ev.name) + '</h3>' +
                (ev.venue ? '<p class="gg-where">' + esc(ev.venue) + '</p>' : '') +
                (ev.time ? '<p class="gg-when">' + esc(ev.time) + '</p>' : '') +
                (ev.tags && ev.tags.length
                    ? '<ul class="gg-tags">' +
                      ev.tags.map(function (t) {
                          return '<li>' + esc(t) + '</li>';
                      }).join('') + '</ul>'
                    : '') +
                (ev.url
                    ? '<a class="gg-via" href="' + esc(ev.url) + '"' +
                      ' target="_blank" rel="noopener nofollow">' +
                      (ev.source ? 'Details via ' + esc(ev.source) : 'Event details') +
                      '</a>'
                    : '') +
              '</div>' +
            '</article>';
    }

    global.SGWeekend = {
        today: today,
        parseDay: parseDay,
        weekendRange: weekendRange,
        isThisWeekend: isThisWeekend,
        loadGigs: loadGigs,
        loadCollection: loadCollection,
        loadStatus: loadStatus,
        card: card,
        esc: esc,
        DAYS: DAYS,
        MONTHS: MONTHS
    };
}(window));
