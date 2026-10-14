/* ==========================================================================
   EVENT PAGE (for punters) - /eatz-beatz-halloween-2026

   Two small jobs:
     1. The Share button - the phone's share sheet, or copy the link.
     2. "Who's coming" - asks the eventLineup function for the confirmed,
        paid vendors (business name and category only) and lists them.
        No vendors yet, or the call fails -> the section stays hidden.
        Fetched fresh on every visit, so new paid vendors appear on their
        own (the function caches for 5 minutes). "Other ..." categories
        are left off - they say nothing to a punter.
   ========================================================================== */
(function () {
    'use strict';

    /* ---- 1. Share ---- */
    var share = document.getElementById('ep-share');
    if (share) {
        share.addEventListener('click', function () {
            var data = { title: document.title, url: location.href.split('#')[0] };
            if (navigator.share) {
                navigator.share(data).catch(function () { /* they closed it */ });
                return;
            }
            var note = document.getElementById('ep-share-note');
            (navigator.clipboard ? navigator.clipboard.writeText(data.url) : Promise.reject())
                .then(function () { if (note) note.hidden = false; })
                .catch(function () { prompt('Copy this link:', data.url); });
        });
    }

    /* ---- 2. Who's coming ---- */
    var box = document.getElementById('ep-lineup');
    if (!box) return;

    var URL = 'https://australia-southeast1-soundzgood-8c86f.cloudfunctions.net/eventLineup?event=' +
              encodeURIComponent(box.getAttribute('data-event'));

    function esc(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    /*  THE PICTURE ON EACH CARD

        Vendors haven't sent photos yet (next event they will - Max,
        14 Oct 2026), so each card gets a generic picture for its kind of
        food or stall: an icon on a warm background.

        To use a real photo for a category, drop it in images/vendor-cats/
        named <category id>.webp and add the id to PHOTOS below.        */
    var ICONS = {
        'burgers-fries-american': '🍔', 'pizza-italian': '🍕', 'mexican-tacos': '🌮',
        'asian-noodles': '🍜', 'indian-curry': '🍛', 'bbq-smoked-meats': '🍖',
        'seafood': '🦐', 'chicken-wings': '🍗', 'hot-dogs-sausages': '🌭',
        'donuts-churros': '🍩', 'ice-cream-gelato': '🍦', 'cakes-baked-sweets': '🧁',
        'lollies-fairy-floss': '🍭', 'coffee': '☕', 'drinks-juice-smoothies': '🥤',
        'healthy-salads-acai': '🥗', 'vegetarian-vegan': '🥑', 'other-food': '🍽️',
        'clothing-fashion': '👕', 'jewellery': '💍', 'candles-home-fragrance': '🕯️',
        'arts-prints-photography': '🎨', 'handmade-crafts': '🧶', 'homewares-decor': '🏺',
        'beauty-skincare': '🧴', 'plants-garden': '🪴', 'toys-kids-products': '🧸',
        'pet-products': '🐾', 'local-produce-packaged': '🍯', 'gifts-novelty': '🎁',
        'spiritual-crystals': '🔮', 'services-promotional': '📣',
        'community-charity-club': '🤝', 'other-market': '🛍️'
    };
    var PHOTOS = [];   // e.g. ['pizza-italian'] once images/vendor-cats/pizza-italian.webp exists

    /*  A better label (and picture) for a vendor whose category doesn't
        say much - mostly the "Other" ones. Keyed by the business name
        exactly as they typed it.                                      */
    var BETTER = {
        'Cheeky Chicky':   { label: 'Fried Chicken',            cat: 'chicken-wings' },
        'Sweet Wheels':    { label: 'Sweet Treats',             cat: 'lollies-fairy-floss' },
        'Tropical Blendz': { label: 'Fresh Drinks / Smoothies', cat: 'drinks-juice-smoothies' },
        'Pretty Girl Ave': { label: 'Hair Accessories / Gifts', cat: 'gifts-novelty' }
    };

    function art(cat) {
        if (PHOTOS.indexOf(cat) >= 0) {
            return '<span class="ep-art" style="background-image:url(\'images/vendor-cats/' + cat + '.webp\')"></span>';
        }
        return '<span class="ep-art ep-art-icon" aria-hidden="true">' + (ICONS[cat] || '⭐') + '</span>';
    }

    function card(r, kind) {
        var fix = BETTER[r.name] || {};
        var cat = fix.cat || r.categoryId || '';
        var label = fix.label || (r.category && !/^other/i.test(r.category) ? r.category : '');
        var link = r.link && /^https?:\/\//i.test(r.link) ? r.link : '';
        var inner = art(cat) +
            '<span class="ep-v-text"><b>' + esc(r.name) + '</b>' +
            (label ? '<small>' + esc(label) + '</small>' : '') + '</span>' +
            (link ? '<i class="ep-v-go" aria-hidden="true">&#8250;</i>' : '');
        /*  The vendor's own link (checked server side: http/https only).
            Opens in a new tab; nofollow because we don't vouch for it. */
        return link
            ? '<a class="ep-v ep-v-' + kind + '" href="' + esc(link).replace(/"/g, '&quot;') +
              '" target="_blank" rel="noopener nofollow ugc">' + inner + '</a>'
            : '<div class="ep-v ep-v-' + kind + '">' + inner + '</div>';
    }

    function fill(id, rows, kind) {
        var el = document.getElementById(id);
        if (!el || !rows || !rows.length) return false;
        el.querySelector('.ep-' + kind).innerHTML = rows.map(function (r) { return card(r, kind); }).join('');
        el.hidden = false;
        return true;
    }

    fetch(URL)
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
            if (!d) return;
            var any = fill('ep-food', d.food, 'food');
            any = fill('ep-market', d.market, 'market') || any;
            if (any) box.hidden = false;
        })
        .catch(function () { /* stays hidden */ });
}());
