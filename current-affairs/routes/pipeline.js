// Scheduled jobs (a Render Cron Job calls these). Protected by the
// x-pipeline-secret header, which must equal CA_PIPELINE_SECRET. The job runs
// in the background; the answer only says it started. The report goes to the
// server console (no secrets, no page text).
const crypto = require('crypto');
const express = require('express');
const supabase = require('../../services/supabase');
const daily = require('../pipeline/run');
const weekly = require('../pipeline/quizGen');
const { isDateString, quizWeekStart } = require('../services/content');

const router = express.Router();

function sameSecret(given, expected) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireSecret(req, res, next) {
  const expected = process.env.CA_PIPELINE_SECRET;
  if (!expected || !sameSecret(req.headers['x-pipeline-secret'], expected)) {
    return res.status(401).json({ error: 'Not allowed' });
  }
  return next();
}

// Starts `job` in the background and answers 202 with its run id.
function startInBackground(res, label, job) {
  const runId = crypto.randomUUID();
  setImmediate(async () => {
    try {
      const report = await job(runId);
      console.log(report.summary || JSON.stringify(report));
    } catch (err) {
      console.error(`[ca-pipeline] ${label} ${runId} failed:`, err.message);
    }
  });
  res.status(202).json({ runId, started: true });
}

// POST /current-affairs/pipeline/run: today's stories, saved for review only.
router.post('/run', requireSecret, (req, res) => {
  startInBackground(res, 'daily', async () => {
    const report = await daily.runDailyPipeline({ supabase });
    return { summary: daily.summarize(report) };
  });
});

// POST /current-affairs/pipeline/quiz { weekStart?: Sunday, force?: true }:
// the week's quiz for both age groups, saved for review only.
router.post('/quiz', requireSecret, (req, res) => {
  const { weekStart, force } = req.body || {};
  if (weekStart !== undefined && (!isDateString(weekStart) || quizWeekStart(weekStart) !== weekStart)) {
    return res.status(400).json({ error: 'weekStart must be a Sunday, YYYY-MM-DD' });
  }
  startInBackground(res, 'quiz', async () => {
    const report = await weekly.generateWeeklyQuiz({ supabase, weekStart, force: force === true });
    return { summary: weekly.summarizeQuiz(report) };
  });
});

module.exports = router;
module.exports.requireSecret = requireSecret;
module.exports.startInBackground = startInBackground;
