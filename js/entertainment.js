/* ==========================================================================
   SOUNDZGOOD ENTERTAINMENT

   Builds the talent grid, the filters and the artist panel. Everything is
   scoped to #sg-ent-page, so nothing here can reach another page.

   ADDING AN ACT
   Add one object to TALENT. The act-type bar, the dropdowns, the search
   and the counts all read from it. `act` must be one of the ACT_TYPES keys.

   PHOTOS
   No `photo` = the card shows its gradient and the act-type glyph.
   Resize photos with 3_sg-hod/tools/fit-logo.ps1 (about 480px wide is plenty).
   Cards crop portraits from 18% down, so frame the face in the upper third.
   ========================================================================== */
(function () {
    'use strict';

    /*  Runs once the roster is ready: acts come from Admin -> Entertainment
        (Firestore), or the built-in list if the database can't be reached. */
    var ready = window.SG_ROSTER_READY ||
                Promise.resolve(window.SG_ROSTER || []);

    ready.then(function (ROSTER) {
        start(ROSTER);
    });

function start(ROSTER) {

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

    /*  Handed in above: the built-in list in js/roster.js with whatever
        is set in Admin -> Entertainment merged over it.              */
    var TALENT = ROSTER;


    /*  Paths are written out, not built from the slug, so an act with no
        photo doesn't cause a 404 request. */

    var PER_PAGE = 12;   // 12 a page, three rows of four

    /*  The little glyph on a card with no photo, and in the artist panel.
        Drawn inline to save requests. */
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
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    /* Every distinct value of one field across the roster, sorted. */
    var FEMALE = 'Female DJs';
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
        if (state.genre === FEMALE) { if (!t.female) return false; }
        else if (state.genre !== 'all' && (t.genres || []).indexOf(state.genre) < 0) return false;
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

        /*  Photo set as a CSS property, not an <img>, so a missing file just
            leaves the gradient instead of a broken image icon. */
        var media = t.photo
            ? ' style="--ent-img:url(\'' + esc((/^(https?:|\/|data:)/.test(t.photo) ? t.photo : '/' + t.photo)) + '\')"'
            : '';

        return '' +
        '<article class="ent-card' + (t.photo ? ' has-photo' : '') +
          '" data-act="' + esc(t.act) + '"' + media + '>' +

          /*  Covers the whole card so a click anywhere opens the artist panel.
              Holds the glyph shown when there is no photo.              */
          '<button type="button" class="ent-card-media" data-slug="' + esc(t.slug) + '"' +
            ' aria-label="More about ' + esc(t.name) + '">' +
            '<svg class="ent-card-glyph" viewBox="0 0 24 24" aria-hidden="true">' + glyph + '</svg>' +
          '</button>' +

          /*  The words sit on the photo, over a gradient. */
          '<div class="ent-card-body">' +
            '<span class="ent-badge">' + esc(actLabel) + '</span>' +
            '<h3>' + esc(t.name) + '</h3>' +
            // where they're based
            (t.location
              ? '<p class="ent-card-loc"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>' + esc(t.location) + '</p>'
              : '') +

            /*  Lines with nothing in them are left out entirely. */
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

            /*  A link to the contact form; js/main.js fills in the act's name. */
            '<a class="ent-view" href="/contact?about=' +
              encodeURIComponent(t.name) + '">' +
              'Make Enquiry <span aria-hidden="true">&#8594;</span>' +
            '</a>' +
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

        /*  Arrows are disabled rather than hidden so the header doesn't reflow
            when a filter changes. */
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
        var media = t.photo ? ' style="--ent-img:url(\'' + esc((/^(https?:|\/|data:)/.test(t.photo) ? t.photo : '/' + t.photo)) + '\')"' : '';

        panelBody.innerHTML = '' +
            '<div class="ent-panel-media"' + media + '>' +
              '<svg class="ent-card-glyph" viewBox="0 0 24 24" aria-hidden="true">' +
                (GLYPHS[t.act] || '') +
              '</svg>' +
            '</div>' +

            '<div class="ent-panel-body">' +
              '<span class="ent-badge">' + esc(actLabel) + '</span>' +
              '<h3>' + esc(t.name) + '</h3>' +
              // where they're based
              (t.location
                ? '<p class="ent-card-loc"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>' + esc(t.location) + '</p>'
                : '') +

              '<h4>Style</h4>' +
              '<p>' + (t.genres || []).map(esc).join(' &middot; ') + '</p>' +

              '<h4>Suits</h4>' +
              '<p>' + (t.events || []).map(esc).join(' &middot; ') + '</p>' +

              '<a class="btn ent-btn" href="/contact?about=' +
                encodeURIComponent(t.name) + '">' +
                'Make Enquiry <span aria-hidden="true">&#8594;</span>' +
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

    /*  Only the act types somebody is actually filed under. */
    var usedActs = Object.keys(ACT_TYPES).filter(function (key) {
        return TALENT.some(function (t) { return t.act === key; });
    });

    var ALL_GLYPH = '<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.4"/>' +
        '<path d="M3 19c0-3.3 2.7-5 6-5s6 1.7 6 5z"/>' +
        '<path d="M14.5 19c0-2.4 1.4-4 3.5-4s3.5 1.6 3.5 4z"/>';

    /*  With only one act type there is nothing to filter, so the bar and
        the act dropdown are hidden until a second type appears.          */
    var oneActTypeOnly = usedActs.length < 2;

    var typesBar = document.getElementById('ent-types');
    if (oneActTypeOnly) { typesBar.hidden = true; }

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

    /*  The line under the headline only names act types on the roster. */
    var heroTypes = document.getElementById('ent-hero-types');
    if (heroTypes) {
        heroTypes.innerHTML = usedActs.map(function (key) {
            return esc(ACT_TYPES[key] + (key === 'kids' ? '' : 's'));
        }).join(' &nbsp;|&nbsp; ');
    }

    if (oneActTypeOnly) {
        selAct.closest('.ent-select').hidden = true;
    }

    fillSelect(selAct, usedActs, 'All Act Types');
    /*  The act dropdown shows the labels but carries the keys, so it and the
        bar above speak the same language. */
    Array.prototype.forEach.call(selAct.options, function (o) {
        if (o.value !== 'all') o.textContent = ACT_TYPES[o.value];
    });

    /*  Genres and event types are optional. Until some are filled in the
        dropdown is hidden rather than offering only "All".               */
    var genres = optionsFrom('genres');
    // Female DJs: its own choice at the top of the list
    if (TALENT.some(function (t) { return t.female; })) genres.unshift(FEMALE);
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

    /*  One listener on the grid, because the cards are rebuilt on every
        filter change. */
    grid.addEventListener('click', function (ev) {
        var media = ev.target.closest ? ev.target.closest('.ent-card-media') : null;
        if (media) openPanel(media.getAttribute('data-slug'));
    });

    panelClose.addEventListener('click', closePanel);

    /*  Respect "reduce motion": pause the hero clip (the poster frame still
        shows). */
    var heroVideo = document.getElementById('ent-hero-video');
    if (heroVideo &&
        window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        heroVideo.removeAttribute('autoplay');
        heroVideo.pause();
    }

    /*  The reel. Closing must pause it too, or the sound keeps playing. */
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

    /* Clicking the backdrop closes it (a click on the dialog itself came
       from outside the content). */
    panel.addEventListener('click', function (ev) {
        if (ev.target === panel) closePanel();
    });

    render();
}
}());
