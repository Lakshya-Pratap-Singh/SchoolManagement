// Fee invoices, simulated payments and the ledger. Paid/outstanding are ALWAYS derived from payments rows.
const express = require('express');
const { requireRole } = require('../auth');
const { validate, audit, bad, notFound, forbidden, conflict, paginate, HttpError } = require('../util');
const { getStudentFor, invoiceWithBalance } = require('../access');

module.exports = (db) => {
  const r = express.Router();

  const loadInvoice = (user, id) => {
    const inv = db.prepare(`SELECT i.*, s.name AS student_name, s.guardian_id FROM invoices i JOIN students s ON s.id = i.student_id WHERE i.id = ?`).get(id);
    if (!inv) throw notFound('Invoice not found');
    if (user.role === 'ADMIN' ||
      (user.role === 'GUARDIAN' && inv.guardian_id === user.id) ||
      (user.role === 'STUDENT' && inv.student_id === user.student_id)) return inv;
    throw forbidden('You cannot access this invoice');
  };

  r.post('/invoices', requireRole('ADMIN'), (req, res) => {
    const v = validate(req.body, { student_id: 'int+', title: 'string', amount: 'int+', due_date: 'date' });
    getStudentFor(db, req.user, v.student_id); // 404 if the student does not exist
    const id = db.prepare('INSERT INTO invoices (student_id, title, amount, due_date) VALUES (?,?,?,?)')
      .run(v.student_id, v.title, v.amount, v.due_date).lastInsertRowid;
    audit(db, req.user, 'CREATE', 'invoices', id, v);
    res.status(201).json(invoiceWithBalance(db, loadInvoice(req.user, Number(id))));
  });

  r.get('/invoices', requireRole('ADMIN', 'GUARDIAN', 'STUDENT'), (req, res) => {
    const { page, limit, offset } = paginate(req.query);
    const where = [];
    const params = [];
    if (req.user.role === 'GUARDIAN') { where.push('s.guardian_id = ?'); params.push(req.user.id); }
    if (req.user.role === 'STUDENT') { where.push('s.id = ?'); params.push(req.user.student_id); }
    if (req.query.student_id) { where.push('i.student_id = ?'); params.push(Number(req.query.student_id)); }
    const outer = [];
    if (['PAID', 'PARTIAL', 'UNPAID'].includes(req.query.status)) { outer.push('status = ?'); params.push(req.query.status); }
    const inner = `SELECT i.*, s.name AS student_name,
        COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.invoice_id = i.id),0) AS paid
      FROM invoices i JOIN students s ON s.id = i.student_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
    const q = `SELECT *, amount - paid AS outstanding,
        CASE WHEN amount - paid = 0 THEN 'PAID' WHEN paid > 0 THEN 'PARTIAL' ELSE 'UNPAID' END AS status FROM (${inner})`;
    const wrapped = `SELECT * FROM (${q}) ${outer.length ? 'WHERE ' + outer.join(' AND ') : ''}`;
    const total = db.prepare(`SELECT COUNT(*) AS n FROM (${wrapped})`).get(...params).n;
    const data = db.prepare(`${wrapped} ORDER BY due_date DESC, id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    res.json({ data, page, limit, total });
  });

  r.get('/invoices/:id', requireRole('ADMIN', 'GUARDIAN', 'STUDENT'), (req, res) => {
    const inv = loadInvoice(req.user, Number(req.params.id));
    const ledger = db.prepare('SELECT id, amount, method, paid_at FROM payments WHERE invoice_id = ? ORDER BY id').all(inv.id);
    res.json({ ...invoiceWithBalance(db, inv), ledger });
  });

  // Simulated payment. Safe against duplicate clicks/retries (idempotency_key), overpayment and paying a closed invoice.
  r.post('/invoices/:id/payments', requireRole('ADMIN', 'GUARDIAN'), (req, res) => {
    const inv = loadInvoice(req.user, Number(req.params.id));
    const v = validate(req.body, { amount: 'int+' });
    const key = req.body.idempotency_key;
    if (typeof key !== 'string' || key.length < 8 || key.length > 100) throw bad('Validation failed', { idempotency_key: 'string of 8-100 chars required' });

    const result = db.transaction(() => { // IMMEDIATE lock: check + insert cannot interleave with another payment
      const prior = db.prepare('SELECT * FROM payments WHERE idempotency_key = ?').get(key);
      if (prior) {
        if (prior.invoice_id !== inv.id || prior.amount !== v.amount) throw conflict('idempotency_key was already used for a different payment');
        return { replay: true, payment: prior };
      }
      const { outstanding } = invoiceWithBalance(db, inv);
      if (outstanding === 0) throw new HttpError(409, 'Invoice is already fully paid');
      if (v.amount > outstanding) throw bad(`Overpayment rejected: only ${outstanding} is outstanding`);
      const id = db.prepare('INSERT INTO payments (invoice_id, amount, idempotency_key, paid_by) VALUES (?,?,?,?)')
        .run(inv.id, v.amount, key, req.user.id).lastInsertRowid;
      audit(db, req.user, 'PAYMENT', 'invoices', inv.id, { amount: v.amount, payment_id: Number(id) });
      return { replay: false, payment: db.prepare('SELECT * FROM payments WHERE id = ?').get(id) };
    }).immediate();

    res.status(result.replay ? 200 : 201).json({ payment: result.payment, invoice: invoiceWithBalance(db, inv), replayed: result.replay });
  });

  return r;
};
