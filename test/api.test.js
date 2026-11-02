// End-to-end checks for every level of the spec, run against a live server:
//   BASE_URL=http://localhost:3000 API_KEY=... node --test test/
// Note: this calls POST /reset, which wipes all bookings.
const test = require('node:test');
const assert = require('node:assert/strict');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const KEY = process.env.API_KEY;

async function call(method, path, { body, headers = {}, key = KEY } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(key ? { 'X-API-Key': key } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
}

const future = (h) => new Date(Date.now() + h * 36e5).toISOString().replace(/\.\d+Z$/, 'Z');
let n = 0;
const uniqueEmail = () => `user${Date.now()}_${n++}@example.com`;

async function reset(count = 20) {
  const slots = [{ id: 'past', provider: 'Dr Ade', start: '2020-01-01T09:00:00Z', end: '2020-01-01T09:30:00Z' }];
  for (let i = count; i >= 1; i--) {
    slots.push({ id: `s${i}`, provider: i % 2 ? 'Dr Ade' : 'Dr Bello', start: future(i), end: future(i + 0.5) });
  }
  const res = await call('POST', '/reset', { body: { slots } });
  assert.equal(res.status, 200);
  return slots;
}

test('level 1: list slots, book, look up', async () => {
  const sent = await reset();
  const list = await call('GET', '/slots');
  assert.equal(list.status, 200);
  assert.equal(list.body.slots.length, 21);
  assert.equal(list.body.slots[0].id, 'past', 'earliest start first');
  assert.equal(list.body.slots[1].id, 's1');
  assert.equal(list.body.slots[1].start, sent.find((s) => s.id === 's1').start, 'start returned exactly as sent');
  assert.ok(list.body.slots.every((s) => s.available === true));

  const ade = await call('GET', '/slots?provider=Dr%20Ade');
  assert.ok(ade.body.slots.length > 0 && ade.body.slots.every((s) => s.provider === 'Dr Ade'));

  const booked = await call('POST', '/bookings', { body: { slot_id: 's1', name: 'Ada Obi', email: 'ada@example.com' } });
  assert.equal(booked.status, 201);
  assert.equal(booked.body.status, 'confirmed');
  assert.ok(booked.body.id && booked.body.created_at);

  const got = await call('GET', `/bookings/${booked.body.id}`);
  assert.equal(got.status, 200);
  assert.deepEqual(got.body, booked.body);
  assert.equal((await call('GET', '/bookings/nope')).status, 404);

  const after = await call('GET', '/slots');
  assert.equal(after.body.slots.find((s) => s.id === 's1').available, false);
});

test('level 2: API key and validation', async () => {
  await reset();
  assert.equal((await call('GET', '/slots', { key: null })).status, 401);
  assert.equal((await call('GET', '/slots', { key: 'wrong' })).status, 401);
  assert.deepEqual(Object.keys((await call('GET', '/slots', { key: 'wrong' })).body), ['error']);

  const bad = [
    {}, { name: 'A', email: 'a@b.co' }, { slot_id: 's1', email: 'a@b.co' }, { slot_id: 's1', name: 'A' },
    { slot_id: '', name: 'A', email: 'a@b.co' }, { slot_id: 's1', name: '   ', email: 'a@b.co' },
    { slot_id: 's1', name: 'A', email: 'not-an-email' }, { slot_id: 's1', name: 'A', email: '' },
  ];
  for (const body of bad) {
    // A fresh address per case so the level 5 rate limit doesn't interfere.
    const res = await call('POST', '/bookings', { body: body.email === 'a@b.co' ? { ...body, email: uniqueEmail() } : body });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.ok(typeof res.body.error === 'string');
  }
  assert.equal((await call('POST', '/bookings', { body: '{bad json' })).status, 400);
  assert.equal((await call('POST', '/bookings', { body: { slot_id: 'missing', name: 'A', email: uniqueEmail() } })).status, 404);
  assert.equal((await call('POST', '/bookings', { body: { slot_id: 'past', name: 'A', email: uniqueEmail() } })).status, 400);

  const ok = await call('POST', '/bookings', { body: { slot_id: 's2', name: '  Ada Obi  ', email: '  ADA@Example.COM ' } });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.name, 'Ada Obi');
  assert.equal(ok.body.email, 'ada@example.com');
});

test('level 3: no double booking under concurrency, and cancel', async () => {
  await reset();
  const results = await Promise.all(Array.from({ length: 25 }, () =>
    call('POST', '/bookings', { body: { slot_id: 's3', name: 'Racer', email: uniqueEmail() } })));
  const statuses = results.map((r) => r.status).sort();
  assert.equal(statuses.filter((s) => s === 201).length, 1, `exactly one winner, got ${statuses}`);
  assert.equal(statuses.filter((s) => s === 409).length, 24);

  const winner = results.find((r) => r.status === 201).body;
  const cancelled = await call('DELETE', `/bookings/${winner.id}`);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.status, 'cancelled');
  assert.equal((await call('DELETE', `/bookings/${winner.id}`)).status, 409);
  assert.equal((await call('DELETE', '/bookings/nope')).status, 404);
  assert.equal((await call('GET', '/slots')).body.slots.find((s) => s.id === 's3').available, true);
  assert.equal((await call('POST', '/bookings', { body: { slot_id: 's3', name: 'Next', email: uniqueEmail() } })).status, 201);
});

test('level 4: idempotency and pagination', async () => {
  await reset();
  const body = { slot_id: 's4', name: 'Ada', email: uniqueEmail() };
  const headers = { 'Idempotency-Key': `k-${Date.now()}` };
  const first = await call('POST', '/bookings', { body, headers });
  const again = await call('POST', '/bookings', { body: { email: body.email, name: body.name, slot_id: body.slot_id }, headers });
  assert.equal(first.status, 201);
  assert.equal(again.status, 201);
  assert.equal(again.body.id, first.body.id);
  assert.equal((await call('POST', '/bookings', { body: { ...body, slot_id: 's5' }, headers })).status, 422);

  // Concurrent retries with one key create one booking.
  const body2 = { slot_id: 's6', name: 'Bo', email: uniqueEmail() };
  const headers2 = { 'Idempotency-Key': `k2-${Date.now()}` };
  const burst = await Promise.all(Array.from({ length: 4 }, () => call('POST', '/bookings', { body: body2, headers: headers2 })));
  assert.ok(burst.every((r) => r.status === 201 && r.body.id === burst[0].body.id), JSON.stringify(burst.map((r) => r.status)));

  // An error response is replayed too.
  const errKey = { 'Idempotency-Key': `k3-${Date.now()}` };
  const missing = { slot_id: 'missing', name: 'C', email: uniqueEmail() };
  assert.equal((await call('POST', '/bookings', { body: missing, headers: errKey })).status, 404);
  assert.equal((await call('POST', '/bookings', { body: missing, headers: errKey })).status, 404);

  // Pagination: 5 bookings (the rate limit's maximum), mixing the email's case, read 2 at a time.
  await reset(20);
  const email = uniqueEmail();
  const ids = [];
  for (let i = 1; i <= 5; i++) {
    const r = await call('POST', '/bookings', { body: { slot_id: `s${i}`, name: 'P', email: i % 2 ? email.toUpperCase() : email } });
    assert.equal(r.status, 201);
    ids.push(r.body.id);
  }
  const seen = [];
  let cursor;
  let pages = 0;
  do {
    const q = `/bookings?email=${encodeURIComponent(email.toUpperCase())}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const page = await call('GET', q);
    assert.equal(page.status, 200);
    assert.ok(page.body.bookings.length <= 2);
    seen.push(...page.body.bookings.map((b) => b.id));
    cursor = page.body.next_cursor;
    pages++;
  } while (cursor);
  assert.equal(pages, 3);
  assert.deepEqual(seen, ids, 'oldest first, nothing skipped or repeated');

  const all = await call('GET', `/bookings?email=${encodeURIComponent(email)}`);
  assert.equal(all.body.bookings.length, 5);
  assert.equal(all.body.next_cursor, null);
  for (const limit of ['0', '51', 'abc', '2.5', '-1']) {
    assert.equal((await call('GET', `/bookings?email=${encodeURIComponent(email)}&limit=${limit}`)).status, 400, limit);
  }
});

test('level 5: rate limit per email', async () => {
  await reset();
  const email = uniqueEmail();
  // Failed attempts count too: two 404s, then three bookings.
  const attempts = ['missing', 'missing', 's1', 's2', 's3', 's4'];
  const results = [];
  for (const slot_id of attempts) {
    results.push(await call('POST', '/bookings', { body: { slot_id, name: 'Spam', email } }));
  }
  assert.deepEqual(results.map((r) => r.status), [404, 404, 201, 201, 201, 429]);
  const retryAfter = results[5].headers.get('retry-after');
  assert.match(retryAfter, /^\d+$/);
  assert.ok(+retryAfter >= 1 && +retryAfter <= 60);

  // Same email in different case and spacing is the same person.
  assert.equal((await call('POST', '/bookings', { body: { slot_id: 's5', name: 'Spam', email: ` ${email.toUpperCase()} ` } })).status, 429);
  // Other emails are unaffected.
  assert.equal((await call('POST', '/bookings', { body: { slot_id: 's6', name: 'Other', email: uniqueEmail() } })).status, 201);

  // Concurrent burst can't slip past the limit.
  const burstEmail = uniqueEmail();
  const burst = await Promise.all(Array.from({ length: 12 }, (_, i) =>
    call('POST', '/bookings', { body: { slot_id: `s${7 + i}`, name: 'Burst', email: burstEmail } })));
  assert.equal(burst.filter((r) => r.status !== 429).length, 5);
});
