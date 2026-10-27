# SoundzGood website: house rules

Keep the project clean. Every change follows these rules.

## 1. Where things go

| What | Where | Why |
|---|---|---|
| Web pages (`.html`) | `pages/site/` (public), `pages/event-stories/`, `pages/customer/` (quote, pick list...), `pages/admin/` | The web address comes from the `permalink:` lines at the top of each page (`permalink: /hire.html` = soundzgood.com.au/hire). **Never change a permalink.** A new page needs one. |
| Styles (`.css`) | `css/` | One file per page, named the same as the page (`pages/site/hire.html` → `css/hire.css`). Styles shared by a group of pages are named for the group (`css/event-story.css`); styles for every page go in `css/style.css`. |
| Scripts (`.js`) | `js/` | Named after the page or job (`js/picklist.js`). |
| Photos, logos | `images/<topic>/` | e.g. `images/services/`, `images/venues/`. |
| Videos | `videos/` | |
| Shared page parts | `components/` | navbar, footer. |
| Firebase rules and indexes | `firebase/` | `firebase.json` and `.firebaserc` stay at the top (Firebase needs them there). |
| Server code | `functions/` | Firebase needs it here. |
| Notes and how-tos | `docs/` | |
| Helper scripts | `tools/` | |
| Old or unused things | `3_sg-hod/archive/` | Archive, don't delete. |

Only these stay at the top: `CNAME`, `robots.txt`, `sitemap.xml`, `version.json`, `firebase.json`, `.firebaserc`, `.gitignore`, `.gitattributes`, plus the folders.

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
4. Notes in the code are short and plain: what it does, and any warning. No dates, names or history - that goes in the git commit message.
