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
        { slug:'dj-charley-templar', name:'DJ Charley Templar', act:'dj',   genres:[], events:[],
          photo:'images/talent/dj-charley-templar.jpg' },
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

    global.SG_ROSTER = TALENT;

    /*  Handy for the two pages that look one up by slug. */
    global.SG_ROSTER_BY_SLUG = TALENT.reduce(function (map, t) {
        map[t.slug] = t;
        return map;
    }, {});
}(window));
