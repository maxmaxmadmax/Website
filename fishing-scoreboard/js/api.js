// ============================================================
// api.js
// Storage: catches.json lives in the GitHub repo.
//
// READS  → raw.githubusercontent.com (public, no login needed)
// WRITES → GitHub Contents API (token saved once in browser)
// ============================================================

const OWNER    = 'maxmaxmadmax';
const REPO     = 'Website';
const FILEPATH = 'fishing-scoreboard/data/catches.json';

// Public URL — anyone can read this, no token needed
const RAW_URL  = `https://raw.githubusercontent.com/${OWNER}/${REPO}/main/${FILEPATH}?t=`;

// GitHub API URL for reading SHA + writing
const API_URL  = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${FILEPATH}`;

// ---------- Read all catches (no token needed) ----------
async function readCatches() {
    const res = await fetch(RAW_URL + Date.now()); // cache-bust
    if (!res.ok) throw new Error('Could not read catch data.');
    return await res.json();
}

// ---------- Write catches (uses token from browser storage) ----------
async function writeCatches(catches) {
    const token = localStorage.getItem('gh_token');
    if (!token) throw new Error('NO_TOKEN');

    // We need the current file SHA before we can update it
    const metaRes = await fetch(API_URL, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json'
        }
    });

    if (metaRes.status === 401) throw new Error('BAD_TOKEN');
    if (!metaRes.ok) throw new Error('Could not fetch file metadata.');

    const meta    = await metaRes.json();
    const content = btoa(unescape(encodeURIComponent(JSON.stringify(catches, null, 2))));

    const writeRes = await fetch(API_URL, {
        method: 'PUT',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            message: 'Update catches',
            content: content,
            sha:     meta.sha
        })
    });

    if (writeRes.status === 401) throw new Error('BAD_TOKEN');
    if (!writeRes.ok) throw new Error('Could not save catch data.');
    return true;
}

// ---------- Helpers ----------
function generateId() {
    return 'catch_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

function nowTimestamp() {
    return new Date().toLocaleString('sv-SE').replace('T', ' ').slice(0, 19);
}

function escHtml(str) {
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
}

// ---------- Build leaderboard ----------
// Best catch per species + division. Highest weight wins; tie = longest length.
function buildLeaders(catches) {
    const groups = {};
    for (const c of catches) {
        const key = c.species + '|' + c.division;
        if (!groups[key]) {
            groups[key] = c;
        } else {
            const curr = groups[key];
            if (c.weight_kg > curr.weight_kg ||
               (c.weight_kg == curr.weight_kg && c.length_cm > curr.length_cm)) {
                groups[key] = c;
            }
        }
    }
    return Object.values(groups).sort((a, b) =>
        a.species !== b.species
            ? a.species.localeCompare(b.species)
            : a.division.localeCompare(b.division)
    );
}
