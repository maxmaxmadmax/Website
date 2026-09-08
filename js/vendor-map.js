/* --------------------------------------------------------------------------
   Vendor site map

   Draws the site plan as an SVG with a viewBox, so it scales to whatever
   width it is given and stays readable on a phone without any pixel maths.

   The layout is not hard coded here. Sites arrive from Firestore and are
   drawn from their x / y / w / h, so the plan can be rearranged from the
   admin dashboard without touching this file. The layout at the bottom is
   only used for the offline preview.

   A 3x6 market stall is two adjoining bays, so selecting one bay shows and
   takes the one below it as well. The server does the same thing inside a
   transaction - this is only the on-screen half.
   -------------------------------------------------------------------------- */

export class VendorMap {
  /**
   * @param {HTMLElement} host       element to draw into
   * @param {object}      options
   * @param {function}    options.onSelect  called with a site when chosen
   */
  constructor(host, options = {}) {
    this.host = host;
    this.onSelect = options.onSelect || function () {};

    this.sites = [];
    this.landmarks = [];
    this.mapSize = { width: 760, height: 1420 };

    this.vendorType = null;   // food | market | community
    this.stallSize = null;    // market only: 3x3 or 3x6
    this.selectedIds = [];    // one bay, or two for a 3x6
    this.myUid = null;        // so my own hold does not look unavailable

    this.byId = new Map();
  }

  /* Community groups have no sites of their own on the plan - they take a
     market bay like anyone else, they are simply not charged for it. */
  siteTypeWanted() {
    if (!this.vendorType) return null;
    return this.vendorType === 'food' ? 'food' : 'market';
  }

  baysNeeded() {
    return this.vendorType === 'market' && this.stallSize === '3x6' ? 2 : 1;
  }

  setVendorType(type, stallSize) {
    this.vendorType = type;
    this.stallSize = stallSize || null;
    this.render();
  }

  setUid(uid) {
    this.myUid = uid;
  }

  setLayout({ sites, landmarks, mapSize }) {
    if (sites) {
      this.sites = sites;
      this.byId = new Map(sites.map((s) => [s.id, s]));
    }
    if (landmarks) this.landmarks = landmarks;
    if (mapSize) this.mapSize = mapSize;
    this.render();
  }

  /* Accepts one id or a list, so a 3x6 lights up both bays. */
  setSelected(ids) {
    this.selectedIds = !ids ? [] : (Array.isArray(ids) ? ids : [ids]);
    this.render();
  }

  /* What a site looks like to *this* visitor. My own held bay reads as
     mine, not as unavailable. */
  statusFor(site) {
    if (site.status === 'held') {
      if (this.myUid && site.heldBy === this.myUid) return 'mine';

      // A hold whose clock ran out is really available again; the scheduled
      // function will tidy the record shortly.
      const expiry = site.holdExpiresAt;
      const ms = expiry && expiry.toMillis ? expiry.toMillis()
        : (typeof expiry === 'number' ? expiry : null);
      if (ms !== null && ms <= Date.now()) return 'available';

      return 'held';
    }
    return site.status || 'available';
  }

  isFree(site) {
    if (!site) return false;
    const s = this.statusFor(site);
    return s === 'available' || s === 'mine';
  }

  matchesVendor(site) {
    const wanted = this.siteTypeWanted();
    if (!wanted) return false;
    return site.type === wanted;
  }

  /* The bays this site would take if chosen. Two for a 3x6, one otherwise. */
  baysFor(site) {
    if (this.baysNeeded() === 1) return [site];
    if (!site.neighbourId) return null;          // last bay in the row
    const partner = this.byId.get(site.neighbourId);
    return partner ? [site, partner] : null;
  }

  isSelectable(site) {
    if (!this.matchesVendor(site)) return false;

    const bays = this.baysFor(site);
    if (!bays) return false;                     // no partner for a 3x6

    return bays.every((b) => this.isFree(b));
  }

  counts() {
    const out = { available: 0, held: 0, booked: 0, blocked: 0, mine: 0 };
    for (const site of this.sites) {
      if (!this.matchesVendor(site)) continue;
      const s = this.statusFor(site);
      out[s] = (out[s] || 0) + 1;
    }
    // For a 3x6 what matters is how many pairs are left, not bays.
    if (this.baysNeeded() === 2) {
      out.pairs = this.sites.filter((s) => this.isSelectable(s)).length;
    }
    return out;
  }

  render() {
    if (!this.host) return;

    const { width, height } = this.mapSize;
    const ns = 'http://www.w3.org/2000/svg';

    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('class', 'vmap-svg');
    svg.setAttribute('role', 'group');
    svg.setAttribute('aria-label', 'Vendor site map');

    // ---- fixed furniture, drawn first so sites sit on top ----------------
    for (const mark of this.landmarks) {
      const g = document.createElementNS(ns, 'g');
      g.setAttribute('class', `vmap-landmark vmap-landmark-${mark.kind || 'other'}`);

      const rect = document.createElementNS(ns, 'rect');
      rect.setAttribute('x', mark.x);
      rect.setAttribute('y', mark.y);
      rect.setAttribute('width', mark.w);
      rect.setAttribute('height', mark.h);
      rect.setAttribute('rx', mark.kind === 'barrier' ? 2 : 8);
      g.appendChild(rect);

      if (mark.label) {
        const label = document.createElementNS(ns, 'text');
        label.setAttribute('x', mark.x + mark.w / 2);
        label.setAttribute('y', mark.y + mark.h / 2 + 6);
        label.setAttribute('text-anchor', 'middle');
        label.setAttribute('class', 'vmap-landmark-text');
        label.textContent = mark.label;
        g.appendChild(label);
      }

      svg.appendChild(g);
    }

    // ---- the bookable sites ---------------------------------------------
    for (const site of this.sites) {
      const status = this.statusFor(site);
      const selectable = this.isSelectable(site);
      const isSelected = this.selectedIds.includes(site.id);
      const wrongType = this.vendorType && !this.matchesVendor(site);

      const g = document.createElementNS(ns, 'g');
      g.setAttribute(
        'class',
        [
          'vmap-site',
          `is-${status}`,
          `type-${site.type}`,
          selectable ? 'is-selectable' : 'is-locked',
          isSelected ? 'is-selected' : '',
          wrongType ? 'is-wrong-type' : '',
        ].filter(Boolean).join(' ')
      );

      // The two vans at the bottom of the food run sit on an angle.
      if (site.rotate) {
        const cx = site.x + site.w / 2;
        const cy = site.y + site.h / 2;
        g.setAttribute('transform', `rotate(${site.rotate} ${cx} ${cy})`);
      }

      if (selectable) {
        g.setAttribute('tabindex', '0');
        g.setAttribute('role', 'button');

        const bays = this.baysFor(site) || [site];
        const names = bays.map((b) => b.label).join(' and ');
        g.setAttribute(
          'aria-label',
          `Site ${names}, ${site.type}, ${status === 'mine' ? 'your hold' : status}`
        );

        const choose = (ev) => {
          ev.preventDefault();
          this.onSelect(site);
        };
        g.addEventListener('click', choose);
        g.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') choose(ev);
        });
      } else {
        g.setAttribute('aria-hidden', 'true');
      }

      const rect = document.createElementNS(ns, 'rect');
      rect.setAttribute('x', site.x);
      rect.setAttribute('y', site.y);
      rect.setAttribute('width', site.w);
      rect.setAttribute('height', site.h);
      rect.setAttribute('rx', 6);
      g.appendChild(rect);

      const label = document.createElementNS(ns, 'text');
      label.setAttribute('x', site.x + site.w / 2);
      label.setAttribute('y', site.y + site.h / 2 + (site.h > 70 ? 0 : 3));
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('class', 'vmap-site-label');
      label.textContent = site.label;
      g.appendChild(label);

      // A short word under the label, so the map is readable without
      // relying on colour alone. Small bays have no room for it.
      if (site.h > 60) {
        const sub = document.createElementNS(ns, 'text');
        sub.setAttribute('x', site.x + site.w / 2);
        sub.setAttribute('y', site.y + site.h / 2 + 18);
        sub.setAttribute('text-anchor', 'middle');
        sub.setAttribute('class', 'vmap-site-sub');
        sub.textContent = this.subLabel(site, status, wrongType);
        g.appendChild(sub);
      }

      svg.appendChild(g);
    }

    this.host.innerHTML = '';
    this.host.appendChild(svg);
  }

  subLabel(site, status, wrongType) {
    if (wrongType) return site.type;
    if (status === 'mine') return 'YOURS';
    if (status === 'available') return 'FREE';
    if (status === 'held') return 'ON HOLD';
    if (status === 'booked') return 'TAKEN';
    if (status === 'blocked') return 'CLOSED';
    return '';
  }
}

/* --------------------------------------------------------------------------
   Offline preview layout

   Only used when Firebase has not been configured yet, so the page can be
   opened and reviewed before the backend exists. Mirrors the seed in
   functions/lib/layout.js - the real layout lives in Firestore.
   -------------------------------------------------------------------------- */
export function previewLayout() {
  const sites = [];

  const ids = (prefix, from, to) => {
    const out = [];
    for (let i = from; i <= to; i++) out.push(`${prefix}${i}`);
    return out;
  };

  const column = (list, type, x, y, w, h, gap) =>
    list.map((id, i) => ({
      id, label: id, type,
      x, y: y + i * (h + gap), w, h,
      status: 'available',
    }));

  // Ten food vans: four each side, two on the angle
  sites.push(...column(ids('F', 1, 4), 'food', 118, 132, 74, 92, 22));
  sites.push(...column(ids('F', 5, 8), 'food', 568, 132, 74, 92, 22));
  sites.push(
    { id: 'F9', label: 'F9', type: 'food', x: 96, y: 592, w: 74, h: 92, rotate: -38, status: 'available' },
    { id: 'F10', label: 'F10', type: 'food', x: 590, y: 592, w: 74, h: 92, rotate: 38, status: 'available' }
  );

  // Forty market bays in four columns of ten
  const cols = [
    { list: ids('M', 1, 10), x: 68 },
    { list: ids('M', 11, 20), x: 272 },
    { list: ids('M', 21, 30), x: 372 },
    { list: ids('M', 31, 40), x: 576 },
  ];

  for (const col of cols) {
    const built = column(col.list, 'market', col.x, 726, 84, 56, 12);
    built.forEach((s, i) => {
      s.neighbourId = i < built.length - 1 ? built[i + 1].id : null;
    });
    sites.push(...built);
  }

  // a few pre-set states so the legend means something in preview
  const setStatus = (id, status) => {
    const s = sites.find((x) => x.id === id);
    if (s) s.status = status;
  };
  setStatus('F3', 'booked');
  setStatus('M5', 'booked');
  setStatus('M14', 'blocked');
  setStatus('M23', 'booked');

  return {
    mapSize: { width: 760, height: 1420 },
    sites,
    landmarks: [
      { id: 'stage', label: 'STAGE', kind: 'stage', x: 296, y: 24, w: 168, h: 74 },
      { id: 'front-barrier', label: '', kind: 'barrier', x: 150, y: 112, w: 460, h: 8 },
      { id: 'bar', label: 'BAR', kind: 'bar', x: 306, y: 566, w: 148, h: 104 },
      { id: 'walkway', label: 'WALKWAY', kind: 'path', x: 368, y: 130, w: 24, h: 420 },
      { id: 'barrier-left', label: '', kind: 'barrier', x: 40, y: 660, w: 8, h: 300 },
      { id: 'barrier-right', label: '', kind: 'barrier', x: 712, y: 660, w: 8, h: 300 },
      { id: 'entry', label: 'ENTRY', kind: 'entry', x: 296, y: 1360, w: 168, h: 46 },
    ],
  };
}

/* Mirrors functions/lib/layout.js so the preview shows the real list. */
export function previewCategories() {
  const food = [
    ['burgers-fries-american', 'Burgers / Loaded Fries / American'],
    ['pizza-italian', 'Pizza / Italian'],
    ['mexican-tacos', 'Mexican / Tacos / Nachos'],
    ['asian-noodles', 'Asian / Noodles / Dumplings'],
    ['indian-curry', 'Indian / Curry'],
    ['bbq-smoked-meats', 'BBQ / Smoked Meats'],
    ['seafood', 'Seafood'],
    ['chicken-wings', 'Chicken / Wings'],
    ['hot-dogs-sausages', 'Hot Dogs / Sausages'],
    ['donuts-churros', 'Donuts / Churros'],
    ['ice-cream-gelato', 'Ice Cream / Gelato / Frozen Desserts'],
    ['cakes-baked-sweets', 'Cakes / Cupcakes / Baked Sweets'],
    ['lollies-fairy-floss', 'Lollies / Fairy Floss / Sweet Treats'],
    ['coffee', 'Coffee'],
    ['drinks-juice-smoothies', 'Non-Alcoholic Drinks / Juice / Smoothies'],
    ['healthy-salads-acai', 'Healthy / Salads / Acai'],
    ['vegetarian-vegan', 'Vegetarian / Vegan Specialty'],
    ['other-food', 'Other Food'],
  ];

  const market = [
    ['clothing-fashion', 'Clothing / Fashion'],
    ['jewellery', 'Jewellery'],
    ['candles-home-fragrance', 'Candles / Home Fragrance'],
    ['arts-prints-photography', 'Arts / Prints / Photography'],
    ['handmade-crafts', 'Handmade Crafts'],
    ['homewares-decor', 'Homewares / Decor'],
    ['beauty-skincare', 'Beauty / Skincare'],
    ['plants-garden', 'Plants / Garden'],
    ['toys-kids-products', 'Toys / Kids Products'],
    ['pet-products', 'Pet Products'],
    ['local-produce-packaged', 'Local Produce / Packaged Food'],
    ['gifts-novelty', 'Gifts / Novelty Products'],
    ['spiritual-crystals', 'Spiritual / Crystals'],
    ['services-promotional', 'Services / Promotional Stall'],
    ['community-charity-club', 'Community / Charity / Club'],
    ['other-market', 'Other Market Stall'],
  ];

  const build = (rows, appliesTo, limit, otherLimit) =>
    rows.map(([id, name]) => ({
      id, name, appliesTo, count: 0,
      limit: id.startsWith('other-') ? otherLimit : limit,
    }));

  const all = [...build(food, 'food', 2, 4), ...build(market, 'market', 6, 10)];

  // one of each full in preview, so the FULL state is visible
  all.find((c) => c.id === 'coffee').count = 2;
  all.find((c) => c.id === 'jewellery').count = 6;

  return all;
}
