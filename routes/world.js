/**
 * routes/world.js
 * "The World & You" — GK facts, On This Day, Current Affairs
 * Uses Groq LLM + NewsAPI for real, age-appropriate daily content
 */
const express = require('express');
const router  = express.Router();
const { getWorldDaily } = require('../services/world');

// GET /world/daily?grade=Grade 3
router.get('/daily', async (req, res) => {
  try {
    const grade = req.query.grade || 'Grade 3';
    const data  = await getWorldDaily(grade);
    res.json(data);
  } catch (err) {
    console.error('world/daily error:', err.message);
    res.status(500).json({ error: 'Could not generate daily content' });
  }
});

module.exports = router;
