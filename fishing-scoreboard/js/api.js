// ============================================================
// api.js
// Reads and writes catch data using a GitHub Gist as storage.
// ============================================================

const GIST_URL = `https://api.github.com/gists/${GITHUB_GIST_ID}`;

// ---------- Read all catches from the Gist ----------
async function readCatches() {
    const res = await fetch(GIST_URL, {
        headers: {
            'Authorization': `Bearer ${GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github+json'
        }
    });
    if (!res.ok) throw new Error('Could not read data from Gist.');
    const data = await res.json();
    // The gist stores the JSON as a string inside files['catches.json'].content
    return JSON.parse(data.files['catches.json'].content) || [];
}

// ---------- Write the full catches array back to the Gist ----------
async function writeCatches(catches) {
    const res = await fetch(GIST_URL, {
        method: 'PATCH',
        headers: {
            'Authorization': `Bearer ${GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github+json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            files: {
                'catches.json': {
                    content: JSON.stringify(catches, null, 2)
                }
            }
        })
    });
    if (!res.ok) throw new Error('Could not save data to Gist.');
    return true;
}

// ---------- Generate a unique ID ----------
function generateId() {
    return 'catch_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// ---------- Current timestamp as "YYYY-MM-DD HH:MM:SS" ----------
function nowTimestamp() {
    return new Date().toLocaleString('sv-SE').replace('T', ' ').slice(0, 19);
}

// ---------- Escape HTML to prevent XSS ----------
function escHtml(str) {
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
}

// ---------- Build leaderboard from catches ----------
// Best catch per species+division. Highest weight wins; tie = longest length.
function buildLeaders(catches) {
    const groups = {};
    for (const c of catches) {
        const key = c.species + '|' + c.division;
        if (!groups[key]) {
            groups[key] = c;
        } else {
            const curr = groups[key];
            const beatsByWeight = c.weight_kg > curr.weight_kg;
            const sameWeight    = c.weight_kg == curr.weight_kg;
            const beatsByLength = c.length_cm > curr.length_cm;
            if (beatsByWeight || (sameWeight && beatsByLength)) {
                groups[key] = c;
            }
        }
    }
    return Object.values(groups).sort((a, b) => {
        if (a.species !== b.species) return a.species.localeCompare(b.species);
        return a.division.localeCompare(b.division);
    });
}
