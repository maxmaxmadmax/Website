/* ==========================================================================
   OLD PICTURES - loaded by every public page and the admin (with defer).
   images/ and videos/ now live in data/. Records saved before the move
   (posters, sponsor logos, DJ photos, old quotes) still say images/...,
   so any picture that shows up with an old address is switched to the new
   one as it lands on the page. Other sites' addresses are left alone.
   ========================================================================== */
(function () {
    var OLD_SRC = /^(\/?)(images|videos)\//;
    var OLD_URL = /url\((['"]?)(\/?)(images|videos)\//g;

    function fix(el) {
        if (el.nodeType !== 1) return;
        var src = el.getAttribute('src');
        if (src && OLD_SRC.test(src)) el.setAttribute('src', src.replace(OLD_SRC, '$1data/$2/'));
        var style = el.getAttribute('style');
        if (style && style.indexOf('images/') > -1) {
            var fixed = style.replace(OLD_URL, 'url($1$2data/$3/');
            if (fixed !== style) el.setAttribute('style', fixed);
        }
    }

    function fixAll(root) {
        fix(root);
        if (root.querySelectorAll)
            root.querySelectorAll('[src^="images/"],[src^="/images/"],[src^="videos/"],[src^="/videos/"],[style*="images/"]').forEach(fix);
    }

    fixAll(document.documentElement);
    new MutationObserver(function (changes) {
        changes.forEach(function (c) {
            if (c.type === 'attributes') fix(c.target);
            else c.addedNodes.forEach(fixAll);
        });
    }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'style'] });
})();
