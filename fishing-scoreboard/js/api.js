// ============================================================
// api.js
// Storage: public GitHub Gist (no token needed to read).
// Writes (admin/edit) use a token saved in the browser.
// ============================================================

const GIST_ID  = '97c3aa66fb9b53e4dbb7daa4b76eac5f';
const GIST_URL = `https://api.github.com/gists/${GIST_ID}`;

// Raw public URL — readable by anyone, no auth needed
const RAW_URL  = `https://gist.githubusercontent.com/maxmaxmadmax/${GIST_ID}/raw/catches.json`;

// ---------- Read catches (no token required) ----------
async function readCatches() {
    // Add cache-busting so the browser always fetches the latest version
    const res = await fetch(RAW_URL + '?t=' + Date.now());
    if (!res.ok) throw new Error('Could not read scoreboard data.');
    return await res.json();
}

// ---------- Write catches (requires token in localStorage) ----------
async function writeCatches(catches) {
    const token = localStorage.getItem('gh_token');
    if (!token) throw new Error('NO_TOKEN');

    const res = await fetch(GIST_URL, {
        method: 'PATCH',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            files: { 'catches.json': { content: JSON.stringify(catches, null, 2) } }
        })
    });
    if (res.status === 401) throw new Error('BAD_TOKEN');
    if (!res.ok) throw new Error('Could not save data.');
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
        a.species !== b.species ? a.species.localeCompare(b.species) : a.division.localeCompare(b.division)
    );
}
