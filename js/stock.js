/* ==========================================================================
   STOCK  -  what's out on hire, what's left (Max, 16 Oct 2026)

   Works off the jobs (quotes / invoices) and their hire dates:
     BOOKED     = deposit in, or paid      -> counts against stock
     PENCILLED  = quote approved / sent / accepted / invoiced, no deposit yet
                  -> shown, but does NOT block stock
   Archived / declined / estimates are ignored.

   Pure functions - no Firebase - used by the admin Inventory view, the
   quote builder's "only 2 left" warnings, and the pick list.
   KEEP IN STEP with pickItems() in functions/index.js.
   ========================================================================== */

/* deposit in (card or marked received) or paid in full */
export function isBooked(q) {
  if (!q || q.status === 'cancelled' || q.status === 'declined') return false;
  return q.status === 'paid' || q.paymentStatus === 'deposit' || q.paymentStatus === 'paid'
    || !!q.jobConfirmedAt;   // confirmed by Max, paying later (Max, 24 Oct 2026)
}

/* on its way but no money yet */
export function isPencilled(q) {
  if (!q || isBooked(q)) return false;
  return ['approved', 'sent', 'accepted', 'invoiced'].includes(q.status);
}

/* the job's hire dates as [first, last] 'yyyy-mm-dd', or null if not set */
export function jobRange(q) {
  const h = (q && q.hire) || {};
  const ok = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
  if (!ok(h.startDate)) return null;
  const end = ok(h.endDate) && h.endDate >= h.startDate ? h.endDate : h.startDate;
  return [h.startDate, end];
}

/* do two date ranges share at least one day? (strings compare fine) */
export function overlaps(a, b) {
  return !!(a && b) && a[0] <= b[1] && b[0] <= a[1];
}

/* the gear on a job, one entry per inventory item: items + included kit,
   added together (an XLR in two kits = one line). No prices.
   -> [{ itemId, name, qty }] in the order they first appear              */
export function pickItems(lines) {
  const out = [];
  const byKey = {};
  (lines || []).forEach((l) => {
    if (!l || !['item', 'kit', 'custom'].includes(l.type)) return;
    if (l.resType || l.noPick) return;   // crew & vehicles (and pub DJ lines) are not gear
    const qty = Math.max(0, Math.round(Number(l.qty) || 0));
    if (!qty) return;
    const name = String(l.name || '').replace(/ \(included\)$/i, '').trim();
    const key = l.itemId ? 'i:' + l.itemId : 'n:' + name.toLowerCase();
    if (!byKey[key]) { byKey[key] = { itemId: l.itemId || '', name, qty: 0 }; out.push(byKey[key]); }
    byKey[key].qty += qty;
  });
  return out;
}

/* how much of each item is out over [from, to]:
   { itemId: { booked, pencilled, jobs: [{ id, label, qty, booked, range }] } }
   excludeId leaves one job out (the quote you're editing).               */
export function stockUsage(jobs, from, to, excludeId) {
  const want = [from, to || from];
  const use = {};
  (jobs || []).forEach((q) => {
    if (!q || q.id === excludeId) return;
    const booked = isBooked(q);
    if (!booked && !isPencilled(q)) return;
    const r = jobRange(q);
    if (!overlaps(r, want)) return;
    const c = q.customer || {};
    const label = (c.name || c.business || q.number || 'Job') + (c.eventName ? ' - ' + c.eventName : '');
    pickItems(q.lines).forEach((p) => {
      if (!p.itemId) return;
      const u = use[p.itemId] || (use[p.itemId] = { booked: 0, pencilled: 0, jobs: [] });
      if (booked) u.booked += p.qty; else u.pencilled += p.qty;
      u.jobs.push({ id: q.id, label, qty: p.qty, booked, range: r });
    });
  });
  return use;
}

/* the tick key the pick list saves under - KEEP IN STEP with pickKey() in
   functions/index.js, or admin's "x of y packed" won't match the crew's ticks */
export function pickKey(p) {
  return (p.itemId ? 'i_' + p.itemId : 'n_' + String(p.name || '').toLowerCase()).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
}

/* { lines, packed, returned } for a job's pick list */
/*  Since 20 Oct 2026 the pick list is laid out like the quote and saves a
    tick per LINE (key = itemKey + '_L' + line index - KEEP IN STEP with the
    rows in getPickList, functions/index.js). Ticks saved before that are per
    item, so a line falls back to its item's tick.                        */
export function pickLineProgress(q) {
  const t = (q && q.pickTicks) || {};
  let lines = 0, packed = 0, returned = 0;
  ((q && q.lines) || []).forEach((l, idx) => {
    if (!l || !['item', 'kit', 'custom'].includes(l.type) || l.resType || l.noPick) return;
    if (!Math.max(0, Math.round(Number(l.qty) || 0))) return;
    const name = String(l.name || '').replace(/ \(included\)$/i, '').trim();
    const itemKey = pickKey({ itemId: l.itemId || '', name });
    const k = t[itemKey.slice(0, 110) + '_L' + idx] || t[itemKey] || {};
    lines++;
    if (k.packed) packed++;
    if (k.returned) returned++;
  });
  return { lines, packed, returned };
}
export function pickProgress(q) { return pickLineProgress(q); }
