/* ==========================================================================
   THE SOUNDZGOOD ROSTER

   One list of acts, used by:

       js/entertainment.js   the roster page at /entertainment
       js/events.js          whose DJ is on which Friday Night
       js/admin-app.js       the dropdown for naming that DJ

   Publishes itself as window.SG_ROSTER. Plain script, not a module.
   ========================================================================== */
(function (global) {
    'use strict';

    /*  THE ROSTER

        Only fill in `genres` and `events` with what is true about the
        artist. The cards, dropdowns and search pick them up on their own:

            genres: ['House', 'Dance', 'Open Format'],
            events: ['Clubs', 'Festivals', 'Weddings'],              */
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
        { slug:'dougie',             name:'Dougie',             act:'dj',   genres:['R&B'], events:[],   // R&B
          photo:'images/talent/dougie.jpg' },
        { slug:'mosh-mechanix',      name:'Mosh Mechanix',      act:'dj',   genres:['Drum & Bass', 'Commercial'], events:[],
          photo:'images/talent/mosh-mechanix.jpg' },

        /*  PARKED: solo artists and bands. Take the comment marks off and they
            come back, along with their tabs and dropdown options.

        { slug:'sam-mckann',         name:'Sam McKann',         act:'solo', genres:[], events:[] },
        { slug:'samantha-roberts',   name:'Samantha Roberts',   act:'solo', genres:[], events:[] },
        { slug:'pluto-tango',        name:'Pluto Tango',        act:'solo', genres:[], events:[] },
        { slug:'jacob-biermann',     name:'Jacob Biermann',     act:'solo', genres:[], events:[] },

        { slug:'zed-charles-bo-river-band', name:'Zed Charles’ Bo’ River Band', act:'band', genres:[], events:[] },
        { slug:'headrush',           name:'Headrush',           act:'band', genres:[], events:[] },
        { slug:'cat-5',              name:'Cat 5',              act:'band', genres:[], events:[] }
        */
    ];

    /* ----------------------------------------------------------------------
       THE LIST ABOVE IS THE FALLBACK

       Acts are managed in Admin -> Entertainment (Firestore). The site
       shows the two merged:

           an act in the database that is not above    is added
           an act in both                             the database wins
           an act marked hidden in the database       is dropped

       SG_ROSTER holds the built-in list straight away and the merged list
       once it lands. Pages should wait for SG_ROSTER_READY.
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

    /*  A to Z by name. A leading "DJ " is skipped, so DJ Karma files
        under K.                                                       */
    function sortKey(t) {
        return String(t.name || '').replace(/^dj\s+/i, '').toLowerCase();
    }

    function publish(list) {
        list = list.slice().sort(function (a, b) {
            return sortKey(a).localeCompare(sortKey(b));
        });
        global.SG_ROSTER = list;
        global.SG_ROSTER_BY_SLUG = index(list);
        return list;
    }

    /*  The built-in list on its own, for the admin page: it merges the
        same way this file does, and needs to know which acts are in the
        file - those cannot be deleted, only hidden.                  */

    /* ----------------------------------------------------------------------
       FRIDAY BOOKINGS ADDED BY HAND

       Bookings belong in Admin -> Entertainment. Any here are offered for
       import by the admin page, then can be deleted from here.
       Kept here (not in js/events.js) so the admin page can see them too.
       ---------------------------------------------------------------------- */
    global.SG_FRIDAY_SEED = {
        '2026-09-18': 'kriss-kross',
        '2026-09-25': 'dj-charly-templar',
        '2026-10-16': 'dougie',
        '2026-10-23': 'lucas'
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
                    location: t.location || was.location || '',   // home town, on the card
                    female: t.female === true,   // "Female DJs" in the genre filter
                    order: t.order
                };
            });

            var merged = Object.keys(bySlug).map(function (k) { return bySlug[k]; });

            /*  Anything given an order in admin sorts by it; everything
                else keeps the order it is written in above.            */
            merged.sort(function (a, b) {
                var ao = typeof a.order === 'number' ? a.order : 500;
                var bo = typeof b.order === 'number' ? b.order : 500;
                return ao - bo;
            });

            return publish(merged);
        })
        .catch(function (err) {
            /*  The built-in eight. */
            if (global.console) console.warn('roster: using the built-in list', err);
            return publish(TALENT);
        });
}(window));

