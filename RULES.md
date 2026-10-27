# SoundzGood website: house rules

Keep the project clean. Every change follows these rules. (Max, 27 Oct 2026)

## 1. Where things go

| What | Where | Why |
|---|---|---|
| Web pages (`.html`) | top level | The file name **is** the web address (`hire.html` = soundzgood.com.au/hire). Never move or rename a page without leaving a redirect. |
| Styles (`.css`) | `css/` | One file per page, named the same as the page (`hire.html` → `css/hire.css`). Shared styles go in `css/style.css`. |
| Scripts (`.js`) | `js/` | Named after the page or job (`js/picklist.js`). |
| Photos, logos | `images/<topic>/` | e.g. `images/services/`, `images/venues/`. |
| Videos | `videos/` | |
| Shared page parts | `components/` | navbar, footer. |
| Firebase rules and indexes | `firebase/` | `firebase.json` and `.firebaserc` stay at the top (Firebase needs them there). |
| Server code | `functions/` | Firebase needs it here. |
| Notes and how-tos | `docs/` | |
| Helper scripts | `tools/` | |
| Old or unused things | `3_sg-hod/archive/` | Archive, don't delete. |

Only these stay at the top as well as the pages: `CNAME`, `robots.txt`, `sitemap.xml`, `version.json`, `firebase.json`, `.firebaserc`, `RULES.md`.

## 2. Naming

- Lower case, words joined with hyphens: `island-av-hire.css`, not `IslandAVHire.css`.
- Name files for **what they are**, never a random code.
- Inventory photos are saved as `inventory/<product-name>-<id>.webp`. The admin does this automatically.

## 3. Photos and files

- Photos are WebP, no bigger than 800px for gear and about 1600px for page banners. Aim for under 150 KB each.
- The admin's Inventory upload shrinks and names photos itself. Use **Inventory → Shrink photos** for old ones.
- No file over 10 MB goes in the website folder. Big videos go on YouTube or Vimeo.

## 4. Data (Firebase)

- Each kind of record has one collection (`quotes`, `customers`, `inventory` ...). Don't make a second one for the same thing.
- Money, bookings and sites are only changed by the server (Cloud Functions), never straight from a browser.
- Private data (customers, staff, money, leads) is admin-only. Only what the public site shows is public.
- New collections must be added to `firebase/firestore.rules`. Anything not listed there is locked.
- Records are cancelled or archived, not deleted, so there's a history.
- No passwords, keys or secrets in this folder. They live in Firebase secrets. This repo is public.

## 5. Every change

1. Check scripts: `node --input-type=module --check < js/<file>.js`.
2. Run `node tools/bump-assets.js` after changing any CSS, JS or HTML. This makes every browser load the new version.
3. Make sure every link still works before pushing.
4. Leave a short plain note in the code saying what it does and why (with the date).
