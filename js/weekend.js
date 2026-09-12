/* ==========================================================================
   WHAT IS ON, SHARED

   Two pages ask the same three questions: which events are there, which
   weekend is "this weekend", and what does a card look like. This answers
   all three, once, for both of them.

   Used by:
     js/gig-guide.js     the full guide at /gig-guide
     js/events.js        the This Weekend strip under the featured event

   WHY THIS FILE EXISTS
   Because "the current weekend" is exactly the kind of thing that gets
   written twice and then quietly disagrees - one page counting Friday as
   the start and the other counting it as the end, and nobody noticing
   until somebody drives to a gig on the wrong day. It is defined here and
   nowhere else.

   Loaded before both of those scripts, and it publishes itself as
   window.SGWeekend. No modules: the rest of the site's page scripts are
   plain scripts with defer, and one file doing something different would
   be a trap for whoever edits it next.
   ========================================================================== */
(function (global) {
    'use strict';

    /*  These two are public because the pages that read gigs also read the
        status document next to them, and the key is the same either way.
        A Firebase web key is an identifier, not a password - what protects
        the data is firestore.rules, which let the world read gigs and
        nobody write them. It is the same key that is already sitting in
        js/firebase-config.js.                                            */
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

       Friday through Sunday, and on a Saturday or a Sunday that means the
       weekend you are standing in, not the next one. Somebody reading this
       on Saturday morning wants tonight, not six days away.
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

       Straight from Firestore's REST interface rather than by loading the
       Firebase library - these pages only read one small public
       collection, and the library is a hundred kilobytes to do that.
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
        loadStatus: loadStatus,
        card: card,
        esc: esc,
        DAYS: DAYS,
        MONTHS: MONTHS
    };
}(window));
