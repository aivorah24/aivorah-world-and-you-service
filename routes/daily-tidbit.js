const express  = require('express');
const router   = express.Router();
const supabase = require('../services/supabase');
const {
  computeLevel,
  getDailyTidbit,
  generateComprehensionQuiz,
} = require('../services/dailyTidbit');

// ── GET /daily-tidbit?grade=Grade 3&bust=1 ───────────────────────────
router.get('/', async (req, res) => {
  try {
    const { grade = 'Grade 3', bust } = req.query;
    const result = await getDailyTidbit(grade, bust);
    res.json(result);
  } catch (err) {
    console.error('daily-tidbit error:', err.message);
    res.status(500).json({ error: 'Could not fetch daily tidbit. Please try again.' });
  }
});

// ── POST /daily-tidbit/quiz ──────────────────────────────────────────
// Generate 2 MCQ comprehension questions from a current affairs article
router.post('/quiz', async (req, res) => {
  const { headline, summary, grade = 'Grade 3' } = req.body;
  if (!headline || !summary) return res.status(400).json({ error: 'headline and summary required' });

  try {
    const questions = await generateComprehensionQuiz({ headline, summary, grade });
    res.json({ questions });
  } catch (e) {
    console.error('[daily-tidbit/quiz]', e.message);
    res.status(500).json({ error: 'Could not generate quiz. Please try again.' });
  }
});

// ── POST /daily-tidbit/quiz-complete ─────────────────────────────────
// Award XP after student completes the comprehension quiz
router.post('/quiz-complete', async (req, res) => {
  const { studentId, correct = 0 } = req.body;
  const xpAwarded = correct * 10; // 10 XP per correct answer

  if (!studentId || xpAwarded === 0) return res.json({ xpAwarded: 0 });

  try {
    const { data: stats } = await supabase
      .from('student_stats')
      .select('*')
      .eq('student_id', studentId)
      .single();

    if (stats) {
      const newXP = (stats.xp_points || 0) + xpAwarded;
      await supabase.from('student_stats').update({
        xp_points:        newXP,
        today_xp:         (stats.today_xp || 0) + xpAwarded,
        level:            computeLevel(newXP),
        last_active_date: new Date().toISOString().split('T')[0],
        updated_at:       new Date().toISOString(),
      }).eq('student_id', studentId);
    }
    res.json({ xpAwarded });
  } catch (e) {
    console.error('[daily-tidbit/quiz-complete]', e.message);
    res.json({ xpAwarded: 0 });
  }
});

module.exports = router;
