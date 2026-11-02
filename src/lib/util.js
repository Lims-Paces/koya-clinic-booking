const crypto = require('crypto');

const fail = (res, status, error) => res.status(status).json({ error });
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest();

// Same JSON whatever order the keys arrived in, so {"a":1,"b":2} and {"b":2,"a":1} count as the same body.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

module.exports = { fail, isObject, nonEmptyString, sha256, canonical };
