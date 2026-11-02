const RATE_LIMIT = 5; // booking attempts per email...
const RATE_WINDOW_SECONDS = 60; // ...per this many seconds

// Counts this attempt against the email's limit. Returns 0 if allowed, otherwise seconds to wait.
// The advisory lock serialises attempts for one email, so concurrent requests can't all slip under the limit.
async function recordAttempt(db, email) {
  await db.query('SELECT pg_advisory_xact_lock(1, hashtext($1))', [email]);
  await db.query(
    `DELETE FROM booking_attempts WHERE email = $1 AND at <= clock_timestamp() - make_interval(secs => $2)`,
    [email, RATE_WINDOW_SECONDS]
  );
  const { rows: [window] } = await db.query(
    `SELECT count(*)::int AS attempts,
            ceil(extract(epoch FROM min(at) + make_interval(secs => $2) - clock_timestamp()))::int AS wait
       FROM booking_attempts WHERE email = $1`,
    [email, RATE_WINDOW_SECONDS]
  );
  if (window.attempts >= RATE_LIMIT) return Math.max(1, window.wait);
  await db.query('INSERT INTO booking_attempts (email) VALUES ($1)', [email]);
  return 0;
}

module.exports = { recordAttempt };
