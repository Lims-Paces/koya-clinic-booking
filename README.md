# Clinic booking API

An API that lets patients book clinic appointment slots, plus a web page that uses it. Built to the [Koya assessment spec](https://koyaacademy.com/assessment-api).

**Stack:** Node.js, Express 5, PostgreSQL (plain SQL via `pg`). Deployed on Vercel (serverless functions) with a Neon Postgres database.

```
src/
  app.js              wires middleware and routes together
  db.js               connection pool, schema, transaction helper
  server.js           local entry point (npm start)
  routes/slots.js     POST /reset, GET /slots
  routes/bookings.js  booking, lookup, cancel, list (levels 1, 3, 4)
  lib/rateLimit.js    per-email attempt limit (level 5)
  lib/util.js         small shared helpers
  middleware/         API key check, CORS, JSON error responses
api/index.js          Vercel entry point
public/               the web page (plain HTML + JS)
test/api.test.js      end-to-end tests for every level
```

| | |
|---|---|
| API base URL | `https://koya-clinic-booking-phi.vercel.app` |
| Web page | [koya-clinic-booking-phi.vercel.app](https://koya-clinic-booking-phi.vercel.app) (same app, at `/`) |

## Endpoints

Every request needs an `X-API-Key` header. Errors always look like `{"error": "..."}`.

| Method | Path | What it does |
|---|---|---|
| `POST` | `/reset` | Delete every booking and replace all slots |
| `GET` | `/slots?provider=` | All slots, earliest first, each with `available` |
| `POST` | `/bookings` | Book a slot (optional `Idempotency-Key` header) |
| `GET` | `/bookings/:id` | Look up a booking |
| `DELETE` | `/bookings/:id` | Cancel a booking and free the slot |
| `GET` | `/bookings?email=&limit=&cursor=` | One person's bookings, oldest first, paged |

## How each level works

### Level 1: list, book, look up
Slots and bookings live in Postgres, so they survive across requests and serverless instances. A slot's `start` and `end` are stored exactly as they were sent and returned unchanged. A separate `timestamptz` column is kept for sorting and for the "already started" check.

### Level 2: API key and validation
Middleware checks `X-API-Key` before anything else runs. It compares the key in constant time, so the response time doesn't leak how much of a guess was right. A booking request is checked in this order: required fields, then email format (after trimming and lower-casing), then whether the slot exists (404), then whether it has already started (400).

### Level 3: no double booking, even at the same moment
Checking "is this slot free?" and then inserting leaves a gap: two requests can both see the slot as free and both insert. Instead the database enforces the rule:

```sql
CREATE UNIQUE INDEX one_confirmed_booking_per_slot ON bookings (slot_id) WHERE status = 'confirmed';
```

The insert uses `ON CONFLICT ... DO NOTHING`. When two requests race, Postgres makes the second wait until the first commits, then turns its insert into a no-op, which the API reports as 409. Cancelled bookings fall outside the index, so cancelling frees the slot. Cancelling is a single conditional `UPDATE ... WHERE status = 'confirmed'`, so two simultaneous cancels can't both succeed.

Tested with 100 simultaneous requests for one slot, 10 rounds: exactly one 201 and 99 × 409 every time.

### Level 4: idempotent retries and pagination
The first thing a booking transaction does is claim the `Idempotency-Key` by inserting it into a table where the key is the primary key. A concurrent retry with the same key blocks on that insert until the first request commits. It then reads the stored status code and body and returns them unchanged, so no second booking is created. The stored request hash is a SHA-256 of the body with its keys sorted, so key order doesn't matter. If the hash differs, the API returns 422. Error responses (400/404/409) are replayed too, so a retry always gets the same answer.

Pagination uses an opaque cursor that encodes the position of the last booking returned. Each booking has an auto-incrementing sequence number, which gives a strict "oldest first" order even when two bookings share a timestamp. Each page asks for `limit + 1` rows, and the extra row shows whether there's a next page. Unlike offset paging, a booking created mid-read can't make a page skip or repeat a row.

### Level 5: rate limiting
Each booking attempt for an email is recorded in Postgres, not in memory, because serverless instances don't share memory. A transaction-scoped advisory lock on the email makes concurrent attempts for one address take turns, so a burst can't slip past the limit. The 6th attempt within 60 seconds gets a 429. `Retry-After` is the number of seconds until the oldest attempt leaves the window. Failed attempts (400/404/409) count. Rejected attempts don't, so a client that waits `Retry-After` seconds is let back in. An idempotent replay isn't a new attempt, so it isn't counted.

### Web page
`public/` is a plain HTML/JS page served from the same origin. It asks for the API key once and keeps it in the browser's `localStorage`. The key isn't built into the page's JavaScript, because anyone can read that, and Level 2 would mean nothing. Each booking attempt sends a fresh `Idempotency-Key`. After a network error the page reuses the same key, so clicking "Confirm" again can't book twice.

## A bug that only showed up in production
Every test passed locally, but on Vercel a burst of simultaneous bookings returned a few 500s. Bookings were never doubled, but some requests that should have got 409 failed instead. The 500s only appeared once Vercel started extra instances to handle the burst. Each new instance ran the schema setup on its first request. `CREATE INDEX IF NOT EXISTS` locks its table even when the index already exists, and that lock formed a cycle with in-flight bookings: a deadlock (Postgres error `40P01`).

I reproduced it locally by running the schema SQL in a loop during a booking race (51 deadlocks), then fixed it in two ways:
1. **The cause:** a cold start first runs a read-only check that takes no locks, and skips setup entirely if the schema already exists.
2. **A backstop:** a transaction that Postgres aborts for a deadlock or serialization failure is retried, up to three times with jittered backoff. This is safe because the abort has already rolled everything back.

After the fix, the live site handled 10 rounds of 25 simultaneous bookings and 3 rounds of 100 with no errors and exactly one booking per slot.

## Trade-offs and what I'd do next
- **Per-email rate limiting only**, as the spec asks. A spammer can rotate email addresses, so in production I'd also limit per API key and per IP.
- **Idempotency keys are kept until the next `/reset`.** In production they'd expire after about 24 hours, deleted by a scheduled job.
- **`/reset` also clears idempotency keys and rate-limit history**, because both refer to bookings that no longer exist.
- **A single shared API key**, as the spec describes. Real clients would each get their own key, stored hashed.

## Running locally

```bash
docker run -d --name clinic-pg -e POSTGRES_PASSWORD=pg -e POSTGRES_DB=clinic -p 54329:5432 postgres:16-alpine
npm install
DATABASE_URL=postgres://postgres:pg@localhost:54329/clinic API_KEY=dev-key npm start
# in another terminal: end-to-end tests for every level (these call /reset, which wipes the data)
BASE_URL=http://localhost:3000 API_KEY=dev-key npm test
```

Tables are created automatically on the first request. A fresh database is seeded with demo slots for the next five days.

## Deploying (Vercel + Neon)
1. Create a free Neon project and copy its **pooled** connection string.
2. Import this repo into Vercel and set the `DATABASE_URL` and `API_KEY` environment variables.
3. Deploy. `vercel.json` sends every request that isn't a static file to the Express app in `api/index.js`.
