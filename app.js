import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });

const IMG = 'https://image.tmdb.org/t/p/';
// Only movies included in these French subscriptions: Netflix, Prime Video, Canal+
const PROVIDER_IDS = [8, 119, 381];
const PROVIDER_NAMES = { 8: 'Netflix', 119: 'Prime Video', 381: 'Canal+' };
const DEFAULT_FILTERS = { providers: [], genres: [], sort: 'popularity', minRating: 0, yearFrom: 0 };

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// localStorage can throw (private mode, blocked storage): never let it break the app
const store = {
  get(k, d) { try { const v = localStorage.getItem('sf:' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('sf:' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('sf:' + k); } catch {} },
};

const uuid = () => crypto.randomUUID?.() ??
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });

let memberId = store.get('member');
if (!memberId) { memberId = uuid(); store.set('member', memberId); }

const S = {
  code: null, me: '', partner: null, partnerOnline: false,
  filters: { ...DEFAULT_FILTERS },
  swiped: new Set(), liked: new Set(), partnerLikes: [], pendingPartner: [],
  deck: [], seen: new Set(), page: 0, cleanPage: 0, exhausted: false, loading: false, loadError: false, deckGen: 0,
  last: null, matches: [], matchFilter: 'towatch',
  genres: new Map(), providers: [], channel: null, sheetId: null,
};

/* ---------- Backend ---------- */

async function rpc(fn, args = {}) {
  const { data, error } = await sb.rpc(fn, { p_code: S.code, p_member: memberId, ...args });
  if (error) throw error;
  return data;
}

const tmdbCache = new Map();
function tmdb(path, params = {}) {
  const key = path + JSON.stringify(params);
  if (!tmdbCache.has(key)) {
    const p = sb.functions.invoke('tmdb', { body: { path, params } }).then(({ data, error }) => {
      if (error) throw error;
      return data;
    });
    p.catch(() => tmdbCache.delete(key));
    tmdbCache.set(key, p);
  }
  return tmdbCache.get(key);
}

function broadcast(event, payload) {
  S.channel?.send({ type: 'broadcast', event, payload: { ...payload, from: memberId } });
}

function connectChannel() {
  if (S.channel) sb.removeChannel(S.channel);
  const ch = sb.channel(`room-${S.code}`, { config: { broadcast: { self: false }, presence: { key: memberId } } });
  ch.on('broadcast', { event: 'like' }, ({ payload }) => onPartnerLike(payload.movie))
    .on('broadcast', { event: 'match' }, ({ payload }) => {
      if (!hasMatch(payload.movie.id)) { addMatch(payload.movie); showMatch(payload.movie); }
    })
    .on('broadcast', { event: 'filters' }, ({ payload }) => {
      if (filtersKey(payload.filters) === filtersKey(S.filters)) return;
      S.filters = normFilters(payload.filters);
      renderFilters();
      resetDeck();
      toast(`${S.partner || 'Ta moitié'} a modifié les filtres`);
    })
    .on('presence', { event: 'sync' }, () => {
      const others = Object.keys(ch.presenceState()).filter((k) => k !== memberId);
      S.partnerOnline = others.length > 0;
      if (S.partnerOnline && !S.partner) refreshState();
      renderPartner();
    })
    .subscribe((status) => { if (status === 'SUBSCRIBED') ch.track({ name: S.me }); });
  S.channel = ch;
}

async function refreshState() {
  try { applyState(await rpc('get_state'), false); } catch (e) { console.warn(e); }
}

function applyState(st, initial) {
  S.code = st.code;
  S.me = st.me;
  S.partner = st.partner;
  if (initial) S.swiped = new Set(st.swiped);
  else st.swiped.forEach((id) => S.swiped.add(id));
  S.matches = st.matches || [];

  if (initial) S.partnerLikes = st.partner_likes || [];
  else (st.partner_likes || []).forEach((m) => onPartnerLike(m));

  const f = normFilters(st.filters);
  if (initial) S.filters = f;
  else if (filtersKey(f) !== filtersKey(S.filters)) { S.filters = f; renderFilters(); resetDeck(); }

  renderPartner();
  renderMatches();
}

/* ---------- Filters & deck ---------- */

const normFilters = (f) => {
  const n = { ...DEFAULT_FILTERS, ...(f || {}) };
  n.providers = n.providers.filter((id) => PROVIDER_IDS.includes(id));
  return n;
};
const filtersKey = (f) => {
  const n = normFilters(f);
  return JSON.stringify({ ...n, genres: [...n.genres].sort(), providers: [...n.providers].sort() });
};
const pageKey = () => `page:${S.code}:${filtersKey(S.filters)}`;

function discoverParams(f, page) {
  const p = { page, include_adult: false, watch_region: 'FR', sort_by: 'popularity.desc', 'vote_count.gte': 100 };
  if (f.sort === 'rating') { p.sort_by = 'vote_average.desc'; p['vote_count.gte'] = 1000; }
  if (f.sort === 'recent') {
    p.sort_by = 'primary_release_date.desc';
    p['vote_count.gte'] = 30;
    p['primary_release_date.lte'] = new Date().toISOString().slice(0, 10);
  }
  if (f.genres.length) p.with_genres = f.genres.join('|');
  // No platform selected means all three; always subscription-only, never rent or buy
  p.with_watch_providers = (f.providers.length ? f.providers : PROVIDER_IDS).join('|');
  p.with_watch_monetization_types = 'flatrate';
  if (f.minRating) p['vote_average.gte'] = f.minRating;
  if (f.yearFrom) p['primary_release_date.gte'] = `${f.yearFrom}-01-01`;
  return p;
}

// Partner likes come from the database, so re-check them against the current filters
function fitsFilters(m, f) {
  if (f.genres.length && !(m.genre_ids || []).some((g) => f.genres.includes(g))) return false;
  if (f.minRating && (m.vote_average || 0) < f.minRating) return false;
  if (f.yearFrom && (parseInt(m.release_date, 10) || 0) < f.yearFrom) return false;
  return true;
}

const slim = (m) => ({
  id: m.id, title: m.title, poster_path: m.poster_path, backdrop_path: m.backdrop_path,
  release_date: m.release_date, vote_average: m.vote_average, overview: m.overview, genre_ids: m.genre_ids || [],
});

function resetDeck() {
  S.deckGen++;
  S.loading = false;
  S.loadError = false;
  S.exhausted = false;
  S.deck = [];
  S.seen = new Set(S.swiped);
  S.page = S.cleanPage = store.get(pageKey(), 0);
  S.pendingPartner = S.partnerLikes.filter((m) => !S.seen.has(m.id) && fitsFilters(m, S.filters));
  S.pendingPartner.forEach((m) => S.seen.add(m.id));
  for (const el of cardEls.values()) el.remove();
  cardEls.clear();
  renderDeck();
  refill();
}

// Mix movies the partner already liked into the deck: one every other card
function enqueue(fresh) {
  for (const m of fresh) {
    if (S.pendingPartner.length && S.deck.length % 2 === 1) S.deck.push(S.pendingPartner.shift());
    S.deck.push(m);
  }
}

async function refill() {
  if (S.loading || S.exhausted) return;
  S.loading = true;
  S.loadError = false;
  const gen = S.deckGen;
  try {
    let tries = 0;
    while (S.deck.length < 10 && !S.exhausted && tries++ < 8) {
      const page = S.page + 1;
      const data = await tmdb('/discover/movie', discoverParams(S.filters, page));
      if (gen !== S.deckGen) return;
      S.page = page;
      const fresh = (data.results || []).filter((m) => m.poster_path && !S.seen.has(m.id)).map(slim);
      fresh.forEach((m) => S.seen.add(m.id));
      // Remember pages that are fully swiped so the next launch starts after them
      if (!fresh.length && page === S.cleanPage + 1) { S.cleanPage = page; store.set(pageKey(), page); }
      enqueue(fresh);
      if (page >= Math.min(data.total_pages || 0, 500)) S.exhausted = true;
      renderDeck();
    }
  } catch (e) {
    console.error(e);
    if (gen === S.deckGen) { S.loadError = true; toast('Impossible de charger les films. Vérifie ta connexion.'); }
  } finally {
    if (gen === S.deckGen) {
      S.loading = false;
      if (S.exhausted || S.loadError) S.deck.push(...S.pendingPartner.splice(0));
      renderDeck();
    }
  }
}

function onPartnerLike(movie) {
  if (!movie?.id) return;
  if (S.liked.has(movie.id)) {
    // Both liked at the same moment: replay my like so the server sees both rows
    if (!hasMatch(movie.id)) {
      rpc('swipe', { p_movie_id: movie.id, p_liked: true, p_movie: movie })
        .then((matched) => { if (matched && !hasMatch(movie.id)) { addMatch(movie); broadcast('match', { movie }); showMatch(movie); } })
        .catch(console.warn);
    }
    return;
  }
  if (S.swiped.has(movie.id)) return;
  if (!S.partnerLikes.some((p) => p.id === movie.id)) S.partnerLikes.push(movie);
  if (!fitsFilters(movie, S.filters)) return;

  // Bring it near the top of the deck so a match can happen right away
  const idx = S.deck.findIndex((m) => m.id === movie.id);
  if (idx > 2) S.deck.splice(idx, 1);
  else if (idx >= 0) return;
  S.pendingPartner = S.pendingPartner.filter((m) => m.id !== movie.id);
  S.seen.add(movie.id);
  S.deck.splice(Math.min(2, S.deck.length), 0, movie);
  renderDeck();
}

/* ---------- Cards ---------- */

const cardEls = new Map();

const year = (m) => (m.release_date || '').slice(0, 4);
function metaPills(m, extra = []) {
  const pills = [];
  if (year(m)) pills.push(`<span class="pill">${year(m)}</span>`);
  if (m.vote_average) pills.push(`<span class="pill rate">★ ${m.vote_average.toFixed(1)}</span>`);
  pills.push(...extra);
  (m.genre_ids || []).slice(0, 2).forEach((g) => { if (S.genres.has(g)) pills.push(`<span class="pill">${esc(S.genres.get(g))}</span>`); });
  return pills.join('');
}

function createCard(m) {
  const el = document.createElement('div');
  el.className = 'card';
  el.innerHTML = `
    <img src="${IMG}w500${m.poster_path}" alt="" draggable="false">
    <div class="card-grad"></div>
    <div class="stamp like">J'AIME</div>
    <div class="stamp nope">NOPE</div>
    <div class="card-info">
      <h2>${esc(m.title)}</h2>
      <div class="card-meta">${metaPills(m)}</div>
      ${m.overview ? `<p class="card-overview">${esc(m.overview)}</p>` : ''}
    </div>`;
  attachDrag(el, m);
  return el;
}

function attachDrag(el, m) {
  const like = $('.stamp.like', el);
  const nope = $('.stamp.nope', el);
  let sx = 0, sy = 0, dx = 0, dy = 0, active = false, moved = false;

  el.addEventListener('pointerdown', (e) => {
    if (S.deck[0]?.id !== m.id) return;
    active = true; moved = false; sx = e.clientX; sy = e.clientY; dx = dy = 0;
    el.setPointerCapture(e.pointerId);
    el.style.transition = 'none';
    el.dataset.dragging = '1';
  });
  el.addEventListener('pointermove', (e) => {
    if (!active) return;
    dx = e.clientX - sx; dy = e.clientY - sy;
    if (Math.abs(dx) + Math.abs(dy) > 8) moved = true;
    el.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 18}deg)`;
    like.style.opacity = Math.max(0, Math.min(1, dx / 90));
    nope.style.opacity = Math.max(0, Math.min(1, -dx / 90));
  });
  const end = (cancelled) => {
    if (!active) return;
    active = false;
    delete el.dataset.dragging;
    el.style.transition = '';
    if (Math.abs(dx) > Math.min(110, innerWidth * 0.28)) return swipeTop(dx > 0, dy);
    like.style.opacity = nope.style.opacity = 0;
    el.style.transform = '';
    if (!moved && !cancelled) openSheet(m);
  };
  el.addEventListener('pointerup', () => end(false));
  el.addEventListener('pointercancel', () => end(true));
}

function renderDeck() {
  const deckEl = $('#deck');
  const top = S.deck.slice(0, 3);
  const ids = new Set(top.map((m) => m.id));
  for (const [id, el] of cardEls) if (!ids.has(id)) { el.remove(); cardEls.delete(id); }
  top.forEach((m, i) => {
    let el = cardEls.get(m.id);
    if (!el) { el = createCard(m); cardEls.set(m.id, el); deckEl.appendChild(el); }
    el.style.zIndex = 10 - i;
    if (!el.dataset.dragging) el.style.transform = i ? `translateY(${i * 12}px) scale(${1 - i * 0.04})` : '';
  });

  const empty = S.deck.length === 0;
  let sk = $('.skeleton', deckEl);
  const showSkeleton = empty && !S.exhausted && !S.loadError;
  if (showSkeleton && !sk) { sk = document.createElement('div'); sk.className = 'card skeleton'; deckEl.appendChild(sk); }
  if (!showSkeleton && sk) sk.remove();

  $('#deck-empty').hidden = !(empty && (S.exhausted || S.loadError));
  $('#deck-empty h3').textContent = S.loadError ? 'Connexion impossible' : 'Plus de films pour ces filtres';
  $('#deck-empty p').textContent = S.loadError
    ? 'Les films n’ont pas pu être chargés.'
    : 'Élargissez les genres ou les plateformes pour en découvrir d’autres.';
  $('#deck-empty button').textContent = S.loadError ? 'Réessayer' : 'Modifier les filtres';
  $('#deck-empty button').dataset.goto = S.loadError ? 'retry' : 'settings';

  $('#btn-like').disabled = $('#btn-nope').disabled = $('#btn-info').disabled = empty;
  $('#btn-undo').disabled = !S.last || S.last.matched;
}

function swipeTop(liked, dy = 0) {
  const m = S.deck[0];
  if (!m) return;
  const el = cardEls.get(m.id);
  if (el) {
    cardEls.delete(m.id);
    el.style.zIndex = 20;
    el.style.transition = 'transform .38s ease-out, opacity .38s ease-out';
    $(liked ? '.stamp.like' : '.stamp.nope', el).style.opacity = 1;
    el.style.transform = `translate(${(liked ? 1 : -1) * innerWidth * 1.3}px, ${dy + 40}px) rotate(${liked ? 24 : -24}deg)`;
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 400);
  }
  S.deck.shift();
  commitSwipe(m, liked);
  renderDeck();
  if (S.deck.length < 6) refill();
}

async function commitSwipe(m, liked) {
  S.swiped.add(m.id);
  if (liked) S.liked.add(m.id); else S.liked.delete(m.id);
  S.partnerLikes = S.partnerLikes.filter((p) => p.id !== m.id);
  S.last = { movie: m, liked, matched: false };
  navigator.vibrate?.(8);
  try {
    const matched = await rpc('swipe', { p_movie_id: m.id, p_liked: liked, p_movie: m });
    if (liked) broadcast('like', { movie: m });
    if (matched) {
      if (S.last?.movie.id === m.id) S.last.matched = true;
      if (!hasMatch(m.id)) { addMatch(m); showMatch(m); }
      broadcast('match', { movie: m });
    }
  } catch (e) {
    console.error(e);
    toast('Swipe non enregistré, réessaie.');
    S.swiped.delete(m.id);
    S.liked.delete(m.id);
    if (S.last?.movie.id === m.id) S.last = null;
    S.deck.unshift(m);
  }
  renderDeck();
}

// The swipe stays recorded server side; swiping the card again overwrites it.
function undo() {
  const l = S.last;
  if (!l || l.matched) return;
  S.last = null;
  S.swiped.delete(l.movie.id);
  S.liked.delete(l.movie.id);
  S.deck.unshift(l.movie);
  renderDeck();
}

/* ---------- Matches ---------- */

const hasMatch = (id) => S.matches.some((x) => x.movie.id === id);
const seenKey = () => `seenMatches:${S.code}`;

function addMatch(movie) {
  S.matches.unshift({ movie, watched: false, created_at: new Date().toISOString() });
  renderMatches();
}

function markMatchesSeen() {
  store.set(seenKey(), S.matches.map((x) => x.movie.id));
  updateBadge();
}

function updateBadge() {
  const seen = new Set(store.get(seenKey(), []));
  const n = S.matches.filter((x) => !seen.has(x.movie.id)).length;
  const b = $('#matches-badge');
  b.hidden = n === 0;
  b.textContent = n;
}

function renderMatches() {
  const seen = new Set(store.get(seenKey(), []));
  const list = S.matches.filter((x) => (S.matchFilter === 'watched' ? x.watched : !x.watched));
  $('#matches-grid').innerHTML = list.map((x) => `
    <button class="match-tile ${seen.has(x.movie.id) ? '' : 'new'}" data-id="${x.movie.id}">
      ${x.movie.poster_path ? `<img loading="lazy" src="${IMG}w342${x.movie.poster_path}" alt="">` : ''}
      <span class="tile-title">${esc(x.movie.title)}</span>
    </button>`).join('');
  const empty = $('#matches-empty');
  empty.hidden = list.length > 0;
  $('p', empty).textContent = S.matchFilter === 'watched'
    ? 'Aucun film marqué comme vu pour l’instant.'
    : S.matches.length ? 'Vous avez vu tous vos matchs. Bravo !' : 'Pas encore de match. Continuez à swiper !';
  updateBadge();
  if (!$('#tab-matches').hidden) markMatchesSeen();
}

function showMatch(m) {
  $('#match-poster').src = `${IMG}w500${m.poster_path}`;
  $('#match-text').textContent = `${S.partner || 'Ta moitié'} et toi voulez voir « ${m.title} »`;
  const hearts = $('#match-overlay .hearts');
  hearts.innerHTML = Array.from({ length: 18 }, () => {
    const left = Math.random() * 100, dur = 2.5 + Math.random() * 2.5, delay = Math.random() * 1.2;
    const emoji = ['❤️', '💖', '🍿', '✨'][Math.floor(Math.random() * 4)];
    return `<span style="left:${left}%;animation-duration:${dur}s;animation-delay:${delay}s">${emoji}</span>`;
  }).join('');
  $('#match-overlay').hidden = false;
  $('#match-overlay').dataset.id = m.id;
  navigator.vibrate?.([60, 40, 120]);
  markMatchesSeen();
}

/* ---------- Movie sheet ---------- */

function runtime(min) {
  if (!min) return '';
  const h = Math.floor(min / 60), mm = String(min % 60).padStart(2, '0');
  return h ? `${h} h ${mm}` : `${min} min`;
}

function sheetHtml(m, d) {
  const match = S.matches.find((x) => x.movie.id === m.id);
  const isTop = S.deck[0]?.id === m.id && !$('#tab-swipe').hidden;
  const backdrop = (d?.backdrop_path || m.backdrop_path) ? `${IMG}w780${d?.backdrop_path || m.backdrop_path}` : `${IMG}w500${m.poster_path}`;
  const extra = d?.runtime ? [`<span class="pill">${runtime(d.runtime)}</span>`] : [];
  const fr = d?.['watch/providers']?.results?.FR;
  const subs = (fr?.flatrate || []).filter((p) => PROVIDER_IDS.includes(p.provider_id));
  const trailer = (d?.videos?.results || []).find((v) => v.site === 'YouTube' && v.type === 'Trailer')
    || (d?.videos?.results || []).find((v) => v.site === 'YouTube');

  let providers = '';
  if (d) {
    providers = subs.length
      ? `<div class="providers">${subs.map((p) => `<img src="${IMG}w92${p.logo_path}" alt="${esc(p.provider_name)}" title="${esc(p.provider_name)}">`).join('')}</div>`
      : '<p class="muted">Plus inclus dans Netflix, Prime Video ou Canal+ en ce moment.</p>';
  }

  return `
    <div class="sheet-hero"><img src="${backdrop}" alt=""></div>
    <div class="sheet-content">
      <h2 id="sheet-title">${esc(m.title)}</h2>
      <div class="card-meta">${metaPills(d ? { ...m, genre_ids: (d.genres || []).map((g) => g.id) } : m, extra)}</div>
      ${d?.tagline ? `<p><em>${esc(d.tagline)}</em></p>` : ''}
      <p>${esc(d?.overview || m.overview || 'Pas de résumé disponible.')}</p>
      <div class="sheet-section">Où le regarder</div>
      ${d ? providers : '<p class="muted">Chargement…</p>'}
      <div class="sheet-actions">
        ${trailer ? `<a class="btn btn-secondary" href="https://www.youtube.com/watch?v=${esc(trailer.key)}" target="_blank" rel="noopener">▶ Bande-annonce</a>` : ''}
        ${match ? `<button class="btn ${match.watched ? 'btn-secondary' : 'btn-primary'}" data-act="watched">${match.watched ? 'Remettre dans « À voir »' : '✓ On l’a vu !'}</button>` : ''}
        ${isTop ? `<button class="btn btn-primary" data-act="like">♥ J'aime</button><button class="btn btn-ghost" data-act="nope">Je passe</button>` : ''}
      </div>
    </div>`;
}

async function openSheet(m) {
  S.sheetId = m.id;
  $('#sheet-body').innerHTML = sheetHtml(m, null);
  $('#sheet').hidden = false;
  $('.sheet-panel').scrollTop = 0;
  try {
    const d = await tmdb(`/movie/${m.id}`, { append_to_response: 'videos,watch/providers', include_video_language: 'fr,en' });
    if (!$('#sheet').hidden && S.sheetId === m.id) $('#sheet-body').innerHTML = sheetHtml(m, d);
  } catch (e) { console.warn(e); }
}

function closeSheet() { $('#sheet').hidden = true; S.sheetId = null; }

async function toggleWatched(id) {
  const match = S.matches.find((x) => x.movie.id === id);
  if (!match) return;
  match.watched = !match.watched;
  renderMatches();
  closeSheet();
  toast(match.watched ? 'Classé dans « Vus »' : 'Remis dans « À voir »');
  try { await rpc('set_watched', { p_movie_id: id, p_watched: match.watched }); }
  catch { match.watched = !match.watched; renderMatches(); toast('Modification non enregistrée'); }
}

/* ---------- Settings ---------- */

async function loadCatalog() {
  if (S.genres.size) return;
  try {
    const [g, p] = await Promise.all([tmdb('/genre/movie/list'), tmdb('/watch/providers/movie', { watch_region: 'FR' })]);
    S.genres = new Map((g.genres || []).map((x) => [x.id, x.name]));
    const all = p.results || [];
    S.providers = PROVIDER_IDS.map((id) => all.find((x) => x.provider_id === id) || { provider_id: id, logo_path: null });
  } catch (e) {
    console.error(e);
  }
  renderFilters();
}

function renderFilters() {
  const f = S.filters;
  const providers = S.providers.length ? S.providers : PROVIDER_IDS.map((id) => ({ provider_id: id, logo_path: null }));
  $('#filter-providers').innerHTML = providers.map((p) => `<button class="chip ${f.providers.includes(p.provider_id) ? 'active' : ''}" data-provider="${p.provider_id}">
      ${p.logo_path ? `<img src="${IMG}w92${p.logo_path}" alt="">` : ''}${PROVIDER_NAMES[p.provider_id]}</button>`).join('');
  $('#filter-genres').innerHTML = S.genres.size
    ? [...S.genres].map(([id, name]) => `<button class="chip ${f.genres.includes(id) ? 'active' : ''}" data-genre="${id}">${esc(name)}</button>`).join('')
    : '<span class="muted">Impossible de charger les genres.</span>';
  $$('[data-filter]').forEach((seg) => {
    const v = String(f[seg.dataset.filter]);
    $$('button', seg).forEach((b) => b.classList.toggle('active', b.dataset.value === v));
  });
}

let filterTimer;
function editFilters(mutate) {
  const nf = normFilters(structuredClone(S.filters));
  mutate(nf);
  S.filters = nf;
  renderFilters();
  clearTimeout(filterTimer);
  filterTimer = setTimeout(async () => {
    resetDeck();
    broadcast('filters', { filters: S.filters });
    try { await rpc('set_filters', { p_filters: S.filters }); }
    catch { toast('Filtres non enregistrés'); }
  }, 700);
}

const toggleIn = (arr, v) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

function renderPartner() {
  $('#partner-name').textContent = S.partner ? `♥ ${S.partner}` : 'En attente…';
  $('#partner-chip').classList.toggle('online', !!S.partner && S.partnerOnline);
  $('#invite-banner').hidden = !!S.partner;
  $('#invite-code').textContent = S.code;
  $('#settings-code').textContent = S.code;
  $('#settings-members').textContent = S.partner ? `${S.me} & ${S.partner}` : `${S.me} · en attente de ta moitié`;
}

async function share() {
  const url = `${location.origin}${location.pathname}?code=${S.code}`;
  const text = `Rejoins-moi sur SwipeFlix pour choisir un film ensemble 🍿 Code : ${S.code}`;
  if (navigator.share) {
    try { await navigator.share({ title: 'SwipeFlix', text, url }); } catch {}
    return;
  }
  try { await navigator.clipboard.writeText(`${text}\n${url}`); toast('Lien copié !'); }
  catch { window.prompt('Copie ce lien :', url); }
}

/* ---------- Navigation ---------- */

function switchTab(name) {
  $$('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab').forEach((t) => { t.hidden = t.id !== `tab-${name}`; });
  if (name === 'matches') { renderMatches(); markMatchesSeen(); }
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

let inviteCode = '';

// With an invite code the screen only offers to join that room
function showWelcome(error = '', code = '', invited = false) {
  inviteCode = invited ? code : '';
  $('#screen-main').hidden = true;
  $('#screen-welcome').hidden = false;
  $('#input-name').value = store.get('name', '');
  $('#input-code').value = code;
  $('#welcome-error').textContent = error;
  $('#invite-box').hidden = !inviteCode;
  $('#invite-box-code').textContent = inviteCode;
  $('#btn-join-invite').hidden = !inviteCode;
  $('#btn-not-invited').hidden = !inviteCode;
  $('#welcome-default').hidden = !!inviteCode;
}

// Everything swiped, liked or matched belongs to one room: start clean on every room change
function clearRoom() {
  if (S.channel) sb.removeChannel(S.channel);
  Object.assign(S, {
    channel: null, code: null, me: '', partner: null, partnerOnline: false,
    filters: { ...DEFAULT_FILTERS }, swiped: new Set(), liked: new Set(), partnerLikes: [], pendingPartner: [],
    deck: [], seen: new Set(), page: 0, cleanPage: 0, exhausted: false, loading: false, loadError: false,
    last: null, matches: [], matchFilter: 'towatch',
  });
  S.deckGen++;
  cardEls.clear();
  $('#deck').innerHTML = '';
  closeSheet();
  $('#match-overlay').hidden = true;
  $$('#matches-filter button').forEach((b) => b.classList.toggle('active', b.dataset.value === 'towatch'));
  renderMatches();
}

async function enterRoom(code) {
  clearRoom();
  S.code = code;
  let st;
  try {
    st = await rpc('get_state');
  } catch (e) {
    if (String(e.message).includes('not_member')) {
      store.del('code');
      S.code = null;
      return showWelcome('Ce salon n’existe plus, crée-en un nouveau.');
    }
    S.code = null;
    return showWelcome('Connexion impossible. Vérifie ta connexion puis réessaie.', code, true);
  }
  applyState(st, true);
  store.set('code', S.code);
  $('#screen-welcome').hidden = true;
  $('#screen-main').hidden = false;
  switchTab('swipe');
  connectChannel();
  await loadCatalog();
  resetDeck();
}

function leaveRoom() {
  if (!confirm(`Changer de salon ? Tu repartiras de zéro dans le nouveau salon (tu pourras revenir dans celui-ci avec le code ${S.code}).`)) return;
  store.del('code');
  clearRoom();
  showWelcome();
}

/* ---------- Events ---------- */

$('#form-welcome').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#input-name').value.trim();
  const code = inviteCode || $('#input-code').value.trim().toUpperCase();
  // Enter submits with the first button in the form, so don't trust the submitter alone
  const action = inviteCode || document.activeElement === $('#input-code') || e.submitter?.id === 'btn-join' ? 'join' : 'create';
  const err = $('#welcome-error');
  if (!name) { err.textContent = 'Indique ton prénom.'; return; }
  if (action === 'join' && code.length !== 6) { err.textContent = 'Le code fait 6 caractères.'; return; }
  err.textContent = '';
  store.set('name', name);
  $$('#form-welcome button').forEach((b) => { b.disabled = true; });
  try {
    const { data, error } = action === 'create'
      ? await sb.rpc('create_room', { p_member: memberId, p_name: name })
      : await sb.rpc('join_room', { p_code: code, p_member: memberId, p_name: name });
    if (error) throw error;
    history.replaceState(null, '', location.pathname);
    await enterRoom(data);
  } catch (e2) {
    const msg = String(e2.message || '');
    err.textContent = msg.includes('room_not_found') ? 'Aucun salon avec ce code.'
      : msg.includes('room_full') ? 'Ce salon a déjà deux personnes.'
      : 'Connexion impossible, réessaie.';
  } finally {
    $$('#form-welcome button').forEach((b) => { b.disabled = false; });
  }
});
$('#btn-not-invited').addEventListener('click', () => {
  history.replaceState(null, '', location.pathname);
  showWelcome();
});
$('#input-code').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

$('#btn-like').addEventListener('click', () => swipeTop(true));
$('#btn-nope').addEventListener('click', () => swipeTop(false));
$('#btn-undo').addEventListener('click', undo);
$('#btn-info').addEventListener('click', () => { if (S.deck[0]) openSheet(S.deck[0]); });

$$('.tabbar button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
$$('[data-share]').forEach((b) => b.addEventListener('click', share));
$('#deck-empty button').addEventListener('click', (e) => {
  if (e.currentTarget.dataset.goto === 'retry') resetDeck();
  else switchTab('settings');
});

$('#matches-filter').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  S.matchFilter = b.dataset.value;
  $$('#matches-filter button').forEach((x) => x.classList.toggle('active', x === b));
  renderMatches();
});
$('#matches-grid').addEventListener('click', (e) => {
  const tile = e.target.closest('.match-tile');
  const match = tile && S.matches.find((x) => x.movie.id === Number(tile.dataset.id));
  if (match) openSheet(match.movie);
});

$('#filter-providers').addEventListener('click', (e) => {
  const b = e.target.closest('[data-provider]');
  if (b) editFilters((f) => { f.providers = toggleIn(f.providers, Number(b.dataset.provider)); });
});
$('#filter-genres').addEventListener('click', (e) => {
  const b = e.target.closest('[data-genre]');
  if (b) editFilters((f) => { f.genres = toggleIn(f.genres, Number(b.dataset.genre)); });
});
$$('[data-filter]').forEach((seg) => seg.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const key = seg.dataset.filter;
  editFilters((f) => { f[key] = key === 'sort' ? b.dataset.value : Number(b.dataset.value); });
}));
$('#btn-leave').addEventListener('click', leaveRoom);

$('#sheet').addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) return closeSheet();
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'watched') toggleWatched(S.sheetId);
  if (act === 'like' || act === 'nope') { closeSheet(); swipeTop(act === 'like'); }
});

$('#btn-match-close').addEventListener('click', () => { $('#match-overlay').hidden = true; });
$('#btn-match-details').addEventListener('click', () => {
  const id = Number($('#match-overlay').dataset.id);
  $('#match-overlay').hidden = true;
  const match = S.matches.find((x) => x.movie.id === id);
  if (match) openSheet(match.movie);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeSheet(); $('#match-overlay').hidden = true; return; }
  if ($('#screen-main').hidden || $('#tab-swipe').hidden || !$('#sheet').hidden || !$('#match-overlay').hidden) return;
  if (e.target.closest('input')) return;
  if (e.key === 'ArrowRight') swipeTop(true);
  if (e.key === 'ArrowLeft') swipeTop(false);
});

// Catch up on anything missed while the app was in the background
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && S.code && !$('#screen-main').hidden) refreshState();
});

/* ---------- Boot ---------- */

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

const urlCode = new URLSearchParams(location.search).get('code')?.toUpperCase().replace(/[^A-Z0-9]/g, '') || '';
const savedCode = store.get('code');
if (savedCode && (!urlCode || urlCode === savedCode)) {
  history.replaceState(null, '', location.pathname);
  enterRoom(savedCode);
} else {
  showWelcome('', urlCode, urlCode.length === 6);
  if (urlCode) $('#input-name').focus();
}
