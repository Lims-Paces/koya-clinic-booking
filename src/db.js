const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Hosted Postgres (Neon, Supabase, Render) needs TLS; a local database usually doesn't.
  ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false },
  max: Number(process.env.PG_POOL_MAX || 5),
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS slots (
  id         text PRIMARY KEY,
  provider   text NOT NULL,
  start_text text NOT NULL,         -- returned exactly as it was sent to /reset
  end_text   text NOT NULL,
  start_at   timestamptz NOT NULL   -- used for ordering and the "already started" check
);

CREATE TABLE IF NOT EXISTS bookings (
  seq        bigserial PRIMARY KEY, -- insertion order, used for "oldest first" and cursors
  id         text NOT NULL UNIQUE,
  slot_id    text NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  name       text NOT NULL,
  email      text NOT NULL,
  status     text NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- The double-booking guarantee: Postgres refuses a second confirmed booking for a slot,
-- however many requests arrive at once. Cancelled bookings don't count, so a cancelled slot frees up.
CREATE UNIQUE INDEX IF NOT EXISTS one_confirmed_booking_per_slot
  ON bookings (slot_id) WHERE status = 'confirmed';

CREATE INDEX IF NOT EXISTS bookings_by_email ON bookings (email, seq);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key           text PRIMARY KEY,
  request_hash  text NOT NULL,
  status_code   integer NOT NULL,
  response_body jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS booking_attempts (
  email text NOT NULL,
  at    timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS booking_attempts_by_email ON booking_attempts (email, at);
`;

// Demo slots so the web page has something to show on a fresh database.
function demoSlots() {
  const providers = ['Dr Ade', 'Dr Bello', 'Dr Chukwu'];
  const slots = [];
  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);
  for (let d = 1; d <= 5; d++) {
    for (const [i, provider] of providers.entries()) {
      for (const hour of [9, 11, 14]) {
        const start = new Date(day.getTime() + d * 864e5 + (hour + i) * 36e5);
        const end = new Date(start.getTime() + 30 * 6e4);
        slots.push({
          id: `d${d}-${i}-${hour}`,
          provider,
          start: start.toISOString().replace('.000Z', 'Z'),
          end: end.toISOString().replace('.000Z', 'Z'),
        });
      }
    }
  }
  return slots;
}

// One round trip however many slots there are.
async function insertSlots(client, slots) {
  await client.query(
    `INSERT INTO slots (id, provider, start_text, end_text, start_at)
     SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::timestamptz[])`,
    [
      slots.map((s) => s.id),
      slots.map((s) => s.provider),
      slots.map((s) => s.start),
      slots.map((s) => s.end),
      slots.map((s) => new Date(s.start)),
    ]
  );
}

let ready;

// The last object SCHEMA creates; if it exists, the schema is fully in place.
const schemaExists = async (db) =>
  (await db.query(`SELECT to_regclass('public.booking_attempts_by_email') IS NOT NULL AS ok`)).rows[0].ok;

// Creates the tables once per process, and only if they're missing. This matters on serverless, where
// every cold start runs it: even CREATE INDEX IF NOT EXISTS locks its table, and doing that while
// bookings are in flight deadlocks them. The read-only check takes no locks.
// The advisory lock stops two cold starts on a fresh database racing on CREATE.
function ensureSchema() {
  ready ??= (async () => {
    if (await schemaExists(pool)) return;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(4242)');
      if (await schemaExists(client)) {
        await client.query('COMMIT');
        return;
      }
      await client.query(SCHEMA);
      const { rows } = await client.query('SELECT count(*)::int AS n FROM slots');
      if (rows[0].n === 0) await insertSlots(client, demoSlots());
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      ready = undefined;
      throw err;
    } finally {
      client.release();
    }
  })();
  return ready;
}

// Postgres aborts a transaction to break a deadlock (40P01) or a serialization conflict (40001).
// Everything it did was rolled back, so running it again from the start is safe.
const RETRYABLE = new Set(['40P01', '40001']);
const MAX_ATTEMPTS = 3;

async function withTransaction(fn) {
  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (!RETRYABLE.has(err.code) || attempt === MAX_ATTEMPTS) throw err;
    } finally {
      client.release();
    }
    await new Promise((resolve) => setTimeout(resolve, 10 + Math.random() * 40 * attempt));
  }
}

module.exports = { pool, ensureSchema, withTransaction, insertSlots };
