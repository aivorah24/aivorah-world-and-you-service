const Groq  = require('groq-sdk');
const axios = require('axios');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

function computeLevel(xp) {
  let level = 1, threshold = 500, total = 0;
  while (xp >= total + threshold) { total += threshold; threshold += 250; level++; }
  return level;
}

// ── In-memory daily cache: key = `${grade}_YYYY-MM-DD` ──────────────
const cache = {};

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function cacheKey(grade) {
  return `${grade}_${todayStr()}`;
}

// ── Age instructions per grade ───────────────────────────────────────
const AGE_RULES = {
  'Grade 3': 'The student is age 8-9. Use very simple words. Maximum 2 short sentences. Fun and exciting tone.',
  'Grade 4': 'The student is age 9-10. Use clear simple language. 2 sentences with one interesting detail.',
  'Grade 5': 'The student is age 10-11. Clear language, slightly more detail allowed. 2-3 sentences.',
};
function ageRule(grade) {
  return AGE_RULES[grade] || AGE_RULES['Grade 3'];
}

// ── GK Fact via Groq ─────────────────────────────────────────────────
const GK_CATEGORIES = ['Geography', 'Science & Nature', 'Human Body', 'Indian History & Culture', 'Space & Universe', 'Animals', 'Technology', 'Amazing World Records'];

async function generateGKFact(grade) {
  const category = GK_CATEGORIES[new Date().getDate() % GK_CATEGORIES.length];
  const rules    = ageRule(grade);

  const resp = await groq.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    messages: [
      {
        role: 'system',
        content: `You are a fun knowledge tutor for kids. ${rules}
Category today: ${category}.
Generate 1 surprising, educational GK fact. Be enthusiastic.
Respond ONLY with valid JSON — no markdown, no extra text:
{"fact": "...", "category": "${category}"}`,
      },
      { role: 'user', content: `GK fact for ${grade} — category: ${category}` },
    ],
    temperature: 0.85,
    max_tokens: 160,
  });

  const raw = resp.choices[0].message.content.trim();
  try {
    const clean = raw.replace(/```json\n?/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(clean);
    // Unwrap nested JSON if AI returned fact as a stringified object
    let fact = parsed.fact || '';
    while (typeof fact === 'string' && fact.trim().startsWith('{')) {
      try { const inner = JSON.parse(fact); fact = inner.fact || fact; break; }
      catch { break; }
    }
    return { fact, category: parsed.category || category };
  } catch {
    // raw might itself be a JSON string — try to extract fact
    try {
      const fallback = JSON.parse(raw);
      return { fact: fallback.fact || raw, category: fallback.category || category };
    } catch {}
    return { fact: raw, category };
  }
}

// ── Grade-specific NewsAPI config ───────────────────────────────────
const GRADE_NEWS_CONFIG = {
  'Grade 3': {
    category: 'science',
    focusHint: 'animals, nature, space discoveries, or cute/fun science',
    audienceHint: 'The student is age 8-9. They love animals, nature, and space. Pick the most exciting nature or animal story.',
  },
  'Grade 4': {
    category: 'health',
    focusHint: 'human body, medicine, environment, or health discoveries',
    audienceHint: 'The student is age 9-10. They are curious about the human body, health, and the environment.',
  },
  'Grade 5': {
    category: 'technology',
    focusHint: 'technology, AI, inventions, world events, or innovation',
    audienceHint: 'The student is age 10-11. They are ready for technology news, global events, and scientific breakthroughs.',
  },
};

function gradeNewsConfig(grade) {
  return GRADE_NEWS_CONFIG[grade] || GRADE_NEWS_CONFIG['Grade 3'];
}

// ── Current Affairs via NewsAPI → Groq simplifier ────────────────────
async function fetchCurrentAffairs(grade) {
  const NEWS_API_KEY = process.env.NEWS_API_KEY;

  if (!NEWS_API_KEY || NEWS_API_KEY === 'YOUR_NEWS_API_KEY') {
    return generateCurrentAffairsFallback(grade);
  }

  const { category, audienceHint } = gradeNewsConfig(grade);

  try {
    const resp = await axios.get('https://newsapi.org/v2/top-headlines', {
      params: {
        category,
        pageSize: 10,
        apiKey:   NEWS_API_KEY,
      },
      timeout: 6000,
    });

    // Filter out gaming, entertainment, sports articles — not suitable for education
    const EXCLUDE_KEYWORDS = ['pokemon', 'nintendo', 'game', 'xbox', 'playstation', 'esport', 'anime', 'manga', 'movie', 'celebrity', 'kardashian', 'football', 'cricket', 'ipl'];
    const articles = (resp.data.articles || []).filter(a => {
      if (!a.title || !a.description || a.title.includes('[Removed]')) return false;
      const lower = a.title.toLowerCase();
      return !EXCLUDE_KEYWORDS.some(kw => lower.includes(kw));
    });
    if (articles.length === 0) return generateCurrentAffairsFallback(grade);

    // Pick the most relevant article for this grade using Groq
    const rules = ageRule(grade);
    const articleList = articles.slice(0, 5).map((a, i) => `${i + 1}. ${a.title}`).join('\n');

    const pickResp = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [
        {
          role: 'system',
          content: `${audienceHint} Pick the single most interesting and age-appropriate article number from this list. Reply ONLY with the number (e.g. "2").`,
        },
        { role: 'user', content: articleList },
      ],
      temperature: 0.2,
      max_tokens: 5,
    });

    const pickedIdx = parseInt(pickResp.choices[0].message.content.trim()) - 1;
    const article   = articles[Math.max(0, Math.min(pickedIdx || 0, articles.length - 1))];

    const simplified = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [
        {
          role: 'system',
          content: `You simplify news for kids. ${rules} ${audienceHint}
Rewrite in friendly, positive, educational language.
Respond ONLY with valid JSON — no markdown:
{"headline": "short kid-friendly title (max 8 words)", "summary": "2 simple sentences"}`,
        },
        {
          role: 'user',
          content: `Title: ${article.title}\nDescription: ${article.description}`,
        },
      ],
      temperature: 0.3,
      max_tokens: 160,
    });

    const raw = simplified.choices[0].message.content.trim();
    try {
      const clean = raw.replace(/```json\n?/g, '').replace(/```/g, '').trim();
      return { ...JSON.parse(clean), newsCategory: category };
    } catch {
      return { headline: article.title, summary: article.description, newsCategory: category };
    }
  } catch {
    return generateCurrentAffairsFallback(grade);
  }
}

// ── Fallback: Groq generates a recent-events style current affair ────
async function generateCurrentAffairsFallback(grade) {
  const rules = ageRule(grade);

  const resp = await groq.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    messages: [
      {
        role: 'system',
        content: `You are a news tutor for kids. ${rules}
Share one positive, interesting world news event or scientific discovery from 2023-2024.
Respond ONLY with valid JSON — no markdown:
{"headline": "short title (max 8 words)", "summary": "2 simple sentences"}`,
      },
      { role: 'user', content: `Current affairs tidbit for ${grade} students.` },
    ],
    temperature: 0.75,
    max_tokens: 160,
  });

  const raw = resp.choices[0].message.content.trim();
  try {
    const clean = raw.replace(/```json\n?/g, '').replace(/```/g, '').trim();
    return JSON.parse(clean);
  } catch {
    return { headline: 'World Update', summary: raw };
  }
}

// ── Sanitize helper — unwrap nested JSON in fact string ──────────────
function sanitizeGK(gk) {
  if (!gk) return gk;
  let fact = gk.fact;
  if (typeof fact === 'string' && fact.trim().startsWith('{')) {
    try { const inner = JSON.parse(fact); fact = inner.fact || fact; } catch {}
  }
  return { ...gk, fact };
}

async function getDailyTidbit(grade, bust) {
  const key = cacheKey(grade);

  if (cache[key] && !bust) {
    return { ...cache[key], gk: sanitizeGK(cache[key].gk), cached: true };
  }

  const [gkRaw, currentAffairs] = await Promise.all([
    generateGKFact(grade),
    fetchCurrentAffairs(grade),
  ]);

  const result = {
    grade,
    date: todayStr(),
    gk: sanitizeGK(gkRaw),
    currentAffairs,
  };

  cache[key] = result;
  return result;
}

// ── Option cleaner helper for quiz options ───────────────────────────
function normalizeQuizQuestions(questions) {
  if (!Array.isArray(questions)) return [];
  const LETTER_MAP = { A: 0, B: 1, C: 2, D: 3 };
  return questions.map(q => {
    if (!q || typeof q !== 'object') return q;
    let opts = Array.isArray(q.options) ? q.options.map(o => typeof o === 'string' ? o : (o?.label || String(o || ''))) : [];
    let correct = typeof q.correct === 'number' ? q.correct : (LETTER_MAP[String(q.correct || '').toUpperCase()] ?? 0);

    // If options array has 6 or 8 items and even indices are just letter badges ("A", "B", "C", "D", "a)", "[A]"), extract the odd indices
    if (opts.length === 6 || opts.length === 8) {
      const allEvenLetters = opts.every((opt, i) => {
        if (i % 2 !== 0) return true;
        const s = String(opt || '').trim();
        return /^[A-Da-d0-4][.)\]]?$/.test(s) || /^\[[A-Da-d0-4]\]$/.test(s);
      });
      if (allEvenLetters) {
        const extracted = [];
        for (let i = 1; i < opts.length; i += 2) {
          extracted.push(opts[i]);
        }
        opts = extracted;
        if (correct >= opts.length) correct = Math.floor(correct / 2);
      }
    }

    // Strip leading prefixes like "A. ", "a) ", "A - ", "[A] ", "1. " from option strings.
    // The separator (bracket-close, punctuation, or whitespace) after the
    // letter/digit is REQUIRED, not optional - the previous version made
    // every part after the leading char optional, so it also matched (and
    // corrupted) real option text that simply started with a letter A-D
    // followed directly by more letters, e.g. "Big bruise" -> "ig bruise"
    // (confirmed via a live quiz response - the letter/digit alone is not
    // a real prefix unless something actually separates it from the rest).
    const cleaned = opts.map(opt => String(opt || '').replace(/^\[?[A-Da-d0-4]\]?(?:[.)\-:]\s*|\s+)/, '').trim()).filter(Boolean);

    return {
      ...q,
      question: q.question || '',
      options: cleaned.length > 0 ? cleaned : opts,
      correct: Math.min(Math.max(0, correct), Math.max(0, (cleaned.length || opts.length) - 1)),
    };
  });
}

async function generateComprehensionQuiz({ headline, summary, grade = 'Grade 3' }) {
  const rules = ageRule(grade);
  const resp = await groq.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    messages: [
      {
        role: 'system',
        content: `You are a quiz maker for kids. ${rules}
Based on the news article, create exactly 2 multiple-choice questions to test reading comprehension.
Each question must have 4 short options with exactly one correct answer.
Respond ONLY with a valid JSON array — no markdown, no explanation:
[{"question":"...","options":["First choice","Second choice","Third choice","Fourth choice"],"correct":0},{"question":"...","options":["First choice","Second choice","Third choice","Fourth choice"],"correct":2}]
(correct is the 0-based index of the right option)`,
      },
      { role: 'user', content: `Article headline: ${headline}\nSummary: ${summary}` },
    ],
    temperature: 0.4,
    max_tokens: 400,
  });

  const raw   = resp.choices[0].message.content.trim();
  const clean = raw.replace(/```json\n?/g, '').replace(/```/g, '').trim();
  return normalizeQuizQuestions(JSON.parse(clean));
}

module.exports = {
  computeLevel,
  getDailyTidbit,
  generateComprehensionQuiz,
  normalizeQuizQuestions,
};
