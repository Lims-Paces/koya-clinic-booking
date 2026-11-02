const express = require('express');
const { pool, withTransaction, insertSlots } = require('../db');
const { fail, isObject, nonEmptyString } = require('../lib/util');

const router = express.Router();

router.post('/reset', async (req, res) => {
  const slots = req.body?.slots;
  if (!Array.isArray(slots)) return fail(res, 400, 'slots must be an array');
  const ids = new Set();
  for (const s of slots) {
    if (!isObject(s) || !['id', 'provider', 'start', 'end'].every((f) => nonEmptyString(s[f]))) {
      return fail(res, 400, 'each slot needs id, provider, start and end');
    }
    if (Number.isNaN(Date.parse(s.start)) || Number.isNaN(Date.parse(s.end))) {
      return fail(res, 400, `slot ${s.id} has an invalid start or end`);
    }
    if (ids.has(s.id)) return fail(res, 400, `duplicate slot id ${s.id}`);
    ids.add(s.id);
  }

  await withTransaction(async (db) => {
    // Idempotency keys and rate-limit history refer to bookings that no longer exist, so they go too.
    await db.query('TRUNCATE bookings, slots, idempotency_keys, booking_attempts');
    await insertSlots(db, slots);
  });
  res.json({ slots: slots.length });
});

router.get('/slots', async (req, res) => {
  const provider = typeof req.query.provider === 'string' ? req.query.provider : null;
  const { rows } = await pool.query(
    `SELECT s.id, s.provider, s.start_text, s.end_text,
            NOT EXISTS (SELECT 1 FROM bookings b WHERE b.slot_id = s.id AND b.status = 'confirmed') AS available
       FROM slots s
      WHERE $1::text IS NULL OR s.provider = $1
      ORDER BY s.start_at, s.id`,
    [provider]
  );
  res.json({
    slots: rows.map((r) => ({ id: r.id, provider: r.provider, start: r.start_text, end: r.end_text, available: r.available })),
  });
});

module.exports = router;
