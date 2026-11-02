// Lets the page (or any other origin) call the API from a browser.
function cors(req, res, next) {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, Idempotency-Key',
    'Access-Control-Expose-Headers': 'Retry-After',
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

module.exports = cors;
