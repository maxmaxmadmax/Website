/* ==========================================================================
   KIT  -  the item-requirements engine (server copy of js/kit.js)

   Kept in step with js/kit.js. CommonJS so Cloud Functions can require it.
   See js/kit.js for the full commentary.
   ========================================================================== */

function reqsOf(item) {
  return item && Array.isArray(item.requirements) ? item.requirements : [];
}

function resolveTotals(base, itemsById) {
  let total = { ...base };

  for (let iter = 0; iter < 50; iter++) {
    const perItem = {};
    const pool = {};

    Object.keys(total).forEach((x) => {
      const qx = total[x];
      if (!qx || !itemsById[x]) return;
      reqsOf(itemsById[x]).forEach((r) => {
        if (!r || !r.itemId || !itemsById[r.itemId]) return;
        if (r.rule === 'shared') {
          const coversN = Math.max(1, Math.round(r.coversN || 1));
          const qtyPer = Math.max(1, Math.round(r.qty || 1));
          const p = pool[r.itemId] || (pool[r.itemId] = { load: 0, coversN, qtyPer });
          p.load += qx;
          p.coversN = Math.min(p.coversN, coversN);
        } else {
          perItem[r.itemId] = (perItem[r.itemId] || 0) + qx * Math.max(0, Math.round(r.qty || 0));
        }
      });
    });

    const next = { ...base };
    Object.keys(perItem).forEach((id) => { next[id] = (next[id] || 0) + perItem[id]; });
    Object.keys(pool).forEach((id) => {
      const p = pool[id];
      next[id] = (next[id] || 0) + Math.ceil(p.load / p.coversN) * p.qtyPer;
    });

    const keys = new Set([...Object.keys(total), ...Object.keys(next)]);
    let settled = true;
    keys.forEach((k) => { if ((total[k] || 0) !== (next[k] || 0)) settled = false; });
    total = next;
    if (settled) break;
  }

  return total;
}

function unitPriceFor(reqLike, item) {
  if (reqLike.charge === 'free') return 0;
  if (reqLike.charge === 'discounted') return Math.max(0, Math.round(reqLike.discountCents || 0));
  return Math.max(0, Math.round((item && item.priceCents) || 0));
}

function expandKit(cart, itemsById) {
  const base = {};
  Object.keys(cart || {}).forEach((id) => {
    const q = Math.max(0, Math.round((cart[id] || 0)));
    if (q && itemsById[id]) base[id] = q;
  });

  const totals = resolveTotals(base, itemsById);

  const agg = {};
  const add = (itemId, charge, discountCents, qty) => {
    if (!qty) return;
    const key = itemId + '|' + charge + '|' + (charge === 'discounted' ? (discountCents || 0) : 0);
    const a = agg[key] || (agg[key] = { itemId, charge, discountCents: discountCents || 0, qty: 0 });
    a.qty += qty;
  };

  Object.keys(totals).forEach((x) => {
    const qx = totals[x];
    reqsOf(itemsById[x]).forEach((r) => {
      if (!r || !r.itemId || !itemsById[r.itemId] || r.rule === 'shared') return;
      add(r.itemId, r.charge || 'normal', r.discountCents, qx * Math.max(0, Math.round(r.qty || 0)));
    });
  });

  const pool = {};
  Object.keys(totals).forEach((x) => {
    reqsOf(itemsById[x]).forEach((r) => {
      if (!r || r.rule !== 'shared' || !r.itemId || !itemsById[r.itemId]) return;
      const coversN = Math.max(1, Math.round(r.coversN || 1));
      const p = pool[r.itemId] || (pool[r.itemId] = {
        load: 0, coversN, qtyPer: Math.max(1, Math.round(r.qty || 1)),
        charge: r.charge || 'normal', discountCents: r.discountCents || 0,
      });
      p.load += totals[x];
      p.coversN = Math.min(p.coversN, coversN);
    });
  });
  Object.keys(pool).forEach((id) => {
    const p = pool[id];
    add(id, p.charge, p.discountCents, Math.ceil(p.load / p.coversN) * p.qtyPer);
  });

  const nameOf = (id) => (itemsById[id] && itemsById[id].name) || id;

  const baseLines = Object.keys(base).map((id) => {
    const it = itemsById[id];
    const unit = Math.max(0, Math.round((it && it.priceCents) || 0));
    return { itemId: id, name: nameOf(id), qty: base[id], unitCents: unit, lineCents: unit * base[id] };
  });

  const required = Object.keys(agg).map((k) => {
    const a = agg[k];
    const unit = unitPriceFor(a, itemsById[a.itemId]);
    return {
      itemId: a.itemId, name: nameOf(a.itemId), qty: a.qty,
      charge: a.charge, discountCents: a.discountCents,
      unitCents: unit, lineCents: unit * a.qty,
    };
  }).sort((x, y) => x.name.localeCompare(y.name));

  const addCents = required.reduce((s, r) => s + r.lineCents, 0);

  const shortages = [];
  Object.keys(totals).forEach((id) => {
    const it = itemsById[id];
    const avail = it && it.quantityAvailable != null
      ? it.quantityAvailable
      : (it && it.quantityTotal != null ? it.quantityTotal : Infinity);
    if (totals[id] > avail) {
      shortages.push({ itemId: id, name: nameOf(id), needed: totals[id], available: avail });
    }
  });

  return { base: baseLines, required, totals, addCents, shortages };
}

module.exports = { expandKit, resolveTotals };
