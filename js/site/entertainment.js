/* ==========================================================================
   ENTERTAINMENT - the talent roster page. Everything is scoped to
   #sg-ent-page, so nothing here can reach another page.

   The acts come from js/data/roster.js (window.SG_ROSTER_READY): the built-in
   list with Admin -> Entertainment merged over it. `act` must be one of
   the ACT_TYPES keys. An act with no `photo` shows its gradient and glyph;
   cards crop portraits from 18% down, so frame the face in the upper third.

   SETUP      act types, glyphs, page elements
   FILTERS    which acts match the bar, dropdowns and search
   CARDS      the grid, a page at a time
   PANEL      the artist panel
   WIRING     the act-type bar, dropdowns, search, arrows
   VIDEO      the hero clip and the reel
   ========================================================================== */
(function () {
    'use strict';

    var esc = window.SG.esc;
    var ready = window.SG_ROSTER_READY || Promise.resolve(window.SG_ROSTER || []);

    ready.then(function (TALENT) {
        start(TALENT);
    });

    function start(TALENT) {
        var page = document.getElementById('sg-ent-page');
        if (!page) return;

        /* ==================================================================
           SETUP
           ================================================================== */

        /* In the order the bar shows them */
        var ACT_TYPES = {
            dj: 'DJ',
            solo: 'Solo Artist',
            duo: 'Duo',
            band: 'Band',
            mc: 'MC / Host',
            kids: 'Kids Entertainment'
        };

        var PER_PAGE = 12; // three rows of four
        var FEMALE = 'Female DJs'; // a genre choice that filters on t.female

        /* Drawn inline to save requests */
        var GLYPHS = {
            dj: '<path d="M4 14v-2a8 8 0 0116 0v2" fill="none" stroke="currentColor" stroke-width="2"/><rect x="2.5" y="13" width="5" height="7" rx="2"/><rect x="16.5" y="13" width="5" height="7" rx="2"/>',
            solo: '<circle cx="9" cy="16" r="4.5"/><path d="M12.6 13.2 19 4l2 1.6-6.6 9z"/>',
            duo: '<circle cx="6.5" cy="17" r="3"/><circle cx="16.5" cy="15" r="3"/><path d="M9 17V6l10.5-2v11" fill="none" stroke="currentColor" stroke-width="2"/>',
            band: '<ellipse cx="12" cy="16" rx="9" ry="5"/><path d="M3 11h18" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="7" cy="7" r="2.4"/><circle cx="17" cy="7" r="2.4"/>',
            mc: '<rect x="9" y="2" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0014 0" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 18v4" fill="none" stroke="currentColor" stroke-width="2"/>',
            kids: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="9" cy="10" r="1.3"/><circle cx="15" cy="10" r="1.3"/><path d="M8 14.5a5 5 0 008 0" fill="none" stroke="currentColor" stroke-width="2"/>'
        };

        var ALL_GLYPH =
            '<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.4"/>' +
            '<path d="M3 19c0-3.3 2.7-5 6-5s6 1.7 6 5z"/>' +
            '<path d="M14.5 19c0-2.4 1.4-4 3.5-4s3.5 1.6 3.5 4z"/>';

        var PIN_ICON =
            '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>';

        var state = { act: 'all', genre: 'all', event: 'all', q: '', page: 0 };

        var grid = document.getElementById('ent-grid');
        var empty = document.getElementById('ent-empty');
        var count = document.getElementById('ent-count');
        var typesBar = document.getElementById('ent-types');
        var selAct = document.getElementById('ent-filter-act');
        var selGen = document.getElementById('ent-filter-genre');
        var selEvt = document.getElementById('ent-filter-event');
        var search = document.getElementById('ent-search');
        var prev = document.getElementById('ent-prev');
        var next = document.getElementById('ent-next');
        var panel = document.getElementById('ent-panel');
        var panelBody = document.getElementById('ent-panel-body');
        var panelClose = document.getElementById('ent-panel-close');

        /* ==================================================================
           FILTERS
           ================================================================== */

        /* Every distinct value of one field across the roster, sorted */
        function optionsFrom(field) {
            var seen = {};
            TALENT.forEach(function (t) {
                (t[field] || []).forEach(function (v) {
                    seen[v] = true;
                });
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

        function matchesGenre(t) {
            if (state.genre === FEMALE) return !!t.female;
            if (state.genre === 'all') return true;
            return (t.genres || []).indexOf(state.genre) >= 0;
        }

        function matches(t) {
            if (state.act !== 'all' && t.act !== state.act) return false;
            if (!matchesGenre(t)) return false;
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

        /* ==================================================================
           CARDS
           ================================================================== */

        /* The photo as a CSS property, not an <img>, so a missing file
           leaves the gradient instead of a broken image */
        function photoStyle(t) {
            if (!t.photo) return '';
            var src = /^(https?:|\/|data:)/.test(t.photo) ? t.photo : '/' + t.photo;
            return ' style="--ent-img:url(\'' + esc(src) + '\')"';
        }

        function glyphSvg(attrs, act) {
            return '<svg' + attrs + ' viewBox="0 0 24 24" aria-hidden="true">' + (GLYPHS[act] || '') + '</svg>';
        }

        function locationLine(t) {
            return t.location ? '<p class="ent-card-loc">' + PIN_ICON + esc(t.location) + '</p>' : '';
        }

        /* main.js fills the act's name into the contact form */
        function enquireLink(className, name) {
            return (
                '<a class="' +
                className +
                '" href="/contact?about=' +
                encodeURIComponent(name) +
                '">' +
                'Make Enquiry <span aria-hidden="true">&#8594;</span>' +
                '</a>'
            );
        }

        function actPlural(key) {
            return ACT_TYPES[key] + (key === 'kids' ? '' : 's');
        }

        function cardHtml(t) {
            var genres = t.genres || [];
            var events = t.events || [];

            var genreLine = genres.length
                ? '<p class="ent-card-genres">' + genres.map(esc).join(' <i aria-hidden="true">&middot;</i> ') + '</p>'
                : '';

            var eventLine = events.length
                ? '<p class="ent-card-events">' +
                  glyphSvg('', t.act) +
                  events
                      .map(function (e) {
                          return '<span>' + esc(e) + '</span>';
                      })
                      .join('') +
                  '</p>'
                : '';

            return (
                '<article class="ent-card' +
                (t.photo ? ' has-photo' : '') +
                '" data-act="' +
                esc(t.act) +
                '"' +
                photoStyle(t) +
                '>' +
                // covers the whole card, so a click anywhere opens the panel
                '<button type="button" class="ent-card-media" data-slug="' +
                esc(t.slug) +
                '" aria-label="More about ' +
                esc(t.name) +
                '">' +
                glyphSvg(' class="ent-card-glyph"', t.act) +
                '</button>' +
                '<div class="ent-card-body">' +
                '<span class="ent-badge">' +
                esc(ACT_TYPES[t.act] || '') +
                '</span>' +
                '<h3>' +
                esc(t.name) +
                '</h3>' +
                locationLine(t) +
                genreLine +
                eventLine +
                enquireLink('btn btn-outline btn-small ent-view', t.name) +
                '</div>' +
                '</article>'
            );
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
                ? 'Showing ' + slice.length + ' of ' + list.length + (list.length === 1 ? ' act' : ' acts')
                : '';

            // Disabled, not hidden, so the header does not reflow
            prev.disabled = state.page === 0;
            next.disabled = state.page >= pages - 1;
        }

        /* ==================================================================
           PANEL
           ================================================================== */
        function openPanel(slug) {
            var t = TALENT.filter(function (x) {
                return x.slug === slug;
            })[0];
            if (!t) return;

            panelBody.innerHTML =
                '<div class="ent-panel-media"' +
                photoStyle(t) +
                '>' +
                glyphSvg(' class="ent-card-glyph"', t.act) +
                '</div>' +
                '<div class="ent-panel-body">' +
                '<span class="ent-badge">' +
                esc(ACT_TYPES[t.act] || '') +
                '</span>' +
                '<h3>' +
                esc(t.name) +
                '</h3>' +
                locationLine(t) +
                '<h4>Style</h4>' +
                '<p>' +
                (t.genres || []).map(esc).join(' &middot; ') +
                '</p>' +
                '<h4>Suits</h4>' +
                '<p>' +
                (t.events || []).map(esc).join(' &middot; ') +
                '</p>' +
                enquireLink('btn ent-btn', t.name) +
                '</div>';

            if (typeof panel.showModal === 'function') {
                panel.showModal();
            } else {
                panel.setAttribute('open', ''); // very old browsers
            }
        }

        function closePanel() {
            if (typeof panel.close === 'function') panel.close();
            else panel.removeAttribute('open');
        }

        /* ==================================================================
           WIRING
           ================================================================== */

        /* Only the act types somebody is filed under */
        var usedActs = Object.keys(ACT_TYPES).filter(function (key) {
            return TALENT.some(function (t) {
                return t.act === key;
            });
        });

        // With one act type there is nothing to filter, so hide the bar and the act dropdown
        var oneActTypeOnly = usedActs.length < 2;

        function setAct(act) {
            state.act = act;
            state.page = 0;

            page.querySelectorAll('.ent-type').forEach(function (b) {
                b.classList.toggle('is-on', b.getAttribute('data-act') === act);
            });
            if (selAct.value !== act) selAct.value = act;

            render();
        }

        function setFilter(key, value) {
            state[key] = value;
            state.page = 0;
            render();
        }

        /* The act-type bar */
        if (oneActTypeOnly) typesBar.hidden = true;

        typesBar.innerHTML =
            '<button type="button" class="ent-type is-on" data-act="all">' +
            '<svg viewBox="0 0 24 24" aria-hidden="true">' +
            ALL_GLYPH +
            '</svg>' +
            'All Talent' +
            '</button>' +
            usedActs
                .map(function (key) {
                    return (
                        '<button type="button" class="ent-type" data-act="' +
                        key +
                        '">' +
                        glyphSvg('', key) +
                        esc(actPlural(key)) +
                        '</button>'
                    );
                })
                .join('');

        /* The line under the headline names only the act types on the roster */
        var heroTypes = document.getElementById('ent-hero-types');
        if (heroTypes) {
            heroTypes.innerHTML = usedActs
                .map(function (key) {
                    return esc(actPlural(key));
                })
                .join(' &nbsp;|&nbsp; ');
        }

        /* The act dropdown shows labels but carries keys, like the bar */
        if (oneActTypeOnly) selAct.closest('.ent-select').hidden = true;

        fillSelect(selAct, usedActs, 'All Act Types');
        Array.prototype.forEach.call(selAct.options, function (o) {
            if (o.value !== 'all') o.textContent = ACT_TYPES[o.value];
        });

        /* Genres and event types are optional: no values, no dropdown */
        var genres = optionsFrom('genres');
        var hasFemale = TALENT.some(function (t) {
            return t.female;
        });
        if (hasFemale) genres.unshift(FEMALE); // its own choice at the top
        var events = optionsFrom('events');

        if (genres.length) fillSelect(selGen, genres, 'All Genres');
        else selGen.closest('.ent-select').hidden = true;

        if (events.length) fillSelect(selEvt, events, 'All Event Types');
        else selEvt.closest('.ent-select').hidden = true;

        /* Events */
        typesBar.querySelectorAll('.ent-type').forEach(function (btn) {
            btn.addEventListener('click', function () {
                setAct(btn.getAttribute('data-act'));
            });
        });

        selAct.addEventListener('change', function () {
            setAct(selAct.value);
        });
        selGen.addEventListener('change', function () {
            setFilter('genre', selGen.value);
        });
        selEvt.addEventListener('change', function () {
            setFilter('event', selEvt.value);
        });
        search.addEventListener('input', function () {
            setFilter('q', search.value.trim().toLowerCase());
        });

        prev.addEventListener('click', function () {
            state.page--;
            render();
        });
        next.addEventListener('click', function () {
            state.page++;
            render();
        });

        // One listener on the grid, because the cards are rebuilt on every filter change
        grid.addEventListener('click', function (ev) {
            var media = ev.target.closest ? ev.target.closest('.ent-card-media') : null;
            if (media) openPanel(media.getAttribute('data-slug'));
        });

        panelClose.addEventListener('click', closePanel);

        /* ==================================================================
           VIDEO
           ================================================================== */

        // Reduced motion: pause the hero clip (the poster frame still shows)
        var heroVideo = document.getElementById('ent-hero-video');
        if (heroVideo && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            heroVideo.removeAttribute('autoplay');
            heroVideo.pause();
        }

        // The reel: closing must pause it too, or the sound keeps playing
        var play = document.getElementById('ent-play');
        var video = document.getElementById('ent-video');
        var videoEl = document.getElementById('ent-video-el');
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
                videoEl.play().catch(function () {
                    /* autoplay blocked - the controls are there */
                });
            });

            videoShut.addEventListener('click', closeVideo);
            video.addEventListener('click', function (ev) {
                if (ev.target === video) closeVideo();
            });
            // Escape closes a dialog on its own, but does not pause the video
            video.addEventListener('close', function () {
                videoEl.pause();
            });
        }

        // A click on the dialog itself is a click on the backdrop
        panel.addEventListener('click', function (ev) {
            if (ev.target === panel) closePanel();
        });

        render();
    }
})();
