/* ==========================================================================
   EVENT PAGE (for punters) - /eatz-beatz-halloween-2026

   Three small jobs:
     1. The Share button - the phone's share sheet, or copy the link.
     2. The Print A4 button - the browser's print, which uses the
        @media print styles in event-page.css (a mini magazine).
     3. Food vendors + market stalls - asks the eventLineup function for the
        confirmed, PAID vendors (name, category, first line of their
        description, their link) and draws them. Fetched fresh on every
        visit, so new paid vendors appear on their own (the function caches
        for 5 minutes). No vendors, or the call fails -> sections stay hidden.
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

    /* ---- 2. Print ---- */
    var print = document.getElementById('ep-print');
    if (print) print.addEventListener('click', function () { window.print(); });

    /* ---- 3. Vendors ---- */
    var food = document.getElementById('ep-food');
    var market = document.getElementById('ep-market');
    if (!food) return;

    var URL = 'https://australia-southeast1-soundzgood-8c86f.cloudfunctions.net/eventLineup?event=' +
              encodeURIComponent(food.getAttribute('data-event'));

    function esc(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    /*  FOOD PHOTOS - one per kind of food, free Unsplash pictures in
        images/vendor-cats/ (see CREDITS.txt there). A vendor's own photo
        can replace one later: same file name.                         */
    var PHOTOS = [
        'burgers-fries-american', 'cakes-baked-sweets', 'chicken-wings', 'drinks-juice-smoothies',
        'hot-dogs-sausages', 'ice-cream-gelato', 'indian-curry', 'lollies-fairy-floss',
        'mexican-tacos', 'pizza-italian'
    ];

    /*  THE WORDS ON EACH CARD
        tag   = the small orange label (kind of food)
        line  = one tidy line, written from what the vendor told us
        cat   = a better category, where theirs didn't fit
        label = the market tile name for that better category
        name  = how to show their name, if it differs from how they typed it
        photo = the vendor's OWN photo (images/vendors/<file>), used instead
                of the generic picture for their kind of food
        Keyed by the business name exactly as they typed it. A NEW vendor
        doesn't need a line here - they get the first sentence of their
        own description automatically.                                */
    var WORDS = {
        'Airlie Waffle':        { tag: 'Waffles',       line: 'Bubble waffles and bubble iced tea.', name: 'Airlie Waffles' },
        'Amazing wieners':      { tag: 'Hot dogs',      line: 'German bratwurst, cheesy kransky and kids’ hot dogs.' },
        'Ammos Shak':           { tag: 'Indian',        line: 'Indian food and curries.', name: 'Ammo’s Shak' },
        'Cheeky Chicky':        { tag: 'Fried chicken', line: 'Pork belly bites, crispy wings, loaded fries and chicken burgers.', cat: 'chicken-wings' },
        'Grumpy Mas':           { tag: 'Burgers',       line: 'Hearty burgers and loaded fries.' },
        'Loopy Scoops':         { tag: 'Ice cream',     line: 'Soft serve, premium scooped ice cream and snow cones.' },
        'Sweet Wheels':         { tag: 'Sweet treats',  line: 'Sweet treats from the red food van.', cat: 'lollies-fairy-floss' },
        'Tropical Blendz':      { tag: 'Drinks',        line: 'Fresh drinks and smoothies.', cat: 'drinks-juice-smoothies' },
        'Tropical Pizza':       { tag: 'Pizza',         line: 'Pizza, wings and soft drinks.' },
        'Vandito Viesta':       { tag: 'Mexican',       line: 'A vibrant Mexican food van serving flavour-packed food.' },

        'Pretty Girl Ave':      { cat: 'gifts-novelty' },   // booked as Other

        // booked under Plants / Garden, but they sell sweets
        'Sian\'s Sugar Shack':  { cat: 'local-produce-packaged', label: 'Sweets & Treats' }
    };

    /*  MARKET TILE ICONS - simple line drawings, one per kind of stall. */
    var P = 'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';
    var ICON = {
        'clothing-fashion':        '<path ' + P + ' d="M8 3l-5 3 2 5 3-1v11h8V10l3 1 2-5-5-3a4 4 0 01-8 0z"/>',
        'jewellery':               '<path ' + P + ' d="M6 3h12l3 6-9 12L3 9zM3 9h18M9 3l3 6 3-6M12 9v12"/>',
        'plants-garden':           '<path ' + P + ' d="M12 21V11M12 11C12 6 8 3 4 3c0 5 3 8 8 8zM12 14c0-4 3-7 8-7 0 4-3 7-8 7z"/>',
        'gifts-novelty':           '<path ' + P + ' d="M3 9h18v4H3zM5 13v8h14v-8M12 9v12M12 9c-2-4-7-4-5-1 1 1 5 1 5 1zM12 9c2-4 7-4 5-1-1 1-5 1-5 1z"/>',
        'handmade-crafts':         '<path ' + P + ' d="M12 21s-8-5-8-11a4.5 4.5 0 018-3 4.5 4.5 0 018 3c0 6-8 11-8 11z"/>',
        'toys-kids-products':      '<path ' + P + ' d="M12 21a7 7 0 100-14 7 7 0 000 14zM6 9a2.5 2.5 0 112-4M18 9a2.5 2.5 0 10-2-4M10 13h.01M14 13h.01M10 16c1 1 3 1 4 0"/>',
        'candles-home-fragrance':  '<path ' + P + ' d="M8 10h8v11H8zM12 10V7M12 7c-2-2 0-4 0-4s2 2 0 4z"/>',
        'arts-prints-photography': '<path ' + P + ' d="M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6M15 9h.01"/>',
        'homewares-decor':         '<path ' + P + ' d="M3 11l9-8 9 8M5 9v12h14V9"/>',
        'beauty-skincare':         '<path ' + P + ' d="M9 3h6v4H9zM8 7h8v14H8zM8 12h8"/>',
        'local-produce-packaged':  '<path ' + P + ' d="M6 9a6 6 0 0112 0v1H6zM5 10h14l-2 11H7zM12 3v3"/>'
    };
    var BAG = '<path ' + P + ' d="M5 8h14l-1 13H6zM9 8V6a3 3 0 016 0v2"/>';

    function linkOf(r) {
        return r.link && /^https?:\/\//i.test(r.link) ? r.link : '';
    }

    function foodCard(r) {
        var w = WORDS[r.name] || {};
        var cat = w.cat || r.categoryId || '';
        var tag = w.tag || (r.category && !/^other/i.test(r.category) ? r.category.split(' / ')[0] : 'Food');
        var line = w.line || r.blurb || '';
        var link = linkOf(r);
        // the vendor's own photo first, else the generic one for their kind of food
        var img = w.photo || (PHOTOS.indexOf(cat) >= 0 ? 'images/vendor-cats/' + cat + '.webp' : '');
        var pic = img
            ? '<span class="ep-fv-pic" style="background-image:url(\'' + img + '\')"></span>'
            : '<span class="ep-fv-pic ep-fv-pic-none" aria-hidden="true"></span>';
        var inner = pic +
            '<span class="ep-fv-text">' +
              '<small>' + esc(tag) + '</small>' +
              '<b>' + esc(w.name || r.name) + '</b>' +
              (line ? '<span>' + esc(line) + '</span>' : '') +
            '</span>' +
            (link ? '<i class="ep-fv-go" aria-hidden="true">&rarr;</i>' : '');
        /*  The vendor's own link (checked server side: http/https only).
            Opens in a new tab; nofollow because we don't vouch for it. */
        return link
            ? '<a class="ep-fv" href="' + esc(link).replace(/"/g, '&quot;') +
              '" target="_blank" rel="noopener nofollow ugc">' + inner + '</a>'
            : '<div class="ep-fv">' + inner + '</div>';
    }

    /*  MARKET STALLS: ONE TILE PER KIND OF STALL (Max, 14 Oct 2026),
        with every vendor of that kind listed on it.                  */
    function marketTiles(rows) {
        var groups = [], byCat = {};
        rows.forEach(function (r) {
            var w = WORDS[r.name] || {};
            var cat = w.cat || r.categoryId || 'other-market';
            var label = w.label || (r.category && !/^other/i.test(r.category) ? r.category : 'Other stalls');
            if (!byCat[cat]) { byCat[cat] = { cat: cat, label: label, names: [] }; groups.push(byCat[cat]); }
            var link = linkOf(r);
            byCat[cat].names.push(link
                ? '<a href="' + esc(link).replace(/"/g, '&quot;') + '" target="_blank" rel="noopener nofollow ugc">' +
                  esc(r.name) + '</a>'
                : esc(r.name));
        });
        groups.sort(function (a, b) { return a.label.localeCompare(b.label); });
        return groups.map(function (g) {
            return '<div class="ep-mt">' +
                '<div class="ep-mt-head">' +
                  '<svg viewBox="0 0 24 24" aria-hidden="true">' + (ICON[g.cat] || BAG) + '</svg>' +
                  '<b>' + esc(g.label.replace(/ \/ /g, ' & ')) + '</b>' +
                '</div>' +
                '<ul><li>' + g.names.join('</li><li>') + '</li></ul>' +
                '</div>';
        }).join('');
    }

    fetch(URL)
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
            if (!d) return;
            if (d.food && d.food.length) {
                food.querySelector('.ep-food').innerHTML = d.food.map(foodCard).join('');
                food.hidden = false;
            }
            if (market && d.market && d.market.length) {
                market.querySelector('.ep-market').innerHTML = marketTiles(d.market);
                market.hidden = false;
            }
        })
        .catch(function () { /* stays hidden */ });
}());
