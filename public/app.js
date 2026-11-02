// The page is served by the API itself, so requests go to the same origin.
const API = '';
const $ = (id) => document.getElementById(id);

let apiKey = '';
try { apiKey = localStorage.getItem('clinic-api-key') || ''; } catch {}
let slotsById = {};
let selected = null;
let pendingIdempotencyKey = null;

async function api(path, options = {}) {
  const res = await fetch(API + path, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey, ...options.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.retryAfter = res.headers.get('Retry-After');
    if (res.status === 401) $('key-section').classList.remove('hidden');
    throw err;
  }
  return body;
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function showMsg(container, text, kind = 'error') {
  $(container).replaceChildren(text ? el('div', { className: `msg ${kind}`, textContent: text }) : '');
}

function describeError(err) {
  if (err.status === 401) return 'The API key was rejected. Check it and save it again.';
  if (err.status === 409) return 'Sorry, someone has just booked that slot. Please pick another.';
  if (err.status === 429) return `Too many attempts for this email. Try again in ${err.retryAfter || 'a few'} seconds.`;
  return err.message;
}

const fmtDay = (iso) => new Date(iso).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
const fmtTime = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const fmtSlot = (s) => `${s.provider}, ${fmtDay(s.start)} at ${fmtTime(s.start)}`;

async function loadSlots() {
  const provider = $('provider').value;
  try {
    const { slots } = await api('/slots' + (provider ? `?provider=${encodeURIComponent(provider)}` : ''));
    if (!provider) {
      slotsById = Object.fromEntries(slots.map((s) => [s.id, s]));
      fillProviders(slots);
    }
    renderSlots(slots.filter((s) => new Date(s.start) > new Date()));
  } catch (err) {
    $('slots').replaceChildren(el('div', { className: 'msg error', textContent: describeError(err) }));
  }
}

function fillProviders(slots) {
  const current = $('provider').value;
  const names = [...new Set(slots.map((s) => s.provider))].sort();
  $('provider').replaceChildren(el('option', { value: '', textContent: 'All providers' }),
    ...names.map((n) => el('option', { value: n, textContent: n })));
  $('provider').value = names.includes(current) ? current : '';
}

function renderSlots(slots) {
  if (!slots.length) {
    $('slots').replaceChildren(el('p', { className: 'muted', textContent: 'No upcoming slots.' }));
    return;
  }
  const out = [];
  let day = null;
  let grid = null;
  for (const s of slots) {
    if (fmtDay(s.start) !== day) {
      day = fmtDay(s.start);
      grid = el('div', { className: 'slots' });
      out.push(el('div', { className: 'day', textContent: day }), grid);
    }
    const btn = el('button', { type: 'button', className: 'slot', disabled: !s.available },
      el('strong', { textContent: `${fmtTime(s.start)} – ${fmtTime(s.end)}` }),
      el('span', { textContent: s.provider }));
    btn.setAttribute('aria-pressed', String(selected === s.id));
    btn.addEventListener('click', () => selectSlot(s.id, btn));
    grid.append(btn);
  }
  $('slots').replaceChildren(...out);
}

function selectSlot(id, btn) {
  selected = id;
  pendingIdempotencyKey = null;
  document.querySelectorAll('.slot').forEach((b) => b.setAttribute('aria-pressed', 'false'));
  btn.setAttribute('aria-pressed', 'true');
  $('book-title').textContent = fmtSlot(slotsById[id]);
  $('book-section').classList.remove('hidden');
  showMsg('book-msg', '');
  $('name').focus();
}

$('book-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  // One key per booking attempt: if the network drops and the person clicks again,
  // the API recognises the retry and returns the original booking instead of a duplicate.
  pendingIdempotencyKey ??= crypto.randomUUID();
  $('book-btn').disabled = true;
  try {
    const booking = await api('/bookings', {
      method: 'POST',
      headers: { 'Idempotency-Key': pendingIdempotencyKey },
      body: JSON.stringify({ slot_id: selected, name: $('name').value, email: $('email').value }),
    });
    pendingIdempotencyKey = null;
    selected = null;
    $('book-section').classList.add('hidden');
    showConfirmation(booking, 'Your appointment is booked.');
    loadSlots();
  } catch (err) {
    // A definite answer from the server ends this attempt; a network error keeps the key for a retry.
    if (err.status) pendingIdempotencyKey = null;
    showMsg('book-msg', err.status ? describeError(err) : 'Network problem. Please try again.');
    if (err.status === 409) loadSlots();
  } finally {
    $('book-btn').disabled = false;
  }
});

let shownBooking = null;

function showConfirmation(booking, note) {
  shownBooking = booking;
  const slot = slotsById[booking.slot_id];
  const rows = [
    ['Booking ID', booking.id],
    ['Status', el('span', { className: `badge ${booking.status}`, textContent: booking.status })],
    ['Appointment', slot ? fmtSlot(slot) : booking.slot_id],
    ['Name', booking.name],
    ['Email', booking.email],
    ['Booked at', new Date(booking.created_at).toLocaleString()],
  ];
  $('conf-details').replaceChildren(...rows.flatMap(([k, v]) => [el('dt', { textContent: k }), el('dd', {}, v)]));
  $('cancel-btn').classList.toggle('hidden', booking.status !== 'confirmed');
  showMsg('conf-msg', note || '', 'ok');
  $('confirmation').classList.remove('hidden');
  $('confirmation').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$('cancel-btn').addEventListener('click', async () => {
  if (!shownBooking || !confirm('Cancel this booking?')) return;
  try {
    const booking = await api(`/bookings/${encodeURIComponent(shownBooking.id)}`, { method: 'DELETE' });
    showConfirmation(booking, 'Your booking has been cancelled and the slot is free again.');
    loadSlots();
  } catch (err) {
    showMsg('conf-msg', describeError(err));
  }
});

$('lookup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('lookup-id').value.trim();
  if (!id) return;
  showMsg('lookup-msg', '');
  try {
    showConfirmation(await api(`/bookings/${encodeURIComponent(id)}`));
  } catch (err) {
    showMsg('lookup-msg', err.status === 404 ? 'No booking with that ID.' : describeError(err));
  }
});

let mineEmail = null;

async function loadMine(cursor) {
  const params = new URLSearchParams({ email: mineEmail, limit: '5' });
  if (cursor) params.set('cursor', cursor);
  try {
    const page = await api(`/bookings?${params}`);
    renderMine(page, Boolean(cursor));
  } catch (err) {
    showMsg('lookup-msg', describeError(err));
  }
}

function renderMine({ bookings, next_cursor }, append) {
  let tbody = $('mine').querySelector('tbody');
  if (!append || !tbody) {
    tbody = el('tbody');
    $('mine').replaceChildren(el('table', {},
      el('thead', {}, el('tr', {}, ...['Booking ID', 'Appointment', 'Status', ''].map((h) => el('th', { textContent: h })))),
      tbody));
  }
  for (const b of bookings) {
    const slot = slotsById[b.slot_id];
    const view = el('button', { type: 'button', className: 'secondary', textContent: 'View' });
    view.addEventListener('click', () => showConfirmation(b));
    tbody.append(el('tr', {},
      el('td', { textContent: b.id.slice(0, 11) + '…' }),
      el('td', { textContent: slot ? fmtSlot(slot) : b.slot_id }),
      el('td', {}, el('span', { className: `badge ${b.status}`, textContent: b.status })),
      el('td', {}, view)));
  }
  if (!tbody.children.length) $('mine').replaceChildren(el('p', { className: 'muted', textContent: 'No bookings for that email.' }));
  $('mine').querySelector('.more')?.remove();
  if (next_cursor) {
    const more = el('button', { type: 'button', className: 'secondary more', textContent: 'Load more', style: 'margin-top:10px' });
    more.addEventListener('click', () => loadMine(next_cursor));
    $('mine').append(more);
  }
}

$('mine-form').addEventListener('submit', (e) => {
  e.preventDefault();
  mineEmail = $('mine-email').value.trim();
  showMsg('lookup-msg', '');
  if (mineEmail) loadMine();
});

$('key-form').addEventListener('submit', (e) => {
  e.preventDefault();
  apiKey = $('api-key').value.trim();
  try { localStorage.setItem('clinic-api-key', apiKey); } catch {}
  $('key-section').classList.add('hidden');
  loadSlots();
});

$('provider').addEventListener('change', loadSlots);
$('refresh').addEventListener('click', loadSlots);

if (apiKey) {
  $('key-section').classList.add('hidden');
  loadSlots();
} else {
  $('slots').replaceChildren(el('p', { className: 'muted', textContent: 'Enter the API key above to see slots.' }));
}
