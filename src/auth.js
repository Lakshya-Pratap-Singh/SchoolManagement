const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { HttpError, forbidden } = require('./util');

const secret = () => process.env.JWT_SECRET || 'dev-only-secret-change-me';

const sign = (u) => jwt.sign({ id: u.id, role: u.role }, secret(), { expiresIn: '8h' });

// Verifies the token, then re-loads the user so deleted users lose access immediately.
function authenticate(db) {
  return (req, _res, next) => {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) return next(new HttpError(401, 'Authentication required'));
    try {
      const { id, role } = jwt.verify(h.slice(7), secret());
      if (role === 'STUDENT') {
        const student = db.prepare(`
          SELECT s.id, s.id AS student_id, s.name, a.email, 'STUDENT' AS role
          FROM student_accounts a JOIN students s ON s.id = a.student_id
          WHERE a.student_id = ?`).get(id);
        if (!student) return next(new HttpError(401, 'Student account no longer exists'));
        req.user = student;
        return next();
      }
      const user = db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(id);
      if (!user) return next(new HttpError(401, 'User no longer exists'));
      req.user = user;
      next();
    } catch {
      next(new HttpError(401, 'Invalid or expired token'));
    }
  };
}

// Server-side role gate. UI hiding buttons is only cosmetic.
const requireRole = (...roles) => (req, _res, next) =>
  roles.includes(req.user.role) ? next() : next(forbidden('Your role cannot do this'));

module.exports = { sign, authenticate, requireRole, hash: (p) => bcrypt.hashSync(p, 10), compare: bcrypt.compareSync };
