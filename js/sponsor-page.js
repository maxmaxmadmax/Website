/* ==========================================================================
   SPONSOR PAGE  -  /sponsor?e=<eventId>[&t=<token>]   (Max, 20 Oct 2026)

   Community first, prices second: why the event matters, where the money
   goes, what a sponsor gets, then the levels and an "I'm interested" form.
   "Download the sponsor pack" prints the same page as A4 (sponsor.css).
   A personal link from the sponsorship email (&t=) fills in their details.
   Data: getSponsorInfo / sponsorInterest (functions/index.js).
   ========================================================================== */

import { SPONSOR_LEVELS, EVENT_COSTS } from './sponsor-data.js?v=670';
import { firebaseConfig, functionsRegion, isFirebaseConfigured, eventId as defaultEventId } from './firebase-config.js?v=670';

const SDK = 'https://www.gstatic.com/firebasejs/10.14.1';
const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const dollars = (c) => '$' + Math.round((c || 0) / 100).toLocaleString('en-AU');

const EVENT_POSTERS = [
  { match: (ev) => /eatz/i.test(ev.name || '') && String(ev.dateISO || '').startsWith('2026-10-31'),
    url: '/images/events/eatz-beatz-halloween-2026-v3.webp' },
];
const posterOf = (ev) => ev.image || ((EVENT_POSTERS.find((p) => p.match(ev)) || {}).url) || '';

const params = new URLSearchParams(location.search);
const EVENT_ID = params.get('e') || defaultEventId;
const TOKEN = params.get('t') || '';
let fns = null;

function levelCard(l, left) {
  const named = !l.priceCents;
  const out = !named && left <= 0;
  return `<div class="spn-level${out ? ' is-out' : ''}${l.key === 'platinum' ? ' is-top' : ''}">
    <p class="spn-level-name">${esc(l.name)}</p>
    <p class="spn-level-price">${named ? 'Name your support' : dollars(l.priceCents) + '<small> + GST</small>'}</p>
    <p class="spn-level-left">${named ? 'Cash or in-kind' : (out ? 'Taken - thank you!' : left + ' of ' + l.spots + ' available')}</p>
    <ul>${l.perks.map((p) => '<li>' + esc(p) + '</li>').join('')}</ul>
    ${out ? '' : `<button type="button" class="spn-btn" data-level="${l.key}">I&rsquo;m interested</button>`}
  </div>`;
}

function render(d) {
  const ev = d.event || {};
  const where = [ev.venue, ev.location].filter(Boolean).join(', ');
  const left = d.left || {};
  const p = d.prospect || {};
  const poster = posterOf(ev);
  document.title = 'Become a Sponsor - ' + (ev.name || 'Eatz & Beatz') + ' | SoundzGood';
  document.getElementById('spn-root').innerHTML = `
  <section class="spn-hero">
    ${poster ? `<img class="spn-poster" src="${esc(poster)}" alt="${esc(ev.name)} poster">` : ''}
    <div class="spn-hero-text">
      <p class="spn-eyebrow">Sponsorship &amp; partnerships</p>
      <h1>Partner with ${esc(ev.name || 'Eatz &amp; Beatz')}</h1>
      <p class="spn-when">${esc(ev.dateLabel || '')}${where ? ' &middot; ' + esc(where) : ''}</p>
      <p class="spn-lead">${p.business ? 'Hi ' + esc(p.contactName || p.business) + ' &mdash; ' : ''}Eatz &amp; Beatz is a <b>free community night</b> for families across Bowen and the Whitsundays: local food, markets, live music and a safe, fun night out. Keeping it free takes local businesses who believe in it.</p>
      <div class="spn-hero-btns">
        <a class="spn-btn" href="#spn-levels">See the sponsor options</a>
        <button type="button" class="spn-btn spn-btn-ghost" data-print>Download the sponsor pack (PDF)</button>
      </div>
    </div>
  </section>

  <section class="spn-sec">
    <h2>Why partner with us</h2>
    <div class="spn-why">
      <div><b>Be seen by the whole community</b><p>Your business on the posters, the event page, our socials and the stage &mdash; in front of local families on the night and in the weeks before it.</p></div>
      <div><b>Show you&rsquo;re local</b><p>People support the businesses that support their town. Your name goes on a night everyone enjoys.</p></div>
      <div><b>Keep it free for families</b><p>No entry fee means everyone can come. Sponsors are what make that possible.</p></div>
    </div>
  </section>

  <section class="spn-sec spn-costs">
    <h2>Where your support goes</h2>
    <p>Running a night like this properly costs more than most people realise. Every dollar goes back into the event:</p>
    <ul>${EVENT_COSTS.map((c) => '<li>' + esc(c) + '</li>').join('')}</ul>
  </section>

  <section class="spn-sec" id="spn-levels">
    <h2>Sponsor levels</h2>
    <p class="spn-sub">Prices are plus GST. Not sure which fits? Choose &ldquo;Supporter&rdquo; and we&rsquo;ll work it out together.</p>
    <div class="spn-levels">${SPONSOR_LEVELS.map((l) => levelCard(l, left[l.key] != null ? left[l.key] : l.spots)).join('')}</div>
  </section>

  <section class="spn-sec spn-form-sec" id="spn-form">
    <h2>I&rsquo;m interested</h2>
    <p class="spn-sub">Leave your details and we&rsquo;ll be in touch to talk it through &mdash; no commitment.</p>
    <form class="spn-form" id="spn-form-el">
      <label>Business<input name="business" required value="${esc(p.business || '')}" autocomplete="organization"></label>
      <label>Your name<input name="contactName" required value="${esc(p.contactName || '')}" autocomplete="name"></label>
      <label>Email<input name="email" type="email" required value="${esc(p.email || '')}" autocomplete="email"></label>
      <label>Phone<input name="phone" type="tel" value="${esc(p.phone || '')}" autocomplete="tel"></label>
      <label class="spn-wide">Level<select name="level">${SPONSOR_LEVELS.map((l) => `<option value="${l.key}">${esc(l.name)}${l.priceCents ? ' - ' + dollars(l.priceCents) + ' + GST' : ''}</option>`).join('')}</select></label>
      <label class="spn-wide">Anything you&rsquo;d like to tell us? <span>(optional)</span><textarea name="message" rows="3"></textarea></label>
      <button type="submit" class="spn-btn">Send &mdash; I&rsquo;m interested</button>
      <p class="spn-msg" id="spn-msg" hidden></p>
    </form>
    <p class="spn-print-only spn-contact">To get involved: info@soundzgood.com.au &middot; 0422 393 022 &middot; soundzgood.com.au/sponsor</p>
  </section>

  <section class="spn-sec spn-thanks">
    <p>Questions? Call Max on <b>0422 393 022</b> or email <b>info@soundzgood.com.au</b>. Thank you for supporting local events.</p>
  </section>`;
  wire();
}

function wire() {
  document.querySelectorAll('[data-print]').forEach((b) => b.addEventListener('click', () => window.print()));
  document.querySelectorAll('[data-level]').forEach((b) => b.addEventListener('click', () => {
    const sel = document.querySelector('#spn-form-el select[name="level"]');
    if (sel) sel.value = b.getAttribute('data-level');
    document.getElementById('spn-form').scrollIntoView({ behavior: 'smooth' });
  }));
  const form = document.getElementById('spn-form-el');
  if (form) form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('spn-msg');
    const btn = form.querySelector('button[type="submit"]');
    const v = (n) => (form.querySelector('[name="' + n + '"]') || {}).value || '';
    btn.disabled = true;
    try {
      await fns.httpsCallable(fns.fns, 'sponsorInterest')({
        eventId: EVENT_ID, token: TOKEN, business: v('business'), contactName: v('contactName'),
        email: v('email'), phone: v('phone'), level: v('level'), message: v('message'),
      });
      form.innerHTML = '<div class="spn-done"><b>Thank you!</b><p>We&rsquo;ve got your details and will be in touch soon to talk it through.</p></div>';
    } catch (err) {
      btn.disabled = false;
      msg.hidden = false;
      msg.textContent = (err && err.message) || 'Could not send. Please try again, or email info@soundzgood.com.au.';
    }
  });
}

async function load() {
  const root = document.getElementById('spn-root');
  if (!isFirebaseConfigured) { root.innerHTML = '<p class="spn-loading">This page cannot load right now.</p>'; return; }
  try {
    const [{ initializeApp }, functions] = await Promise.all([
      import(`${SDK}/firebase-app.js`), import(`${SDK}/firebase-functions.js`),
    ]);
    fns = { fns: functions.getFunctions(initializeApp(firebaseConfig), functionsRegion), httpsCallable: functions.httpsCallable };
    const res = await fns.httpsCallable(fns.fns, 'getSponsorInfo')({ eventId: EVENT_ID, token: TOKEN });
    render(res.data);
  } catch (err) {
    root.innerHTML = '<p class="spn-loading">Sorry - this page could not load. Please email info@soundzgood.com.au.</p>';
  }
}

load();
