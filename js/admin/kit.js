/* ==========================================================================
   KIT  -  the item-requirements engine

   Some gear needs other gear to work: a passive speaker needs a cable and a
   power amp; the amp needs an IEC lead and an XLR loom. This works out the
   FULL kit for a hire - following the chain - and prices the add-ons.

   Two kinds of requirement, set per item:

     per-item   n of the required item PER unit hired
                (1 speaker cable per speaker).

     shared     one required item COVERS n units, pooled across everything
                that needs it, so it is not duplicated
                (1 amp covers 6 speakers -> 2 tops + 4 subs = 1 amp, not 6).

   Compatibility is expressed by WHICH item each thing links to: a sub links
   to the sub-amp, a top to the top-amp, so an amp that only drives subs is
   simply never linked from a top.

   Charge per requirement: 'normal' (full hire price), 'discounted' (a flat
   price per unit) or 'free' ($0) - but ALL are still reserved from stock so
   nothing is double-booked.

   A required item can have its own requirements, so the kit is built to a
   fixed point: keep pulling in what the current kit needs until it settles.
   ========================================================================== */

/* the requirements of an item that point at a real inventory item */
function reqsOf(item, itemsById) {
    const reqs = item && Array.isArray(item.requirements) ? item.requirements : [];
    return reqs.filter((r) => r && r.itemId && itemsById[r.itemId]);
}

/*  Total quantity of every item in the kit (what the customer hired, plus
    everything that pulls in), resolved to a fixed point. Shared items are
    pooled and rounded up; the loop settles once nothing new appears.      */
function resolveTotals(base, itemsById) {
    let total = { ...base };

    for (let iter = 0; iter < 50; iter++) {
        const perItem = {}; // id -> qty needed from per-item rules
        const pool = {}; // id -> { load, coversN, qtyPer }

        Object.keys(total).forEach((x) => {
            const qx = total[x];
            if (!qx) return;
            reqsOf(itemsById[x], itemsById).forEach((r) => {
                if (r.rule === 'shared') {
                    const coversN = Math.max(1, Math.round(r.coversN || 1));
                    const qtyPer = Math.max(1, Math.round(r.qty || 1));
                    const p = pool[r.itemId] || (pool[r.itemId] = { load: 0, coversN, qtyPer });
                    p.load += qx;
                    p.coversN = Math.min(p.coversN, coversN); // most conservative if mixed
                } else {
                    perItem[r.itemId] = (perItem[r.itemId] || 0) + qx * Math.max(0, Math.round(r.qty || 0));
                }
            });
        });

        const next = { ...base };
        Object.keys(perItem).forEach((id) => {
            next[id] = (next[id] || 0) + perItem[id];
        });
        Object.keys(pool).forEach((id) => {
            const p = pool[id];
            next[id] = (next[id] || 0) + Math.ceil(p.load / p.coversN) * p.qtyPer;
        });

        const keys = new Set([...Object.keys(total), ...Object.keys(next)]);
        const settled = [...keys].every((k) => (total[k] || 0) === (next[k] || 0));
        total = next;
        if (settled) break;
    }

    return total; // includes the base quantities
}

function unitPriceFor(reqLike, item) {
    if (reqLike.charge === 'free') return 0;
    if (reqLike.charge === 'discounted') return Math.max(0, Math.round(reqLike.discountCents || 0));
    return Math.max(0, Math.round((item && item.priceCents) || 0));
}

/* how many we have: available, else total, else no limit */
function stockOf(item) {
    if (item && item.quantityAvailable != null) return item.quantityAvailable;
    if (item && item.quantityTotal != null) return item.quantityTotal;
    return Infinity;
}

/*  Build the priced kit for a cart.

    cart       { itemId: qty } the customer hired directly
    itemsById  { id: item }    every inventory item, with .requirements,
                               .priceCents, .quantityAvailable, .name

    Returns:
      base        [{ itemId, name, qty, unitCents, lineCents }]  the hired items
      required    [{ itemId, name, qty, charge, discountCents, unitCents, lineCents }]
      totals      { itemId: qty }  everything reserved (base + required)
      addCents    total price of the REQUIRED add-ons (base priced elsewhere)
      shortages   [{ itemId, name, needed, available }]  where stock is short
   */
function expandKit(cart, itemsById) {
    const base = {};
    Object.keys(cart || {}).forEach((id) => {
        const q = Math.max(0, Math.round(cart[id] || 0));
        if (q && itemsById[id]) base[id] = q;
    });

    const totals = resolveTotals(base, itemsById);

    // Everything inside a system (its parts and the gear they bring) is
    // covered by the system's own price, so it is free.
    const inSys = new Set();
    const walk = (id) => {
        reqsOf(itemsById[id], itemsById).forEach((r) => {
            if (inSys.has(r.itemId)) return;
            inSys.add(r.itemId);
            walk(r.itemId);
        });
    };
    Object.keys(base).forEach((id) => {
        if (itemsById[id].isSystem) walk(id);
    });
    const sysFree = (x) => inSys.has(x) || !!(itemsById[x] && itemsById[x].isSystem);

    // Attribute the required quantities to their charge, from the settled kit.
    const agg = {}; // key -> { itemId, charge, discountCents, qty }
    const add = (itemId, charge, discountCents, qty) => {
        if (!qty) return;
        const key = itemId + '|' + charge + '|' + (charge === 'discounted' ? discountCents || 0 : 0);
        const a = agg[key] || (agg[key] = { itemId, charge, discountCents: discountCents || 0, qty: 0 });
        a.qty += qty;
    };

    // per-item add-ons now; shared ones pooled from the settled totals
    const pool = {};
    Object.keys(totals).forEach((x) => {
        const qx = totals[x];
        reqsOf(itemsById[x], itemsById).forEach((r) => {
            if (r.rule !== 'shared') {
                add(r.itemId, sysFree(x) ? 'free' : r.charge || 'normal', r.discountCents, qx * Math.max(0, Math.round(r.qty || 0)));
                return;
            }
            const coversN = Math.max(1, Math.round(r.coversN || 1));
            const p =
                pool[r.itemId] ||
                (pool[r.itemId] = {
                    load: 0,
                    coversN,
                    qtyPer: Math.max(1, Math.round(r.qty || 1)),
                    charge: r.charge || 'normal',
                    discountCents: r.discountCents || 0
                });
            p.load += qx;
            if (sysFree(x)) p.charge = 'free';
            p.coversN = Math.min(p.coversN, coversN);
        });
    });
    Object.keys(pool).forEach((id) => {
        const p = pool[id];
        add(id, p.charge, p.discountCents, Math.ceil(p.load / p.coversN) * p.qtyPer);
    });

    const nameOf = (id) => (itemsById[id] && itemsById[id].name) || id;

    const baseLines = Object.keys(base).map((id) => {
        const unit = unitPriceFor({}, itemsById[id]);
        return { itemId: id, name: nameOf(id), qty: base[id], unitCents: unit, lineCents: unit * base[id] };
    });

    const required = Object.values(agg)
        .map((a) => {
            const unit = unitPriceFor(a, itemsById[a.itemId]);
            return {
                itemId: a.itemId,
                name: nameOf(a.itemId),
                qty: a.qty,
                charge: a.charge,
                discountCents: a.discountCents,
                unitCents: unit,
                lineCents: unit * a.qty
            };
        })
        .sort((x, y) => x.name.localeCompare(y.name));

    const addCents = required.reduce((s, r) => s + r.lineCents, 0);

    const shortages = [];
    Object.keys(totals).forEach((id) => {
        const avail = stockOf(itemsById[id]);
        if (totals[id] > avail) shortages.push({ itemId: id, name: nameOf(id), needed: totals[id], available: avail });
    });

    return { base: baseLines, required, totals, addCents, shortages };
}

export { expandKit, resolveTotals };
