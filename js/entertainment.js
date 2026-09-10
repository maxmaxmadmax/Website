/* ==========================================================================
   SOUNDZGOOD ENTERTAINMENT

   Builds the talent grid, the filters and the artist panel. Everything is
   scoped to #sg-ent-page, so nothing here can reach another page.

   ADDING AN ACT
   Add one object to TALENT below. The act-type bar, all three dropdowns,
   the search and the counts read from that list, so nothing else needs
   touching. The only field that has to match something is `act` - it has
   to be one of the keys in ACT_TYPES.

   PHOTOS
   `photo` is a path, not a file that has to exist. If it is missing the
   card falls back to its own gradient and the act-type glyph, so a roster
   with no photos yet still looks finished. Save them as

       images/talent/<slug>.webp

   portrait-ish, about 900px wide.
   ========================================================================== */
(function () {
    'use strict';

    var page = document.getElementById('sg-ent-page');
    if (!page) return;

    /* The act types, in the order the bar shows them. */
    var ACT_TYPES = {
        dj:    'DJ',
        solo:  'Solo Artist',
        duo:   'Duo',
        band:  'Band',
        mc:    'MC / Host',
        kids:  'Kids Entertainment'
    };

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
        { slug:'dj-maxx',            name:'DJ Maxx',            act:'dj',   genres:[], events:[] },
        { slug:'dj-tao',             name:'DJ Tao',             act:'dj',   genres:[], events:[] },
        { slug:'dj-karma',           name:'DJ Karma',           act:'dj',   genres:[], events:[] },
        { slug:'nina-sinclare',      name:'Nina Sinclare',      act:'dj',   genres:[], events:[] },
        { slug:'dj-charley-templar', name:'DJ Charley Templar', act:'dj',   genres:[], events:[] },
        { slug:'kriss-kross',        name:'Kriss Kross',        act:'dj',   genres:[], events:[] },
        { slug:'alex-emrik',         name:'Alex Emrik',         act:'dj',   genres:[], events:[] },
        { slug:'dj-powerboi',        name:'DJ PowerBoi',        act:'dj',   genres:[], events:[] },

        /* ---- Solo artists ---- */
        { slug:'sam-mckann',         name:'Sam McKann',         act:'solo', genres:[], events:[] },
        { slug:'samantha-roberts',   name:'Samantha Roberts',   act:'solo', genres:[], events:[] },
        { slug:'pluto-tango',        name:'Pluto Tango',        act:'solo', genres:[], events:[] },
        { slug:'jacob-biermann',     name:'Jacob Biermann',     act:'solo', genres:[], events:[] },

        /* ---- Bands ---- */
        { slug:'zed-charles-bo-river-band', name:'Zed Charles & The Bo River Band', act:'band', genres:[], events:[] },
        { slug:'headrush',           name:'Headrush',           act:'band', genres:[], events:[] },
        { slug:'cat-5',              name:'Cat 5',              act:'band', genres:[], events:[] }
    ];

    /*  No `photo` on an act means no picture is asked for at all, which is
        why none of the above has one yet. Deriving the path from the slug
        instead looked tidier but fired a 404 for every act on every view -
        fifteen failed requests to end up showing the gradient we would have
        shown anyway. Add the line when the file exists:

            { slug:'dj-maxx', name:'DJ Maxx', act:'dj',
              photo:'images/talent/dj-maxx.webp', genres:[], events:[] },
     */

    var PER_PAGE = 8;

    /*  The little glyph on a card with no photo, and in the artist panel.
        Drawn rather than loaded - six icons are not worth six requests. */
    var GLYPHS = {
        dj:   '<path d="M4 14v-2a8 8 0 0116 0v2" fill="none" stroke="currentColor" stroke-width="2"/><rect x="2.5" y="13" width="5" height="7" rx="2"/><rect x="16.5" y="13" width="5" height="7" rx="2"/>',
        solo: '<circle cx="9" cy="16" r="4.5"/><path d="M12.6 13.2 19 4l2 1.6-6.6 9z"/>',
        duo:  '<circle cx="6.5" cy="17" r="3"/><circle cx="16.5" cy="15" r="3"/><path d="M9 17V6l10.5-2v11" fill="none" stroke="currentColor" stroke-width="2"/>',
        band: '<ellipse cx="12" cy="16" rx="9" ry="5"/><path d="M3 11h18" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="7" cy="7" r="2.4"/><circle cx="17" cy="7" r="2.4"/>',
        mc:   '<rect x="9" y="2" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0014 0" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 18v4" fill="none" stroke="currentColor" stroke-width="2"/>',
        kids: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="9" cy="10" r="1.3"/><circle cx="15" cy="10" r="1.3"/><path d="M8 14.5a5 5 0 008 0" fill="none" stroke="currentColor" stroke-width="2"/>'
    };

    var state = { act: 'all', genre: 'all', event: 'all', q: '', page: 0 };

    var grid    = document.getElementById('ent-grid');
    var empty   = document.getElementById('ent-empty');
    var count   = document.getElementById('ent-count');
    var selAct  = document.getElementById('ent-filter-act');
    var selGen  = document.getElementById('ent-filter-genre');
    var selEvt  = document.getElementById('ent-filter-event');
    var search  = document.getElementById('ent-search');
    var prev    = document.getElementById('ent-prev');
    var next    = document.getElementById('ent-next');
    var panel   = document.getElementById('ent-panel');
    var panelBody  = document.getElementById('ent-panel-body');
    var panelClose = document.getElementById('ent-panel-close');

    function esc(value) {
        var d = document.createElement('div');
        d.textContent = value == null ? '' : String(value);
        return d.innerHTML;
    }

    /* Every distinct value of one field across the roster, sorted. */
    function optionsFrom(field) {
        var seen = {};
        TALENT.forEach(function (t) {
            (t[field] || []).forEach(function (v) { seen[v] = true; });
        });
        return Object.keys(seen).sort();
    }

    function fillSelect(el, values, allLabel) {
        var html = '<option value="all">' + esc(allLabel) + '</option>';
        values.forEach(function (v) {
            html += '<option value="' + esc(v) + '">' + esc(v) + '</option>';
        });
        el.innerHTML = html;
    }

    function matches(t) {
        if (state.act !== 'all' && t.act !== state.act) return false;
        if (state.genre !== 'all' && (t.genres || []).indexOf(state.genre) < 0) return false;
        if (state.event !== 'all' && (t.events || []).indexOf(state.event) < 0) return false;

        if (state.q) {
            var hay = [t.name, ACT_TYPES[t.act]]
                .concat(t.genres || [], t.events || [])
                .join(' ')
                .toLowerCase();
            if (hay.indexOf(state.q) < 0) return false;
        }
        return true;
    }

    function cardHtml(t) {
        var actLabel = ACT_TYPES[t.act] || '';
        var glyph = GLYPHS[t.act] || '';

        /*  The photo goes on as a custom property rather than an <img>, so a
            path that turns out to be missing simply leaves the gradient
            showing instead of drawing a broken image icon. */
        var media = t.photo
            ? ' style="--ent-img:url(\'' + esc(t.photo) + '\')"'
            : '';

        return '' +
        '<article class="ent-card" data-act="' + esc(t.act) + '">' +
          '<div class="ent-card-media"' + media + '>' +
            '<svg class="ent-card-glyph" viewBox="0 0 24 24" aria-hidden="true">' + glyph + '</svg>' +
            '<span class="ent-badge">' + esc(actLabel) + '</span>' +
          '</div>' +

          '<div class="ent-card-body">' +
            '<h3>' + esc(t.name) + '</h3>' +

            /*  Both lines are left out entirely when there is nothing to put
                in them - an empty row of styling reads as a card that failed
                to load rather than one that simply has less to say. */
            ((t.genres || []).length
              ? '<p class="ent-card-genres">' +
                  t.genres.map(esc).join(' <i aria-hidden="true">&middot;</i> ') +
                '</p>'
              : '') +

            ((t.events || []).length
              ? '<p class="ent-card-events">' +
                  '<svg viewBox="0 0 24 24" aria-hidden="true">' + glyph + '</svg>' +
                  t.events.map(function (e) {
                      return '<span>' + esc(e) + '</span>';
                  }).join('') +
                '</p>'
              : '') +

            '<button type="button" class="ent-view" data-slug="' + esc(t.slug) + '">' +
              'View Profile <span aria-hidden="true">&#8594;</span>' +
            '</button>' +
          '</div>' +
        '</article>';
    }

    function render() {
        var list = TALENT.filter(matches);
        var pages = Math.max(1, Math.ceil(list.length / PER_PAGE));

        if (state.page > pages - 1) state.page = pages - 1;
        if (state.page < 0) state.page = 0;

        var slice = list.slice(state.page * PER_PAGE, (state.page + 1) * PER_PAGE);

        grid.innerHTML = slice.map(cardHtml).join('');
        empty.hidden = list.length !== 0;

        count.textContent = list.length
            ? 'Showing ' + slice.length + ' of ' + list.length +
              (list.length === 1 ? ' act' : ' acts')
            : '';

        /*  Arrows only mean anything when there is more than one page. They
            are disabled rather than hidden so the header does not reflow
            every time a filter changes. */
        prev.disabled = state.page === 0;
        next.disabled = state.page >= pages - 1;
    }

    function setAct(act) {
        state.act = act;
        state.page = 0;

        page.querySelectorAll('.ent-type').forEach(function (b) {
            b.classList.toggle('is-on', b.getAttribute('data-act') === act);
        });
        if (selAct.value !== act) selAct.value = act;

        render();
    }

    /* ---- the artist panel ---- */
    function openPanel(slug) {
        var t = TALENT.filter(function (x) { return x.slug === slug; })[0];
        if (!t) return;

        var actLabel = ACT_TYPES[t.act] || '';
        var media = t.photo ? ' style="--ent-img:url(\'' + esc(t.photo) + '\')"' : '';

        panelBody.innerHTML = '' +
            '<div class="ent-panel-media"' + media + '>' +
              '<svg class="ent-card-glyph" viewBox="0 0 24 24" aria-hidden="true">' +
                (GLYPHS[t.act] || '') +
              '</svg>' +
            '</div>' +

            '<div class="ent-panel-body">' +
              '<span class="ent-badge">' + esc(actLabel) + '</span>' +
              '<h3>' + esc(t.name) + '</h3>' +

              '<h4>Style</h4>' +
              '<p>' + (t.genres || []).map(esc).join(' &middot; ') + '</p>' +

              '<h4>Suits</h4>' +
              '<p>' + (t.events || []).map(esc).join(' &middot; ') + '</p>' +

              '<a class="btn ent-btn" href="/contact?about=' +
                encodeURIComponent(t.name) + '">' +
                'Enquire about ' + esc(t.name) + ' <span aria-hidden="true">&#8594;</span>' +
              '</a>' +
            '</div>';

        if (typeof panel.showModal === 'function') {
            panel.showModal();
        } else {
            panel.setAttribute('open', '');   /* very old browsers */
        }
    }

    function closePanel() {
        if (typeof panel.close === 'function') panel.close();
        else panel.removeAttribute('open');
    }

    /* ---- wiring ---- */

    /*  Only the act types somebody is actually filed under. A tab that
        always came back "nothing matches" would be a dead end dressed up
        as a category. */
    var usedActs = Object.keys(ACT_TYPES).filter(function (key) {
        return TALENT.some(function (t) { return t.act === key; });
    });

    var ALL_GLYPH = '<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.4"/>' +
        '<path d="M3 19c0-3.3 2.7-5 6-5s6 1.7 6 5z"/>' +
        '<path d="M14.5 19c0-2.4 1.4-4 3.5-4s3.5 1.6 3.5 4z"/>';

    var typesBar = document.getElementById('ent-types');
    typesBar.innerHTML =
        '<button type="button" class="ent-type is-on" data-act="all">' +
          '<svg viewBox="0 0 24 24" aria-hidden="true">' + ALL_GLYPH + '</svg>' +
          'All Talent' +
        '</button>' +
        usedActs.map(function (key) {
            return '<button type="button" class="ent-type" data-act="' + key + '">' +
                     '<svg viewBox="0 0 24 24" aria-hidden="true">' + (GLYPHS[key] || '') + '</svg>' +
                     esc(ACT_TYPES[key] + (key === 'kids' ? '' : 's')) +
                   '</button>';
        }).join('');

    /*  The line under the headline says what is on the roster, so it cannot
        promise an act type nobody is signed to. */
    var heroTypes = document.getElementById('ent-hero-types');
    if (heroTypes) {
        heroTypes.innerHTML = usedActs.map(function (key) {
            return esc(ACT_TYPES[key] + (key === 'kids' ? '' : 's'));
        }).join(' &nbsp;|&nbsp; ');
    }

    fillSelect(selAct, usedActs, 'All Act Types');
    /*  The act dropdown shows the labels but carries the keys, so it and the
        bar above speak the same language. */
    Array.prototype.forEach.call(selAct.options, function (o) {
        if (o.value !== 'all') o.textContent = ACT_TYPES[o.value];
    });

    /*  Genres and event types are optional on an act. Until some are filled
        in there is nothing to choose between, so the dropdown is taken out
        rather than left offering only "All".                            */
    var genres = optionsFrom('genres');
    var events = optionsFrom('events');

    if (genres.length) fillSelect(selGen, genres, 'All Genres');
    else selGen.closest('.ent-select').hidden = true;

    if (events.length) fillSelect(selEvt, events, 'All Event Types');
    else selEvt.closest('.ent-select').hidden = true;

    typesBar.querySelectorAll('.ent-type').forEach(function (btn) {
        btn.addEventListener('click', function () {
            setAct(btn.getAttribute('data-act'));
        });
    });

    selAct.addEventListener('change', function () { setAct(selAct.value); });
    selGen.addEventListener('change', function () {
        state.genre = selGen.value; state.page = 0; render();
    });
    selEvt.addEventListener('change', function () {
        state.event = selEvt.value; state.page = 0; render();
    });

    search.addEventListener('input', function () {
        state.q = search.value.trim().toLowerCase();
        state.page = 0;
        render();
    });

    prev.addEventListener('click', function () { state.page--; render(); });
    next.addEventListener('click', function () { state.page++; render(); });

    /*  One listener on the grid rather than one per card - the cards are
        rebuilt on every filter change, and listeners on them would go with
        them. */
    grid.addEventListener('click', function (ev) {
        var btn = ev.target.closest ? ev.target.closest('.ent-view') : null;
        if (btn) openPanel(btn.getAttribute('data-slug'));
    });

    panelClose.addEventListener('click', closePanel);

    /*  Somebody who has asked their system for less motion should not get a
        looping clip behind the headline. Pausing rather than hiding leaves
        the poster frame showing, so the hero still has a picture in it. */
    var heroVideo = document.getElementById('ent-hero-video');
    if (heroVideo &&
        window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        heroVideo.removeAttribute('autoplay');
        heroVideo.pause();
    }

    /*  The reel. Closing has to pause it as well as hide it - a dialog that
        is shut carries on playing, so the sound follows you down the page. */
    var play      = document.getElementById('ent-play');
    var video     = document.getElementById('ent-video');
    var videoEl   = document.getElementById('ent-video-el');
    var videoShut = document.getElementById('ent-video-close');

    if (play && video && videoEl) {
        var closeVideo = function () {
            videoEl.pause();
            if (typeof video.close === 'function') video.close();
            else video.removeAttribute('open');
        };

        play.addEventListener('click', function () {
            if (typeof video.showModal === 'function') video.showModal();
            else video.setAttribute('open', '');
            videoEl.play().catch(function () { /* autoplay blocked - the controls are there */ });
        });

        videoShut.addEventListener('click', closeVideo);
        video.addEventListener('click', function (ev) {
            if (ev.target === video) closeVideo();
        });
        /* Escape closes a dialog on its own, but does not pause the video. */
        video.addEventListener('close', function () { videoEl.pause(); });
    }

    /* Clicking the backdrop closes it. The dialog fills its own box, so a
       click that lands on the dialog itself came from outside the content. */
    panel.addEventListener('click', function (ev) {
        if (ev.target === panel) closePanel();
    });

    render();
}());
