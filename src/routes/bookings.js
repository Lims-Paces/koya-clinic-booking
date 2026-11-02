const crypto = require('crypto');
const express = require('express');
const { pool, withTransaction } = require('../db');
const { recordAttempt } = require('../lib/rateLimit');
const { fail, isObject, nonEmptyString, sha256, canonical } = require('../lib/util');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const router = express.Router();

// Thrown inside a transaction to roll it back and send this response instead.
class Reply {
  constructor(status, body, headers = {}) {
    Object.assign(this, { status, body, headers });
  }
}

function toBooking(row) {
  return {
    id: row.id,
    slot_id: row.slot_id,
    name: row.name,
    email: row.email,
    status: row.status,
    created_at: row.created_at.toISOString(),
  };
}

// Cursors are opaque to clients; inside they're the seq of the last booking on the page.
const encodeCursor = (seq) => Buffer.from(String(seq)).toString('base64url');
function decodeCursor(cursor) {
  const seq = Buffer.from(cursor, 'base64url').toString();
  return /^\d{1,18}$/.test(seq) ? seq : null;
}

async function book(db, body) {
  const { slot_id } = body;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';

  if (!nonEmptyString(slot_id)) return { status: 400, body: { error: 'slot_id is required' } };
  if (!name) return { status: 400, body: { error: 'name is required' } };
  if (!email) return { status: 400, body: { error: 'email is required' } };
  if (!EMAIL_RE.test(email)) return { status: 400, body: { error: 'email is not valid' } };

  const { rows: [slot] } = await db.query(
    'SELECT start_at <= clock_timestamp() AS started FROM slots WHERE id = $1',
    [slot_id]
  );
  if (!slot) return { status: 404, body: { error: 'slot not found' } };
  if (slot.started) return { status: 400, body: { error: 'slot has already started' } };

  // If another request is booking this slot right now, Postgres makes this insert wait for it.
  // If that one commits, the unique index turns ours into a no-op and we report 409.
  const { rows: [booking] } = await db.query(
    `INSERT INTO bookings (id, slot_id, name, email, status)
     VALUES ($1, $2, $3, $4, 'confirmed')
     ON CONFLICT (slot_id) WHERE status = 'confirmed' DO NOTHING
     RETURNING *`,
    [`bk_${crypto.randomUUID()}`, slot_id, name, email]
  );
  if (!booking) return { status: 409, body: { error: 'slot is already booked' } };
  return { status: 201, body: toBooking(booking) };
}

router.post('/', async (req, res) => {
  const body = isObject(req.body) ? req.body : {};
  const idempotencyKey = req.get('Idempotency-Key') || null;
  const requestHash = sha256(canonical(body)).toString('hex');
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';

  let reply;
  try {
    reply = await withTransaction(async (db) => {
      if (idempotencyKey) {
        // Claim the key. A concurrent request with the same key blocks here until we commit,
        // then finds our stored response below instead of booking a second time.
        const claimed = await db.query(
          `INSERT INTO idempotency_keys (key, request_hash, status_code, response_body)
           VALUES ($1, $2, 0, 'null') ON CONFLICT (key) DO NOTHING`,
          [idempotencyKey, requestHash]
        );
        if (claimed.rowCount === 0) {
          const { rows: [previous] } = await db.query(
            'SELECT request_hash, status_code, response_body FROM idempotency_keys WHERE key = $1',
            [idempotencyKey]
          );
          if (!previous) throw new Reply(409, { error: 'request with this Idempotency-Key is in progress, retry' });
          if (previous.request_hash !== requestHash) {
            throw new Reply(422, { error: 'Idempotency-Key was already used with a different body' });
          }
          throw new Reply(previous.status_code, previous.response_body);
        }
      }

      if (email) {
        const wait = await recordAttempt(db, email);
        if (wait) {
          // Thrown, so the transaction rolls back and the key stays free to retry after the wait.
          throw new Reply(429, { error: 'too many booking attempts for this email, try again later' }, { 'Retry-After': String(wait) });
        }
      }

      const result = await book(db, body);
      if (idempotencyKey) {
        await db.query(
          'UPDATE idempotency_keys SET status_code = $2, response_body = $3 WHERE key = $1',
          [idempotencyKey, result.status, JSON.stringify(result.body)]
        );
      }
      return result;
    });
  } catch (err) {
    if (!(err instanceof Reply)) throw err;
    reply = err;
  }
  res.status(reply.status).set(reply.headers || {}).json(reply.body);
});

router.get('/', async (req, res) => {
  const { email, limit = '10', cursor } = req.query;
  if (!nonEmptyString(email)) return fail(res, 400, 'email is required');
  if (typeof limit !== 'string' || !/^\d+$/.test(limit) || +limit < 1 || +limit > 50) {
    return fail(res, 400, 'limit must be a whole number from 1 to 50');
  }
  let after = '0';
  if (cursor !== undefined) {
    after = typeof cursor === 'string' ? decodeCursor(cursor) : null;
    if (after === null) return fail(res, 400, 'cursor is not valid');
  }

  // Fetch one extra row to learn whether there's another page.
  const { rows } = await pool.query(
    'SELECT * FROM bookings WHERE email = $1 AND seq > $2 ORDER BY seq LIMIT $3',
    [email.trim().toLowerCase(), after, +limit + 1]
  );
  const page = rows.slice(0, +limit);
  res.json({
    bookings: page.map(toBooking),
    next_cursor: rows.length > page.length ? encodeCursor(page[page.length - 1].seq) : null,
  });
});

router.get('/:id', async (req, res) => {
  const { rows: [booking] } = await pool.query('SELECT * FROM bookings WHERE id = $1', [req.params.id]);
  if (!booking) return fail(res, 404, 'booking not found');
  res.json(toBooking(booking));
});

router.delete('/:id', async (req, res) => {
  // Conditional update, so two simultaneous cancels can't both succeed.
  const { rows: [cancelled] } = await pool.query(
    `UPDATE bookings SET status = 'cancelled' WHERE id = $1 AND status = 'confirmed' RETURNING *`,
    [req.params.id]
  );
  if (cancelled) return res.json(toBooking(cancelled));
  const { rowCount } = await pool.query('SELECT 1 FROM bookings WHERE id = $1', [req.params.id]);
  if (rowCount === 0) return fail(res, 404, 'booking not found');
  fail(res, 409, 'booking is already cancelled');
});

module.exports = router;
