/* ==========================================================================
   THE SOUNDZGOOD ROSTER

   Who we have. One list, because three places need it now:

       js/entertainment.js   the roster page at /entertainment
       js/events.js          whose DJ is on which Friday Night
       js/admin-app.js       the dropdown for naming that DJ

   A second copy of this list would mean adding an artist in one place and
   wondering why they do not appear in another, so there is one of it and
   it publishes itself as window.SG_ROSTER.

   Plain script, not a module, like every other page script here.
   ========================================================================== */
(function (global) {
    'use strict';

    /*  THE ROSTER

        `genres` and `events` are deliberately empty. They are claims about
        real people - what they play and what they suit - and guessing them
        would put words in an artist's mouth on a live booking page. Fill
        them in and the cards, the two dropdowns and the search all pick
        them up with no other change:

            genres: ['House', 'Dance', 'Open Format'],
            events: ['Clubs', 'Festivals', 'Weddings'],

        Until then a card shows the name and the act type, which are both
        known to be true.                                                 */
    var TALENT = [
        /* ---- DJs ---- */
        { slug:'maxzi',              name:'MAXZI',              act:'dj',   genres:[], events:[],
          photo:'images/talent/maxzi.jpg' },
        { slug:'lucas',              name:'Lucas',              act:'dj',   genres:[], events:[],
          photo:'images/talent/lucas.jpg' },
        { slug:'dj-karma',           name:'DJ Karma',           act:'dj',   genres:[], events:[],
          photo:'images/talent/dj-karma.jpg' },
        { slug:'nina-sinclair',      name:'Nina Sinclair',      act:'dj',   genres:[], events:[],
          photo:'images/talent/nina-sinclair.jpg' },
        { slug:'dj-charly-templar',  name:'DJ Charly Templar',  act:'dj',   genres:[], events:[],
          photo:'images/talent/dj-charly-templar.jpg' },
        { slug:'kriss-kross',        name:'Kriss Kross',        act:'dj',   genres:[], events:[],
          photo:'images/talent/kriss-kross.jpg' },
        { slug:'alex-emrik',         name:'Alex Emrik',         act:'dj',   genres:[], events:[],
          photo:'images/talent/alex-emrik.jpg' },
        { slug:'dj-powerboi',        name:'DJ PowerBoi',        act:'dj',   genres:[], events:[],
          photo:'images/talent/dj-powerboi.jpg' },

        /*  THE SOLO ARTISTS AND BANDS ARE PARKED, NOT GONE

            Showing the DJs on their own for now. These are kept here rather
            than deleted so putting them back is uncommenting, not typing
            seven names out again from memory.

            Take the comment off and they reappear - and so do the Solo
            Artists and Bands tabs, the act-type dropdown and the line under
            the headline, all of which are built from this list.

        { slug:'sam-mckann',         name:'Sam McKann',         act:'solo', genres:[], events:[] },
        { slug:'samantha-roberts',   name:'Samantha Roberts',   act:'solo', genres:[], events:[] },
        { slug:'pluto-tango',        name:'Pluto Tango',        act:'solo', genres:[], events:[] },
        { slug:'jacob-biermann',     name:'Jacob Biermann',     act:'solo', genres:[], events:[] },

        { slug:'zed-charles-bo-river-band', name:'Zed Charles & The Bo River Band', act:'band', genres:[], events:[] },
        { slug:'headrush',           name:'Headrush',           act:'band', genres:[], events:[] },
        { slug:'cat-5',              name:'Cat 5',              act:'band', genres:[], events:[] }
        */
    ];

    /* ----------------------------------------------------------------------
       THE LIST ABOVE IS THE STARTING POINT, NOT THE LAST WORD

       Acts are managed in Admin -> Entertainment, and those live in
       Firestore. What the site actually shows is the two put together:

           an act in the database that is not above    is added
           an act in both                             the database wins
           an act marked hidden in the database       is dropped

       So the eight above are what the site falls back to if the database
       is unreachable, and everything after that is managed without a
       deploy. Nobody has to choose between the two.

       SG_ROSTER holds the built-in list immediately and the merged list
       once it lands. SG_ROSTER_READY is the one to wait for - a page that
       builds itself from the roster should build inside it, once, rather
       than drawing the built-ins and then flinching.
       ---------------------------------------------------------------------- */
    var PROJECT = 'soundzgood-8c86f';
    var WEB_KEY = 'AIzaSyCVWdD7fE24MuN-v5XQLObJbSHYRUbPlPY';
    var REST = 'https://firestore.googleapis.com/v1/projects/' + PROJECT +
               '/databases/(default)/documents/talent?pageSize=200&key=' + WEB_KEY;

    function index(list) {
        return list.reduce(function (map, t) {
            map[t.slug] = t;
            return map;
        }, {});
    }

    function publish(list) {
        global.SG_ROSTER = list;
        global.SG_ROSTER_BY_SLUG = index(list);
        return list;
    }

    /*  The built-in list on its own, for the admin page: it merges the
        same way this file does, and needs to know which acts are in the
        file - those cannot be deleted, only hidden.                  */

    /* ----------------------------------------------------------------------
       A FRIDAY OR TWO, LOCKED IN BEFORE THE DESK WAS OPENED

       Bookings belong in Admin -> Entertainment. This is only for a night
       somebody wants on the site before anybody next signs in, and the desk
       offers to take these over the moment it sees them - at which point
       they can be deleted from here.

       Here rather than in js/events.js because the admin page has to see
       them too, to know they exist and to offer to import them.
       ---------------------------------------------------------------------- */
    global.SG_FRIDAY_SEED = {
        '2026-09-18': 'kriss-kross',
        '2026-09-25': 'dj-charly-templar'
    };

    global.SG_ROSTER_BUILT_IN = TALENT;

    publish(TALENT);

    /*  Firestore hands every value back wrapped in its type. */
    function plain(fields) {
        var out = {};
        Object.keys(fields || {}).forEach(function (k) {
            var v = fields[k];
            out[k] = v.stringValue !== undefined ? v.stringValue
                   : v.booleanValue !== undefined ? v.booleanValue
                   : v.integerValue !== undefined ? parseInt(v.integerValue, 10)
                   : v.arrayValue !== undefined
                       ? (v.arrayValue.values || []).map(function (x) {
                             return x.stringValue || '';
                         })
                   : '';
        });
        return out;
    }

    global.SG_ROSTER_READY = fetch(REST)
        .then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
        })
        .then(function (body) {
            var saved = (body.documents || []).map(function (doc) {
                var t = plain(doc.fields);
                t.slug = doc.name.split('/').pop();
                return t;
            });

            if (!saved.length) return publish(TALENT);

            var bySlug = index(TALENT);

            saved.forEach(function (t) {
                if (t.hidden) { delete bySlug[t.slug]; return; }

                var was = bySlug[t.slug] || {};
                bySlug[t.slug] = {
                    slug: t.slug,
                    name: t.name || was.name || t.slug,
                    act: t.act || was.act || 'dj',
                    photo: t.photo !== undefined && t.photo !== ''
                        ? t.photo : (was.photo || ''),
                    genres: (t.genres && t.genres.length) ? t.genres : (was.genres || []),
                    events: (t.events && t.events.length) ? t.events : (was.events || []),
                    order: t.order
                };
            });

            var merged = Object.keys(bySlug).map(function (k) { return bySlug[k]; });

            /*  Anything given an order in admin sorts by it; everything
                else keeps the order it is written in above, which is the
                order the DJs were signed.                              */
            merged.sort(function (a, b) {
                var ao = typeof a.order === 'number' ? a.order : 500;
                var bo = typeof b.order === 'number' ? b.order : 500;
                return ao - bo;
            });

            return publish(merged);
        })
        .catch(function (err) {
            /*  The built-in eight. A roster page showing the acts we had
                last week is a great deal better than an empty one.     */
            if (global.console) console.warn('roster: using the built-in list', err);
            return publish(TALENT);
        });
}(window));

