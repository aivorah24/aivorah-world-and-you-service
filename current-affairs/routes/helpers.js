const { normalizeAgeGroup, AGE_GROUP_NAMES } = require('../services/content');
const { normalizeEmail } = require('../middleware/auth');
const { isNotSetUp } = require('../services/db');

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

// Reads and validates ageGroup (required) and studentEmail (required or optional).
// Returns { ageGroup, email } or sends a 400 and returns null.
function readStudent(res, source, { emailRequired, ageGroupRequired = true }) {
  const ageGroup = normalizeAgeGroup(source.ageGroup);
  if (ageGroupRequired && !ageGroup) {
    res.status(400).json({ error: `ageGroup must be one of ${AGE_GROUP_NAMES.map((a) => `'${a}'`).join(', ')}` });
    return null;
  }
  const email = normalizeEmail(source.studentEmail);
  if (emailRequired && !email) {
    res.status(400).json({ error: 'studentEmail required' });
    return null;
  }
  if (email && !isEmail(email)) {
    res.status(400).json({ error: 'studentEmail is not a valid email' });
    return null;
  }
  return { ageGroup, email };
}

// Wraps an async handler so a thrown error becomes a JSON 500.
const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    console.error(`[current-affairs] ${req.method} ${req.originalUrl}:`, err.code || '', err.message);
    if (err.code === '23505') {
      // A unique key: in practice another story already uses this source link.
      return res.status(409).json({ error: 'Another story already uses this source link.' });
    }
    if (isNotSetUp(err)) {
      // The Current Affairs migration (aivorah-db 0023_current_affairs.sql) has not been run on this Supabase project.
      return res.status(503).json({
        error: 'Current Affairs is not ready yet. Please check back soon.',
        reason: 'database tables missing',
      });
    }
    res.status(500).json({ error: 'Could not load current affairs right now. Please try again.' });
  }
};

module.exports = { readStudent, handle };
