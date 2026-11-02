const crypto = require('crypto');
const { fail, sha256 } = require('../lib/util');

const API_KEY = process.env.API_KEY;
if (!API_KEY) throw new Error('API_KEY is not set');

// Hashing both sides first gives equal-length buffers, so the comparison is constant-time.
function requireApiKey(req, res, next) {
  const given = req.get('X-API-Key');
  if (!given || !crypto.timingSafeEqual(sha256(given), sha256(API_KEY))) {
    return fail(res, 401, 'missing or invalid API key');
  }
  next();
}

module.exports = requireApiKey;
