/* ==========================================================================
   THE GIG GUIDE

   One list of events, and everything on the page built from it.

   ==========================================================================
   ADDING AN EVENT - this is the only part you need
   ==========================================================================

   Copy a block in LISTINGS below and change the words.

       name    what it is called
       date    'YYYY-MM-DD'. Leave it null if the date is not out yet and
               put something in dateText instead.
       every   'friday' for something on every week. Use this OR date,
               never both - the guide works out the next dozen Fridays on
               its own, so nobody has to keep typing them in.
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
               one the card shows its dark tile, which is fine.
       big     true puts it in Upcoming Highlights rather than the weekend
               row, whatever the date says. For the few events that are
               worth the page whenever they are on.

   WHAT IS IN HERE NOW
   Three events, because three is what we can stand behind - our own
   residency and our own two events. A gig guide wants dozens, and they
   have to come from the venues, the council and Tourism Whitsundays
   rather than be invented to make the page look full. An empty row says
   "nothing on" honestly; a made up one is a person driving to Bowen for
   a gig that does not exist.
   ========================================================================== */
var GG_LISTINGS = [

    {
        name:  'Friday Nights',
        every: 'friday',
        time:  '9:30 PM – Late',
        venue: 'The Grand View Hotel, Bowen',
        area:  'bowen',
        cats:  ['dj', 'live'],
        tags:  ['DJ', 'Nightlife', 'Free Entry'],
        img:   ''
    },

    {
        name:  'Eatz & Beatz — Halloween Edition',
        date:  '2026-10-31',
        venue: 'Bowen Sporting Complex',
        area:  'bowen',
        cats:  ['markets', 'food', 'family', 'live'],
        tags:  ['Food', 'Markets', 'Music', 'Family'],
        img:   '',
        big:   true
    },

    {
        name:     'SoundzGood — Next Chapter',
        date:     null,
        dateText: '2027',
        venue:    'Bowen, QLD',
        area:     'bowen',
        cats:     ['festivals', 'live'],
        tags:     ['Festival', 'Music', 'Coming Soon'],
        img:      '',
        big:      true
    }

];


/* ==========================================================================
   Everything below builds the page. You should not have to touch it to add
   an event.

   WHERE THE REST OF THE EVENTS COME FROM

   The list above is the hand written one - our own residency and our own
   events. Everything else arrives from the database, put there once a day
   by the syncGigGuide function, which reads the schema.org Event markup
   that other event sites publish for machines. See
   functions/lib/gig-sources.js for which sites, and the rules it follows.

   The two are merged here rather than in the database on purpose: ours are
   in the file where anybody can edit them without a login, and theirs are
   never mixed in with ours, so a bad run can never eat our own listings.

   If the database is unreachable the page still works - it shows the hand
   written list and says so. A gig guide that renders nothing because a
   network call failed is worse than a short one.
   ========================================================================== */
(function () {
    'use strict';

    var page = document.getElementById('sg-gig-guide');
    if (!page) return;

    var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    /*  How many weeks ahead a repeating event is worked out to. Twelve is
        enough to fill any of the date filters and short enough that the
        page is not listing Fridays a year out as though they were
        announced.                                                       */
    var REPEAT_WEEKS = 12;

    var filters = { text: '', cat: 'all', place: 'all', when: 'all' };

    /* ----------------------------------------------------------------------
       DATES
       Everything is worked out from midnight today in local time, so an
       event on this afternoon is still "today" rather than already past.
       ---------------------------------------------------------------------- */
    function midnight(d) {
        return new Date(d.getFullYear(), d.getMonth(), d.getDate());
    }

    function parseDay(iso) {
        var p = String(iso).split('-');
        return new Date(+p[0], +p[1] - 1, +p[2]);
    }

    var today = midnight(new Date());

    /*  Both of these come from js/weekend.js now, which /events uses as
        well. One definition of which days are the weekend.              */
    var weekendRange = window.SGWeekend.weekendRange;

    /* ----------------------------------------------------------------------
       THE LIST
       Repeating events are expanded into real dates here, once, so that
       everything past this point is dealing with one shape of thing.
       ---------------------------------------------------------------------- */
    function expand() {
        var out = [];

        GG_LISTINGS.forEach(function (ev) {
            if (ev.every) {
                var want = DAYS.indexOf(
                    ev.every.slice(0, 1).toUpperCase() + ev.every.slice(1, 3)
                );
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

        /*  Undated events last: they are real, but "2027" cannot be sorted
            against a Friday in three weeks.                             */
        out.sort(function (a, b) {
            if (!a.day && !b.day) return 0;
            if (!a.day) return 1;
            if (!b.day) return -1;
            return a.day - b.day;
        });

        return out;
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

    /* ----------------------------------------------------------------------
       THE FOUND EVENTS

       Everything the syncGigGuide function found overnight, read from
       Firestore by js/weekend.js - the same call the This Weekend strip on
       /events makes, so the two pages can never show different listings.
       ---------------------------------------------------------------------- */
    function loadFound() {
        return window.SGWeekend.loadGigs().then(function (rows) {
            return rows.map(function (r) {
                /*  No categories from a source that does not publish any.
                    They match the All pill and nothing else, which is
                    honest - better than filing a trivia night under Live
                    Music.                                               */
                return occurrence(r, r.day);
            });
        });
    }

    var loadStatus = window.SGWeekend.loadStatus;

    /* ----------------------------------------------------------------------
       FILTERING
       ---------------------------------------------------------------------- */
    function matches(ev) {
        if (filters.cat !== 'all' && ev.cats.indexOf(filters.cat) < 0) return false;
        if (filters.place !== 'all' && ev.area !== filters.place) return false;

        if (filters.text) {
            var hay = (ev.name + ' ' + ev.venue + ' ' + ev.tags.join(' ')).toLowerCase();
            if (hay.indexOf(filters.text) < 0) return false;
        }

        if (filters.when !== 'all') {
            /*  An undated event cannot answer "is it in the next 7 days",
                so it drops out of any dated view rather than being shown
                against a question it has no answer to.                  */
            if (!ev.day) return false;

            if (filters.when === 'weekend') {
                var w = weekendRange();
                if (ev.day < w.start || ev.day > w.end) return false;
            } else {
                var limit = new Date(today);
                limit.setDate(limit.getDate() + parseInt(filters.when, 10));
                if (ev.day < today || ev.day > limit) return false;
            }
        }

        /* nothing that has already been */
        if (ev.day && ev.day < today) return false;

        return true;
    }

    /* ----------------------------------------------------------------------
       DRAWING
       ---------------------------------------------------------------------- */
    /*  Drawing a card is shared too - see js/weekend.js. Both pages
        show the same card, so there is one of it.                      */
    var card = window.SGWeekend.card;

    var weekendGrid = document.getElementById('gg-weekend-grid');
    var weekendEmpty = document.getElementById('gg-weekend-empty');
    var upcomingGrid = document.getElementById('gg-upcoming-grid');
    var upcomingEmpty = document.getElementById('gg-upcoming-empty');

    var upPage = 0;

    function draw() {
        var showing = events.filter(matches);
        var w = weekendRange();

        /*  Two rows out of one list. The weekend row is what is on in the
            next few days; the highlights row is everything else, plus
            anything marked big whenever it is on.                       */
        var weekend = showing.filter(function (ev) {
            return !ev.big && ev.day && ev.day >= w.start && ev.day <= w.end;
        });

        var upcoming = showing.filter(function (ev) {
            return weekend.indexOf(ev) < 0;
        });

        /*  One Friday Nights in the highlights row, not twelve. The
            weekend row is the place for the next one; the rest would push
            everything else off the page.                                */
        var seen = {};
        upcoming = upcoming.filter(function (ev) {
            if (!ev.src.every) return true;
            if (seen[ev.name]) return false;
            seen[ev.name] = true;
            return true;
        });

        fill(weekendGrid, weekendEmpty, weekend,
             'Nothing listed for this weekend yet.');

        fill(upcomingGrid, upcomingEmpty, upcoming,
             'Nothing else listed just now.');

        if (upPage > pages() - 1) upPage = pages() - 1;
        if (upPage < 0) upPage = 0;
        paintPage();
    }

    function fill(grid, empty, list, message) {
        if (!grid) return;

        grid.innerHTML = list.map(card).join('');

        if (empty) {
            empty.textContent = message;
            empty.hidden = list.length > 0;
        }
    }

    /* ----------------------------------------------------------------------
       PAGING THE HIGHLIGHTS ROW

       Same trick the annual events row on /events uses: the track is a grid
       sized against its own window, so it is exactly one window wide however
       many cards hang out of it, and one page is exactly -100%. Nothing is
       measured, so nothing depends on having been painted.
       ---------------------------------------------------------------------- */
    var view = document.getElementById('gg-upcoming-view');
    var arrows = Array.prototype.slice.call(page.querySelectorAll('[data-gg-page]'));

    function perView() {
        if (!view) return 1;
        var n = parseInt(
            window.getComputedStyle(view).getPropertyValue('--gg-per'), 10
        );
        return n > 0 ? n : 1;
    }

    function pages() {
        var n = upcomingGrid ? upcomingGrid.children.length : 0;
        return Math.max(1, Math.ceil(n / perView()));
    }

    function paintPage() {
        if (!upcomingGrid) return;

        var last = pages() - 1;
        upcomingGrid.style.setProperty('--gg-page', upPage);

        arrows.forEach(function (btn) {
            var dir = parseInt(btn.getAttribute('data-gg-page'), 10);
            btn.disabled = dir < 0 ? upPage === 0 : upPage === last;
        });
    }

    arrows.forEach(function (btn) {
        btn.addEventListener('click', function () {
            upPage += parseInt(btn.getAttribute('data-gg-page'), 10) || 0;
            if (upPage < 0) upPage = 0;
            if (upPage > pages() - 1) upPage = pages() - 1;
            paintPage();
        });
    });

    window.addEventListener('resize', paintPage);

    /* ----------------------------------------------------------------------
       THE CONTROLS

       The pills and the two menus are the same three filters, not six, so
       whichever one is touched the others are brought into line.
       ---------------------------------------------------------------------- */
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

    /*  The subscribe box has nothing behind it, so rather than swallowing
        an address it carries it to the contact page, where it arrives as
        a message a person can answer.                                   */
    var sub = document.getElementById('gg-subscribe');
    if (sub) {
        sub.addEventListener('submit', function (ev) {
            ev.preventDefault();
            var email = document.getElementById('gg-email');
            var note = 'Please add me to the weekend gig guide list.';
            window.location.href = '/contact?note=' + encodeURIComponent(note) +
                '&email=' + encodeURIComponent(email ? email.value : '');
        });
    }

    /*  The hero clip, on a big screen only. Same as the services page: a
        phone never downloads it.                                        */
    var video = document.getElementById('gg-hero-video');
    if (video && window.innerWidth > 900 && !window.matchMedia('(hover: none)').matches) {
        video.src = video.getAttribute('data-src');
        var playing = video.play();
        if (playing && playing.catch) playing.catch(function () {});
    }

    /*  The hand written list is drawn first so the page is never empty
        while the network is thinking about it, then redrawn once the
        found events arrive. If that call fails the page keeps what it
        already has and says where it stands.                          */
    draw();

    loadFound().then(function (found) {
        if (!found.length) return;

        events = expand().concat(found).sort(function (a, b) {
            if (!a.day && !b.day) return 0;
            if (!a.day) return 1;
            if (!b.day) return -1;
            return a.day - b.day;
        });

        draw();
        return loadStatus();
    }).then(function (status) {
        if (!status || !status.ranAt) return;

        var when = new Date(status.ranAt);
        if (isNaN(when)) return;

        var note = document.getElementById('gg-updated');
        if (!note) return;

        note.textContent = 'Listings checked ' +
            when.toLocaleDateString('en-AU', {
                day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit'
            }) + '. Always check with the organiser before you travel.';
        note.hidden = false;
    }).catch(function (err) {
        /*  Not a silent failure and not a broken page: the hand written
            listings are already on screen.                             */
        if (window.console) console.warn('gig guide: found events unavailable', err);
    });
}());
