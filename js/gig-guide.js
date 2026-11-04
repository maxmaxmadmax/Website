/* ==========================================================================
   GIG GUIDE - one list of events, and everything on the page built from it.
   Our own listings are below; the rest come from the database (filled daily
   by syncGigGuide) via js/weekend.js and are merged here, so a bad sync can
   never touch our own. If the database is unreachable the page still shows
   the hand-written list. The slider is window.SGSlider from js/main.js.

   LISTINGS    our own events - the only part to edit
   DATES       midnight today, ISO day parsing
   THE LIST    repeating events expanded to dates, found events added
   FILTERING   search, type, place and when
   DRAWING     the weekend row and the highlights slider
   CONTROLS    pills and menus kept in step, subscribe box, hero clip
   START       draw now, redraw when the found events arrive
   ========================================================================== */

/* ==========================================================================
   LISTINGS - copy a block and change the words. Only real events.

       name    what it is called
       date    'YYYY-MM-DD'. Leave it null if the date is not out yet and
               put something in dateText instead.
       every   'friday' for something on every week. Use this OR date,
               never both - the guide works out the next dozen Fridays.
       until   optional, 'YYYY-MM-DD' - the last week a repeating event
               runs. Leave it out and it runs forever.
       time    as you would say it out loud. Leave it out if unknown.
       venue   where it is
       area    one of: bowen airlie proserpine collinsville whitsundays
               surrounding    (this is what the location filter matches)
       cats    any of: live dj family markets festivals sport community
               food arts       (this is what the type pills match)
       tags    the words printed on the card. Usually the same as cats,
               written out properly.
       img     optional photo, e.g. 'images/gigs/eatz-beatz.jpg'. Without
               one the card shows its dark tile.
       big     true puts it in Upcoming Highlights rather than the weekend
               row, whatever the date says.
   ========================================================================== */
var GG_LISTINGS = [
    {
        name: 'Friday Nights',
        every: 'friday',
        time: '9:30 PM – Late',
        venue: 'The Grand View Hotel, Bowen',
        area: 'bowen',
        cats: ['dj', 'live'],
        tags: ['DJ', 'Nightlife', 'Free Entry'],
        img: ''
    },

    {
        name: 'Eatz & Beatz — Halloween Edition',
        date: '2026-10-31',
        venue: 'Bowen Sports Complex',
        area: 'bowen',
        cats: ['markets', 'food', 'family', 'live'],
        tags: ['Food', 'Markets', 'Music', 'Family'],
        img: '',
        big: true
    },

    {
        name: 'SoundzGood — Next Chapter',
        date: null,
        dateText: '2027',
        venue: 'Bowen, QLD',
        area: 'bowen',
        cats: ['festivals', 'live'],
        tags: ['Festival', 'Music', 'Coming Soon'],
        img: '',
        big: true
    }
];

(function () {
    'use strict';

    var page = document.getElementById('sg-gig-guide');
    if (!page) return;

    var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    var REPEAT_WEEKS = 12; // how far ahead a repeating event is worked out

    var W = window.SGWeekend; // shared with /events: weekend range, found gigs, card
    var weekendRange = W.weekendRange;

    var filters = { text: '', cat: 'all', place: 'all', when: 'all' };

    /* ======================================================================
       DATES - from midnight today, so an event this afternoon is still today
       ====================================================================== */
    function midnight(d) {
        return new Date(d.getFullYear(), d.getMonth(), d.getDate());
    }

    function parseDay(iso) {
        var p = String(iso).split('-');
        return new Date(+p[0], +p[1] - 1, +p[2]);
    }

    var today = midnight(new Date());

    /* ======================================================================
       THE LIST - every event in one shape, repeats expanded to real dates
       ====================================================================== */
    function expand() {
        var out = [];

        GG_LISTINGS.forEach(function (ev) {
            if (ev.every) {
                var want = DAYS.indexOf(ev.every.slice(0, 1).toUpperCase() + ev.every.slice(1, 3));
                if (want < 0) return;

                var d = new Date(today);
                d.setDate(d.getDate() + ((want - d.getDay() + 7) % 7));

                var stop = ev.until ? parseDay(ev.until) : null;

                for (var i = 0; i < REPEAT_WEEKS; i++) {
                    if (stop && d > stop) break;
                    out.push(occurrence(ev, new Date(d)));
                    d.setDate(d.getDate() + 7);
                }
                return;
            }

            out.push(occurrence(ev, ev.date ? parseDay(ev.date) : null));
        });

        return out.sort(byDay);
    }

    /* Soonest first, undated last */
    function byDay(a, b) {
        if (!a.day && !b.day) return 0;
        if (!a.day) return 1;
        if (!b.day) return -1;
        return a.day - b.day;
    }

    function occurrence(ev, day) {
        return {
            src: ev,
            day: day,
            name: ev.name,
            time: ev.time || '',
            venue: ev.venue || '',
            area: ev.area || '',
            cats: ev.cats || [],
            tags: ev.tags || [],
            img: ev.img || '',
            big: !!ev.big,
            dateText: ev.dateText || '',
            url: ev.url || '',
            source: ev.source || ''
        };
    }

    var events = expand();

    /* The same call the This Weekend strip on /events makes. A source that
       publishes no categories only matches the All pill. */
    function loadFound() {
        return W.loadGigs().then(function (rows) {
            return rows.map(function (r) {
                return occurrence(r, r.day);
            });
        });
    }

    /* ======================================================================
       FILTERING
       ====================================================================== */
    function matches(ev) {
        if (filters.cat !== 'all' && ev.cats.indexOf(filters.cat) < 0) return false;
        if (filters.place !== 'all' && ev.area !== filters.place) return false;

        if (filters.text) {
            var hay = (ev.name + ' ' + ev.venue + ' ' + ev.tags.join(' ')).toLowerCase();
            if (hay.indexOf(filters.text) < 0) return false;
        }

        if (filters.when !== 'all') {
            if (!ev.day) return false; // undated events drop out of any dated view

            if (filters.when === 'weekend') {
                var w = weekendRange();
                if (ev.day < w.start || ev.day > w.end) return false;
            } else {
                var limit = new Date(today);
                limit.setDate(limit.getDate() + parseInt(filters.when, 10));
                if (ev.day < today || ev.day > limit) return false;
            }
        }

        if (ev.day && ev.day < today) return false; // already been

        return true;
    }

    /* ======================================================================
       DRAWING
       ====================================================================== */
    var weekendGrid = document.getElementById('gg-weekend-grid');
    var weekendEmpty = document.getElementById('gg-weekend-empty');
    var upcomingGrid = document.getElementById('gg-upcoming-grid');
    var upcomingEmpty = document.getElementById('gg-upcoming-empty');

    var slider = upcomingGrid ? window.SGSlider(upcomingGrid, Array.prototype.slice.call(page.querySelectorAll('[data-slide]'))) : null;

    /* Two rows from one list: the weekend row is the next few days; the
       highlights row is everything else, plus anything marked big */
    function draw() {
        var showing = events.filter(matches);
        var w = weekendRange();

        var weekend = showing.filter(function (ev) {
            return !ev.big && ev.day && ev.day >= w.start && ev.day <= w.end;
        });

        // One Friday Nights in the highlights row, not twelve
        var seen = {};
        var upcoming = showing.filter(function (ev) {
            if (weekend.indexOf(ev) >= 0) return false;
            if (!ev.src.every) return true;
            if (seen[ev.name]) return false;
            seen[ev.name] = true;
            return true;
        });

        fill(weekendGrid, weekendEmpty, weekend, 'Nothing listed for this weekend yet.');
        fill(upcomingGrid, upcomingEmpty, upcoming, 'Nothing else listed just now.');

        if (slider) slider.paint();
    }

    function fill(grid, empty, list, message) {
        if (!grid) return;

        grid.innerHTML = list.map(W.card).join('');

        if (empty) {
            empty.textContent = message;
            empty.hidden = list.length > 0;
        }
    }

    /* ======================================================================
       CONTROLS - the pills and the menus are the same filters, kept in step
       ====================================================================== */
    var search = document.getElementById('gg-search');
    var whenSel = document.getElementById('gg-when');
    var whereSel = document.getElementById('gg-where');
    var catPills = Array.prototype.slice.call(page.querySelectorAll('[data-gg-cat]'));
    var placePills = Array.prototype.slice.call(page.querySelectorAll('[data-gg-place]'));

    function light(list, attr, value) {
        list.forEach(function (b) {
            var on = b.getAttribute(attr) === value;
            b.classList.toggle('is-on', on);
            b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
    }

    if (search) {
        search.addEventListener('input', function () {
            filters.text = search.value.trim().toLowerCase();
            draw();
        });
    }

    if (whenSel) {
        whenSel.addEventListener('change', function () {
            filters.when = whenSel.value;
            draw();
        });
    }

    if (whereSel) {
        whereSel.addEventListener('change', function () {
            filters.place = whereSel.value;
            light(placePills, 'data-gg-place', filters.place);
            draw();
        });
    }

    catPills.forEach(function (b) {
        b.addEventListener('click', function () {
            filters.cat = b.getAttribute('data-gg-cat');
            light(catPills, 'data-gg-cat', filters.cat);
            draw();
        });
    });

    placePills.forEach(function (b) {
        b.addEventListener('click', function () {
            filters.place = b.getAttribute('data-gg-place');
            light(placePills, 'data-gg-place', filters.place);
            if (whereSel) whereSel.value = filters.place;
            draw();
        });
    });

    // The subscribe box has no list behind it, so it carries the address to the contact page
    var sub = document.getElementById('gg-subscribe');
    if (sub) {
        sub.addEventListener('submit', function (ev) {
            ev.preventDefault();
            var email = document.getElementById('gg-email');
            var note = 'Please add me to the weekend gig guide list.';
            window.location.href = '/contact?note=' + encodeURIComponent(note) + '&email=' + encodeURIComponent(email ? email.value : '');
        });
    }

    // The hero clip, on a big screen only - a phone never downloads it
    var video = document.getElementById('gg-hero-video');
    if (video && window.innerWidth > 900 && !window.matchMedia('(hover: none)').matches) {
        video.src = video.getAttribute('data-src');
        var playing = video.play();
        if (playing && playing.catch) playing.catch(function () {});
    }

    /* ======================================================================
       START - our list now, redrawn once the found events arrive
       ====================================================================== */
    draw();

    loadFound()
        .then(function (found) {
            if (!found.length) return;
            events = expand().concat(found).sort(byDay);
            draw();
            return W.loadStatus();
        })
        .then(function (status) {
            if (!status || !status.ranAt) return;

            var when = new Date(status.ranAt);
            if (isNaN(when)) return;

            var note = document.getElementById('gg-updated');
            if (!note) return;

            note.textContent =
                'Listings checked ' +
                when.toLocaleDateString('en-AU', {
                    day: 'numeric',
                    month: 'long',
                    hour: 'numeric',
                    minute: '2-digit'
                }) +
                '. Always check with the organiser before you travel.';
            note.hidden = false;
        })
        .catch(function (err) {
            // our own listings are already on screen
            if (window.console) console.warn('gig guide: found events unavailable', err);
        });
})();
