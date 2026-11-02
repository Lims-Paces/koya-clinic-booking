const { fail } = require('../lib/util');

function notFound(req, res) {
  fail(res, 404, 'not found');
}

// Express 5 sends errors thrown by async handlers here, so every failure still answers {"error": "..."}.
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err.type === 'entity.parse.failed') return fail(res, 400, 'request body is not valid JSON');
  if (err.type === 'entity.too.large') return fail(res, 413, 'request body is too large');
  console.error(err);
  fail(res, 500, 'internal error');
}

module.exports = { notFound, errorHandler };
