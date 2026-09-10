/* ==========================================================================
   CACHE BUSTING

   GitHub Pages serves the CSS and JS with a ten minute cache and the HTML
   with none. So for ten minutes after a deploy the new page is asking for
   the old stylesheet, and the site looks broken or unchanged - which has
   cost us more than one "is this actually live?" already.

   The fix is a version on every local asset:

       <link rel="stylesheet" href="events.css?v=3">

   A new number is a new URL, so the browser fetches it rather than reusing
   what it has. Nothing else changes.

   USE IT
       node tools/bump-assets.js          bump every asset by one
       node tools/bump-assets.js 12       set them all to 12

   Run it whenever a .css or .js file changes, before committing. It is
   safe to run twice - it rewrites the number rather than stacking another
   one on the end.

   WHAT IT DOES NOT TOUCH
   Anything with a scheme (https://, //) - the Firebase SDK and the fonts
   are somebody else's cache to worry about. Only paths relative to this
   site are given a version.
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/*  Local .css and .js in an href/src, and the two local module imports.
    The capture groups are (before)(path)(existing ?v=..)(after) so the
    rewrite can drop a stale version rather than appending to it. */
const PATTERNS = [
  /(\b(?:href|src)=")(?!https?:|\/\/)([^"?]+\.(?:css|js))(\?v=[^"]*)?(")/g,
  /(from\s+')(\.\/[^']+\.js)(\?v=[^']*)?(')/g,
];

function currentVersions(files) {
  const seen = new Set();
  for (const f of files) {
    const m = fs.readFileSync(f, 'utf8').match(/\?v=(\d+)/g) || [];
    m.forEach((x) => seen.add(Number(x.slice(3))));
  }
  return seen;
}

function main() {
  const html = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'));
  const js = fs.readdirSync(path.join(ROOT, 'js'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => path.join('js', f));

  const files = [...html, ...js].map((f) => path.join(ROOT, f));

  const seen = currentVersions(files);
  const asked = process.argv[2];
  const next = asked !== undefined
    ? Number(asked)
    : (seen.size ? Math.max(...seen) + 1 : 1);

  if (!Number.isFinite(next) || next < 1) {
    console.error('Version must be a positive whole number.');
    process.exit(1);
  }

  let touched = 0;
  let refs = 0;

  for (const file of files) {
    const before = fs.readFileSync(file, 'utf8');
    let after = before;

    for (const re of PATTERNS) {
      after = after.replace(re, (_m, pre, target, _old, post) => {
        refs++;
        return `${pre}${target}?v=${next}${post}`;
      });
    }

    if (after !== before) {
      fs.writeFileSync(file, after);
      touched++;
      console.log('  ' + path.relative(ROOT, file));
    }
  }

  console.log(`\nv=${next} on ${refs} references across ${touched} files.`);
}

main();
