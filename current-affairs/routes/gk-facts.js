// GK Facts routes — "The World & You" menu feature
// Date lookup, semantic search, quiz generation. No auth required (public GK data).

const express = require('express');
const gk = require('../services/gk-facts');
const { localDate } = require('../services/content');
const { handle } = require('./helpers');

const router = express.Router();

// ── GET /current-affairs/gk/today ───────────────────────────────────────────
// Events for today (Asia/Kolkata).
router.get('/today', handle(async (_req, res) => {
  const today = localDate(); // YYYY-MM-DD; getEventsForDate accepts it as-is
  const events = gk.getEventsForDate(today);
  res.json({
    date: today,
    events,
    count: events.length,
  });
}));

// ── GET /current-affairs/gk/date?date=MM-DD ─────────────────────────────────
// Events for a specific date.
router.get('/date', handle(async (req, res) => {
  const date = req.query.date;
  if (!date) return res.status(400).json({ error: 'Missing date parameter (format: MM-DD or YYYY-MM-DD)' });
  const events = gk.getEventsForDate(date);
  res.json({
    date,
    events,
    count: events.length,
  });
}));

// ── GET /current-affairs/gk/event?name=... ──────────────────────────────────
// Full details for an event by name (partial match).
router.get('/event', handle(async (req, res) => {
  const name = req.query.name;
  if (!name) return res.status(400).json({ error: 'Missing name parameter' });
  const event = gk.getEventDetails(name);
  if (!event) return res.status(404).json({ error: `Event not found: ${name}` });
  res.json(event);
}));

// ── GET /current-affairs/gk/search?q=... ────────────────────────────────────
// Semantic search by topic.
router.get('/search', handle(async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'Missing q parameter' });
  const topK = Math.min(10, Math.max(1, parseInt(req.query.top_k, 10) || 5));
  const results = gk.semanticSearch(q, topK);
  res.json({
    query: q,
    results,
    count: results.length,
  });
}));

// ── GET /current-affairs/gk/quiz?date=MM-DD ─────────────────────────────────
// Quiz questions for events on a date.
router.get('/quiz', handle(async (req, res) => {
  const date = req.query.date;
  if (!date) return res.status(400).json({ error: 'Missing date parameter (format: MM-DD)' });
  const numQ = Math.min(10, Math.max(1, parseInt(req.query.num, 10) || 3));
  const questions = gk.generateQuizForDate(date, numQ);
  res.json({
    date,
    questions,
    count: questions.filter((q) => !q.error).length,
  });
}));

// ── GET /current-affairs/gk/upcoming?days=7 ─────────────────────────────────
// Upcoming events for the next N days.
router.get('/upcoming', handle(async (req, res) => {
  const days = Math.min(30, Math.max(1, parseInt(req.query.days, 10) || 7));
  const events = gk.getUpcomingEvents(days);
  res.json({
    daysAhead: days,
    events,
    count: events.length,
  });
}));

// ── GET /current-affairs/gk/calendar?month=1 ────────────────────────────────
// All events for a month (1-12).
router.get('/calendar', handle(async (req, res) => {
  const month = parseInt(req.query.month, 10);
  if (isNaN(month) || month < 1 || month > 12) {
    return res.status(400).json({ error: 'Missing or invalid month parameter (1-12)' });
  }
  const events = gk.getEventsForMonth(month);
  res.json({
    month,
    events,
    count: events.length,
  });
}));

module.exports = router;
