/* --------------------------------------------------------------------------
   Vendor admin dashboard

   Not linked from the public menu and marked noindex. Getting to the page is
   not what protects it - the Firestore rules and the Cloud Functions check
   for an admin claim, so a signed-out visitor sees nothing but the sign in
   box, and a signed-in vendor without the claim sees nothing either.
   -------------------------------------------------------------------------- */

import {
  firebaseConfig,
  functionsRegion,
  eventId,
  isFirebaseConfigured,
} from './firebase-config.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.14.1';

let fb = null;
let bookings = [];
let sites = [];
let categories = [];

document.addEventListener('DOMContentLoaded', init);

async function init() {
  if (!isFirebaseConfigured) {
    showError('admin',
      'Firebase is not connected yet. Fill in js/firebase-config.js first.');
    return;
  }

  fb = await loadFirebase();
  wire();

  fb.a.onAuthStateChanged(fb.auth, async (user) => {
    if (!user) return showSignIn();

    // The claim is what counts. Force a refresh so a newly granted admin
    // does not have to sign out and back in.
    const token = await user.getIdTokenResult(true);

    if (token.claims.admin !== true) {
      showError('admin', 'That account is not an admin.');
      await fb.a.signOut(fb.auth);
      return;
    }

    showDashboard(user);
    subscribeAll();
  });
}

async function loadFirebase() {
  const [{ initializeApp }, auth, firestore, functions] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-firestore.js`),
    import(`${SDK}/firebase-functions.js`),
  ]);

  const app = initializeApp(firebaseConfig);
  return {
    auth: auth.getAuth(app),
    db: firestore.getFirestore(app),
    fns: functions.getFunctions(app, functionsRegion),
    a: auth,
    f: firestore,
    fn: functions,
  };
}

function wire() {
  const form = document.getElementById('va-form');
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    showError('admin', '');
    try {
      await fb.a.signInWithEmailAndPassword(
        fb.auth,
        document.getElementById('va-email').value.trim(),
        document.getElementById('va-password').value
      );
    } catch (err) {
      showError('admin', err.message);
    }
  });

  document.querySelectorAll('[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-tab');
      document.querySelectorAll('[data-tab]').forEach((b) =>
        b.classList.toggle('is-selected', b === btn));
      document.querySelectorAll('.va-panel').forEach((p) => {
        p.hidden = p.getAttribute('data-panel') !== tab;
      });
    });
  });

  document.getElementById('va-seed').addEventListener('click', seedEvent);
}

function showSignIn() {
  document.getElementById('va-signin').hidden = false;
  document.getElementById('va-dash').hidden = true;
}

function showDashboard(user) {
  document.getElementById('va-signin').hidden = true;
  document.getElementById('va-dash').hidden = false;

  const bar = document.getElementById('va-account');
  bar.innerHTML = `
    <span class="vs-account-email">${escapeHtml(user.email)}</span>
    <button type="button" class="vs-link" id="va-signout">Sign out</button>`;
  document.getElementById('va-signout')
    .addEventListener('click', () => fb.a.signOut(fb.auth));
}

/* -------------------------------------------------------------------------
   Live data
   ------------------------------------------------------------------------- */
function subscribeAll() {
  const { collection, onSnapshot, query, where, orderBy } = fb.f;

  onSnapshot(
    query(collection(fb.db, 'bookings'), where('eventId', '==', eventId)),
    (snap) => {
      bookings = [];
      snap.forEach((d) => bookings.push({ id: d.id, ...d.data() }));
      bookings.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
      renderBookings();
    },
    (err) => showError('admin', err.message)
  );

  onSnapshot(collection(fb.db, 'events', eventId, 'sites'), (snap) => {
    sites = [];
    snap.forEach((d) => sites.push({ id: d.id, ...d.data() }));
    sites.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
    renderSites();
    renderBookings();
  });

  onSnapshot(collection(fb.db, 'events', eventId, 'categories'), (snap) => {
    categories = [];
    snap.forEach((d) => categories.push({ id: d.id, ...d.data() }));
    categories.sort((a, b) => a.name.localeCompare(b.name));
    renderCategories();
  });
}

/* -------------------------------------------------------------------------
   Bookings
   ------------------------------------------------------------------------- */
function renderBookings() {
  const host = document.getElementById('va-bookings');
  const summary = document.getElementById('va-booking-summary');
  if (!host) return;

  const confirmed = bookings.filter((b) => b.status === 'confirmed');
  const pending = bookings.filter((b) => b.status === 'pending_payment');
  const attention = bookings.filter((b) => b.status === 'needs_attention');

  const paid = confirmed.reduce((sum, b) => sum + (b.amountPaidCents || 0), 0);

  summary.textContent =
    `${confirmed.length} confirmed · ${pending.length} awaiting payment · ` +
    `${attention.length} need attention · $${(paid / 100).toFixed(2)} taken`;

  if (!bookings.length) {
    host.innerHTML = '<p class="vs-muted">No bookings yet.</p>';
    return;
  }

  host.innerHTML = `
    <div class="va-table-wrap">
      <table class="va-table">
        <thead>
          <tr>
            <th>Ref</th><th>Business</th><th>Type</th><th>Category</th>
            <th>Site</th><th>Status</th><th>Paid</th><th></th>
          </tr>
        </thead>
        <tbody>
          ${bookings.map((b) => `
            <tr class="${b.status === 'needs_attention' ? 'is-flagged' : ''}">
              <td>${escapeHtml(b.reference || b.id.slice(0, 6))}</td>
              <td>
                ${escapeHtml(b.business?.name || '-')}
                <span class="va-sub">${escapeHtml(b.business?.email || '')}</span>
              </td>
              <td>${escapeHtml(b.vendorType || '')}</td>
              <td>${escapeHtml(b.categoryName || '-')}</td>
              <td>${escapeHtml(b.siteLabel || '-')}</td>
              <td><span class="va-status is-${escapeHtml(b.status)}">${escapeHtml(b.status)}</span></td>
              <td>${b.amountPaidCents != null ? '$' + (b.amountPaidCents / 100).toFixed(2)
                    : (b.paymentStatus === 'free' ? 'Free' : '-')}</td>
              <td>
                ${b.status === 'confirmed' || b.status === 'needs_attention'
                  ? `<button type="button" class="vs-link" data-cancel="${escapeHtml(b.id)}">Cancel</button>`
                  : ''}
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  host.querySelectorAll('[data-cancel]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-cancel');
      if (!window.confirm(
        'Cancel this booking and release the site?\n\n' +
        'This does not refund the vendor - do that in Stripe.')) return;

      btn.disabled = true;
      try {
        await fb.fn.httpsCallable(fb.fns, 'adminCancelBooking')({ bookingId: id });
      } catch (err) {
        showError('admin', err.message);
        btn.disabled = false;
      }
    });
  });
}

/* -------------------------------------------------------------------------
   Sites
   ------------------------------------------------------------------------- */
function renderSites() {
  const host = document.getElementById('va-sites');
  if (!host) return;

  if (!sites.length) {
    host.innerHTML = '<p class="vs-muted">No sites yet. Seed the event layout first.</p>';
    return;
  }

  host.innerHTML = `
    <div class="va-table-wrap">
      <table class="va-table">
        <thead><tr><th>Site</th><th>Type</th><th>Status</th><th>Booking</th><th></th></tr></thead>
        <tbody>
          ${sites.map((s) => `
            <tr>
              <td>${escapeHtml(s.label)}</td>
              <td>${escapeHtml(s.type)}</td>
              <td><span class="va-status is-${escapeHtml(s.status)}">${escapeHtml(s.status)}</span></td>
              <td>${escapeHtml(s.bookingId ? s.bookingId.slice(0, 6) : '-')}</td>
              <td>
                ${s.status !== 'booked' ? `
                  <button type="button" class="vs-link" data-site="${escapeHtml(s.id)}"
                          data-status="${s.status === 'blocked' ? 'available' : 'blocked'}">
                    ${s.status === 'blocked' ? 'Reopen' : 'Block'}
                  </button>` : ''}
                ${s.status === 'held' ? `
                  <button type="button" class="vs-link" data-site="${escapeHtml(s.id)}"
                          data-status="available">Free it</button>` : ''}
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  host.querySelectorAll('[data-site]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await fb.fn.httpsCallable(fb.fns, 'adminSetSiteStatus')({
          eventId,
          siteId: btn.getAttribute('data-site'),
          status: btn.getAttribute('data-status'),
        });
      } catch (err) {
        showError('admin', err.message);
        btn.disabled = false;
      }
    });
  });
}

/* -------------------------------------------------------------------------
   Categories
   ------------------------------------------------------------------------- */
function renderCategories() {
  const host = document.getElementById('va-categories');
  if (!host) return;

  if (!categories.length) {
    host.innerHTML = '<p class="vs-muted">No categories yet. Seed the event layout first.</p>';
    return;
  }

  host.innerHTML = `
    <div class="va-table-wrap">
      <table class="va-table">
        <thead><tr><th>Category</th><th>Booked</th><th>Limit</th><th></th></tr></thead>
        <tbody>
          ${categories.map((c) => `
            <tr>
              <td>${escapeHtml(c.name)}</td>
              <td>${c.count || 0}</td>
              <td>
                <input type="number" min="0" class="va-limit"
                       value="${c.limit}" data-limit="${escapeHtml(c.id)}">
              </td>
              <td>
                <span class="va-status is-${(c.count || 0) >= c.limit ? 'booked' : 'available'}">
                  ${(c.count || 0) >= c.limit ? 'FULL' : 'open'}
                </span>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  host.querySelectorAll('[data-limit]').forEach((input) => {
    input.addEventListener('change', async () => {
      const id = input.getAttribute('data-limit');
      input.disabled = true;
      try {
        await fb.fn.httpsCallable(fb.fns, 'adminSetCategoryLimit')({
          eventId,
          categoryId: id,
          limit: Number(input.value),
        });
      } catch (err) {
        showError('admin', err.message);
      } finally {
        input.disabled = false;
      }
    });
  });
}

/* -------------------------------------------------------------------------
   Seed
   ------------------------------------------------------------------------- */
async function seedEvent() {
  const busy = document.querySelector('[data-busy="admin"]');
  const out = document.getElementById('va-seed-result');

  if (busy) busy.hidden = false;
  showError('setup', '');

  try {
    const res = await fb.fn.httpsCallable(fb.fns, 'seedEvent')({ eventId });
    const d = res.data;
    out.textContent =
      `Done. ${d.eventCreated ? 'Event created. ' : 'Event already existed. '}` +
      `Added ${d.addedSites} site(s) and ${d.addedCats} category(ies).`;
  } catch (err) {
    showError('setup', err.message);
  } finally {
    if (busy) busy.hidden = true;
  }
}

/* -------------------------------------------------------------------------
   Helpers
   ------------------------------------------------------------------------- */
function showError(key, message) {
  const el = document.querySelector(`[data-error="${key}"]`);
  if (!el) return;
  el.textContent = message || '';
  el.hidden = !message;
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = String(value == null ? '' : value);
  return div.innerHTML;
}
