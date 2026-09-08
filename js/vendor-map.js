/* --------------------------------------------------------------------------
   Vendor site map

   Draws the site plan as an SVG with a viewBox, so it scales to whatever
   width it is given and stays readable on a phone without any pixel maths.

   The layout is not hard coded here. Sites arrive from Firestore and are
   drawn from their x / y / w / h, so the plan can be rearranged from the
   admin dashboard without touching this file. The small layout at the
   bottom is only used for the offline preview.
   -------------------------------------------------------------------------- */

const STATUS_ORDER = ['available', 'held', 'booked', 'blocked'];

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
    this.mapSize = { width: 1000, height: 700 };

    this.vendorType = null;   // only sites of this type are selectable
    this.selectedId = null;
    this.myUid = null;        // so my own hold does not look unavailable

    this.svg = null;
  }

  setVendorType(type) {
    this.vendorType = type;
    this.render();
  }

  setUid(uid) {
    this.myUid = uid;
  }

  setLayout({ sites, landmarks, mapSize }) {
    if (sites) this.sites = sites;
    if (landmarks) this.landmarks = landmarks;
    if (mapSize) this.mapSize = mapSize;
    this.render();
  }

  setSelected(siteId) {
    this.selectedId = siteId;
    this.render();
  }

  /* What a site looks like to *this* visitor. My own held site reads as
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

  isSelectable(site) {
    if (!this.vendorType) return false;
    if (site.type !== this.vendorType) return false;

    const status = this.statusFor(site);
    return status === 'available' || status === 'mine';
  }

  counts() {
    const out = { available: 0, held: 0, booked: 0, blocked: 0, mine: 0 };
    for (const site of this.sites) {
      if (this.vendorType && site.type !== this.vendorType) continue;
      const s = this.statusFor(site);
      out[s] = (out[s] || 0) + 1;
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
      rect.setAttribute('rx', 8);
      g.appendChild(rect);

      const label = document.createElementNS(ns, 'text');
      label.setAttribute('x', mark.x + mark.w / 2);
      label.setAttribute('y', mark.y + mark.h / 2 + 6);
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('class', 'vmap-landmark-text');
      label.textContent = mark.label;
      g.appendChild(label);

      svg.appendChild(g);
    }

    // ---- the bookable sites ---------------------------------------------
    for (const site of this.sites) {
      const status = this.statusFor(site);
      const selectable = this.isSelectable(site);
      const isSelected = site.id === this.selectedId;
      const wrongType = this.vendorType && site.type !== this.vendorType;

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

      if (selectable) {
        g.setAttribute('tabindex', '0');
        g.setAttribute('role', 'button');
        g.setAttribute(
          'aria-label',
          `Site ${site.label}, ${site.type}, ${status === 'mine' ? 'your hold' : status}`
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
      rect.setAttribute('rx', 7);
      g.appendChild(rect);

      const label = document.createElementNS(ns, 'text');
      label.setAttribute('x', site.x + site.w / 2);
      label.setAttribute('y', site.y + site.h / 2 + 2);
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('class', 'vmap-site-label');
      label.textContent = site.label;
      g.appendChild(label);

      // A short status word under the label, so the map is readable
      // without relying on colour alone.
      const sub = document.createElementNS(ns, 'text');
      sub.setAttribute('x', site.x + site.w / 2);
      sub.setAttribute('y', site.y + site.h / 2 + 20);
      sub.setAttribute('text-anchor', 'middle');
      sub.setAttribute('class', 'vmap-site-sub');
      sub.textContent = this.subLabel(site, status, wrongType);
      g.appendChild(sub);

      svg.appendChild(g);
    }

    this.host.innerHTML = '';
    this.host.appendChild(svg);
    this.svg = svg;
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
   opened and reviewed before the backend exists. The real layout lives in
   Firestore and is seeded from functions/lib/layout.js.
   -------------------------------------------------------------------------- */
export function previewLayout() {
  const sites = [];

  const run = (prefix, type, count, startX, y, w, h, gap) => {
    for (let i = 0; i < count; i++) {
      sites.push({
        id: `${prefix}${i + 1}`,
        label: `${prefix}${i + 1}`,
        type,
        x: startX + i * (w + gap),
        y, w, h,
        status: 'available',
      });
    }
  };

  run('F', 'food', 6, 90, 170, 110, 80, 26);
  run('G', 'food', 6, 90, 300, 110, 80, 26);
  run('M', 'market', 8, 70, 440, 90, 70, 18);
  run('N', 'market', 8, 70, 530, 90, 70, 18);
  run('C', 'community', 4, 70, 630, 120, 55, 24);

  // a couple of pre-set states so the legend means something in preview
  sites[2].status = 'booked';
  sites[7].status = 'blocked';

  return {
    mapSize: { width: 1000, height: 700 },
    sites,
    landmarks: [
      { id: 'stage', label: 'MAIN STAGE', kind: 'stage', x: 300, y: 30, w: 400, h: 90 },
      { id: 'bar', label: 'BAR (SoundzGood)', kind: 'bar', x: 760, y: 170, w: 170, h: 110 },
      { id: 'toilets', label: 'TOILETS', kind: 'facility', x: 760, y: 320, w: 170, h: 70 },
      { id: 'entry', label: 'ENTRY', kind: 'entry', x: 760, y: 610, w: 170, h: 70 },
      { id: 'walkway', label: 'MAIN WALKWAY', kind: 'path', x: 60, y: 262, w: 660, h: 28 },
    ],
  };
}

export function previewCategories() {
  return [
    { id: 'donuts', name: 'Donuts', limit: 1, count: 1, appliesTo: 'food' },
    { id: 'burgers', name: 'Burgers', limit: 2, count: 0, appliesTo: 'food' },
    { id: 'hot-chips', name: 'Hot Chips', limit: 1, count: 0, appliesTo: 'food' },
    { id: 'coffee', name: 'Coffee', limit: 2, count: 1, appliesTo: 'food' },
    { id: 'asian', name: 'Asian', limit: 2, count: 0, appliesTo: 'food' },
    { id: 'mexican', name: 'Mexican', limit: 1, count: 0, appliesTo: 'food' },
    { id: 'pizza', name: 'Pizza', limit: 1, count: 0, appliesTo: 'food' },
    { id: 'bbq-meats', name: 'BBQ and Meats', limit: 2, count: 0, appliesTo: 'food' },
    { id: 'seafood', name: 'Seafood', limit: 1, count: 0, appliesTo: 'food' },
    { id: 'ice-cream', name: 'Ice Cream and Desserts', limit: 2, count: 0, appliesTo: 'food' },
    { id: 'drinks-non-alc', name: 'Non-Alcoholic Drinks', limit: 2, count: 0, appliesTo: 'food' },
    { id: 'vegan', name: 'Vegan and Vegetarian', limit: 2, count: 0, appliesTo: 'food' },
    { id: 'other-food', name: 'Other Food', limit: 3, count: 0, appliesTo: 'food' },
  ];
}

export { STATUS_ORDER };
