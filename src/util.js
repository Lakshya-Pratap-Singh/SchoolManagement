// Small shared helpers: errors, validation, pagination, audit log.
class HttpError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}
const bad = (m, d) => new HttpError(400, m, d);
const forbidden = (m = 'Forbidden') => new HttpError(403, m);
const notFound = (m = 'Not found') => new HttpError(404, m);
const conflict = (m) => new HttpError(409, m);

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

// Tiny validator: rules = { field: 'string' | 'int+' | 'date' | 'email' | [allowed values] }
function validate(body, rules) {
  const errors = {};
  const out = {};
  for (const [field, rule] of Object.entries(rules)) {
    const v = body?.[field];
    let ok = false;
    if (rule === 'string') ok = typeof v === 'string' && v.trim().length > 0 && v.length <= 200;
    else if (rule === 'int+') ok = Number.isInteger(v) && v > 0;
    else if (rule === 'date') ok = isDate(v);
    else if (rule === 'email') ok = typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
    else if (Array.isArray(rule)) ok = rule.includes(v);
    if (!ok) errors[field] = 'invalid or missing';
    else out[field] = typeof v === 'string' ? v.trim() : v;
  }
  if (Object.keys(errors).length) throw bad('Validation failed', errors);
  return out;
}

function paginate(query) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 10));
  return { page, limit, offset: (page - 1) * limit };
}

function audit(db, actor, action, entity, entityId, details) {
  db.prepare('INSERT INTO audit_logs (actor_id, action, entity, entity_id, details) VALUES (?,?,?,?,?)')
    .run(actor?.id ?? null, action, entity, entityId ?? null, details ? JSON.stringify(details) : null);
}

module.exports = { HttpError, bad, forbidden, notFound, conflict, validate, paginate, audit, isDate };
