const Groq  = require('groq-sdk');
const axios = require('axios');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Simple in-memory cache — one entry per date+grade
const cache = {};

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

// ── Grade → age mapping for age-appropriate content ─────────────────
// Previously stopped at Grade 9 — any higher grade (10/11/12, i.e. every IB
// DP / CBSE Std XI-XII / Cambridge A-Level student) silently fell back to
// GRADE_INFO['Grade 3'] (age 8-9, "fun facts... exciting tone"). That's the
// confirmed root cause of Grade 11 students getting Grade-3-level "if you
// have 3 apples" content — not a model/prompt issue, a missing lookup entry.
const GRADE_INFO = {
  'Grade 1': { age: '6-7',  tone: 'very simple, short sentences, familiar topics like animals and colors' },
  'Grade 2': { age: '7-8',  tone: 'simple language, relatable everyday examples' },
  'Grade 3': { age: '8-9',  tone: 'curious explorers, fun facts, vivid descriptions, exciting tone' },
  'Grade 4': { age: '9-10', tone: 'more detail, comparisons, slightly complex ideas' },
  'Grade 5': { age: '10-11', tone: 'deeper explanations, cause-and-effect, broader world view' },
  'Grade 6': { age: '11-12', tone: 'analytical thinking, global awareness, scientific reasoning' },
  'Grade 7': { age: '12-13', tone: 'critical thinking, connecting concepts across subjects' },
  'Grade 8': { age: '13-14', tone: 'mature reasoning, real-world applications, nuanced understanding' },
  'Grade 9': { age: '14-15', tone: 'advanced concepts, current global issues, research-style' },
  'Grade 10': { age: '15-16', tone: 'exam-level rigor, structured analytical reasoning, board/IGCSE-appropriate depth' },
  'Grade 11': { age: '16-17', tone: 'pre-university complexity, genuine critical analysis, IB DP / Std XI depth — never simplify to primary-school level' },
  'Grade 12': { age: '17-18', tone: 'university-preparatory, sophisticated cross-disciplinary reasoning, IB DP / Std XII depth — never simplify to primary-school level' },
};

function gradeInfo(grade) {
  return GRADE_INFO[grade] || GRADE_INFO['Grade 3'];
}

// ── Fun Challenge difficulty guidance per grade band ─────────────────
// Reinforces GRADE_INFO's age/tone with a concrete difficulty bar, since
// "appropriate for age X" alone wasn't enough to stop the model from
// defaulting to trivial arithmetic once the age itself was correct.
function challengeDifficultyHint(grade) {
  const n = parseInt(String(grade).replace(/\D/g, ''), 10) || 3;
  if (n <= 2)  return 'Keep it to single-digit counting or simple shape/pattern recognition.';
  if (n <= 5)  return 'A short logic or basic-math puzzle a curious primary-schooler can solve with a bit of thought — not trivial single-step arithmetic.';
  if (n <= 8)  return 'A genuine multi-step logic, ratio, or pattern puzzle requiring real reasoning, not a one-line sum.';
  return 'A genuinely challenging puzzle requiring multi-step reasoning, real-world application, or subject-level thinking appropriate for a pre-university student — nothing that would look out of place in a competition/olympiad warm-up.';
}

// ── Grade-specific NewsAPI config ───────────────────────────────────
const GRADE_NEWS = {
  'Grade 1': { category: 'science', focus: 'animals, nature, colorful discoveries' },
  'Grade 2': { category: 'science', focus: 'animals, nature, fun experiments' },
  'Grade 3': { category: 'science', focus: 'animals, nature, space discoveries' },
  'Grade 4': { category: 'health',  focus: 'human body, environment, health discoveries' },
  'Grade 5': { category: 'technology', focus: 'technology, AI, inventions, innovation' },
  'Grade 6': { category: 'technology', focus: 'technology, science breakthroughs, environment' },
  'Grade 7': { category: 'science', focus: 'science, global events, engineering' },
  'Grade 8': { category: 'technology', focus: 'technology, world affairs, innovation' },
  'Grade 9': { category: 'science', focus: 'research, global issues, scientific method' },
  'Grade 10': { category: 'science', focus: 'exam-relevant science, world affairs, technology trends' },
  'Grade 11': { category: 'science', focus: 'in-depth global issues, research, policy, and technology — IB DP / Std XI level' },
  'Grade 12': { category: 'science', focus: 'in-depth global issues, research, policy, and technology — IB DP / Std XII level' },
};

function gradeNews(grade) {
  return GRADE_NEWS[grade] || GRADE_NEWS['Grade 3'];
}

// ── Fetch current affairs from NewsAPI → simplify with Groq ─────────
async function fetchCurrentAffairs(grade) {
  const NEWS_API_KEY = process.env.NEWS_API_KEY;
  const info = gradeInfo(grade);
  const news = gradeNews(grade);

  // Fallback if no API key
  if (!NEWS_API_KEY) return generateAffairsFallback(grade);

  try {
    const resp = await axios.get('https://newsapi.org/v2/top-headlines', {
      params: { category: news.category, pageSize: 10, apiKey: NEWS_API_KEY },
      timeout: 6000,
    });

    const EXCLUDE = ['pokemon','nintendo','game','xbox','playstation','esport','anime',
      'manga','movie','celebrity','kardashian','murder','kill','death','attack','war'];
    const articles = (resp.data.articles || []).filter(a => {
      if (!a.title || !a.description || a.title.includes('[Removed]')) return false;
      const lower = (a.title + ' ' + a.description).toLowerCase();
      return !EXCLUDE.some(kw => lower.includes(kw));
    });

    if (articles.length < 2) return generateAffairsFallback(grade);

    // Pick top 2 articles and simplify for kids
    const top = articles.slice(0, 4);
    const simplified = await groq.chat.completions.create({
      model: 'openai/gpt-oss-20b',
      messages: [{
        role: 'system',
        content: `You simplify news for ${grade} kids (age ${info.age}). ${info.tone}.
Rewrite these articles in friendly, positive, educational language.
Respond ONLY with valid JSON array — no markdown:
[{"headline":"short kid-friendly title","detail":"1-2 simple sentences"}]`,
      }, {
        role: 'user',
        content: top.map((a, i) => `${i+1}. ${a.title}: ${a.description}`).join('\n'),
      }],
      temperature: 0.3,
      max_tokens: 300,
      // See generateGroqContent() below for why: gpt-oss-20b can spiral into
      // a long internal reasoning loop on open-ended factual tasks. Applied
      // here too since it's the same model/risk, even though this call
      // already degrades gracefully via the catch below if it ever happens.
      reasoning_effort: 'low',
    });

    const raw = simplified.choices[0].message.content.trim();
    const clean = raw.replace(/```json\n?/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(clean);
    return Array.isArray(parsed) ? parsed.slice(0, 2) : [parsed];
  } catch {
    return generateAffairsFallback(grade);
  }
}

// ── Fallback: Groq generates current affairs ────────────────────────
async function generateAffairsFallback(grade) {
  const info = gradeInfo(grade);
  const resp = await groq.chat.completions.create({
    model: 'openai/gpt-oss-20b',
    messages: [{
      role: 'system',
      content: `You share positive world news for ${grade} kids (age ${info.age}). ${info.tone}.
Generate 2 recent positive world events or discoveries.
Respond ONLY with valid JSON — no markdown:
[{"headline":"...","detail":"..."},{"headline":"...","detail":"..."}]`,
    }, {
      role: 'user',
      content: `Current affairs for ${grade}`,
    }],
    temperature: 0.7,
    max_tokens: 250,
    reasoning_effort: 'low',
  });
  try {
    const raw = resp.choices[0].message.content.trim();
    const clean = raw.replace(/```json\n?/g, '').replace(/```/g, '').trim();
    return JSON.parse(clean);
  } catch {
    return [{ headline: 'World News', detail: 'Check back soon for today\'s top stories!' }];
  }
}

// ── Generate On This Day + GK Fact + Fun Challenge via Groq ─────────
async function generateGroqContent(grade) {
  const info  = gradeInfo(grade);
  const today = new Date();
  const month = today.toLocaleString('en-US', { month: 'long' });
  const day   = today.getDate();
  const year  = today.getFullYear();

  const GK_CATEGORIES = ['Science', 'Nature', 'Space', 'History', 'Geography', 'Animals'];
  const category = GK_CATEGORIES[today.getDate() % GK_CATEGORIES.length];

  const prompt = `You are Ms. Zara, a warm teacher for ${grade} students (age ${info.age}).
Today is ${month} ${day}, ${year}. Content style: ${info.tone}.

Generate:
1. **On This Day** — 3 REAL historically accurate events that happened specifically on ${month} ${day} (any past year). Mix science, culture, sports. Each 1-2 sentences appropriate for age ${info.age}. CRITICAL: these must be events that genuinely occurred on ${month} ${day} — think it through properly rather than reaching for the first date that comes to mind, and never reuse a stock example like the Moon landing or a Chicago fire unless it is itself a real ${month} ${day} event.
2. **GK Fact** — One amazing ${category} fact for a ${grade} student. Vivid, relatable.
3. **Fun Challenge** — One thinking question with answer, matched to ${grade} (age ${info.age}) difficulty — NOT a younger-grade-level question. ${challengeDifficultyHint(grade)} Do not mention any age or grade inside the question text itself — the difficulty should speak for itself.

Respond ONLY with valid JSON — no markdown, no backticks. The years and text below are ONLY placeholders showing the shape; replace every value with your own real, date-matched content — do not copy them:
{"onThisDay":[{"year":<real year>,"fact":"<real ${month} ${day} event>"},{"year":<real year>,"fact":"<real ${month} ${day} event>"},{"year":<real year>,"fact":"<real ${month} ${day} event>"}],"gkFact":{"title":"...","fact":"...","category":"${category}"},"funChallenge":{"question":"...","answer":"..."}}`;

  const resp = await groq.chat.completions.create({
    model: 'openai/gpt-oss-20b',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7,
    // gpt-oss-20b is a reasoning model with a SEPARATE `reasoning` field on
    // the response (not mixed into `content`) — so raising max_tokens alone
    // doesn't help when the model gets stuck. Confirmed directly against
    // Groq: this exact prompt ("give 3 REAL historically accurate events on
    // a specific date") sent it into a genuine reasoning loop — repeatedly
    // rejecting its own fact recall ("no... let's think again...") until it
    // hit finish_reason:"length" having spent 1998/2000 tokens thinking and
    // produced empty content. reasoning_effort:'low' caps that budget so it
    // commits to an answer instead of spiraling — confirmed via the same
    // direct test: finish_reason:"stop", valid JSON, 844 reasoning tokens.
    reasoning_effort: 'low',
    max_tokens: 2000,
  });

  const raw   = resp.choices[0].message.content.trim();
  const clean = raw.replace(/```json\n?/g, '').replace(/```/g, '').trim();
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in response');
  return JSON.parse(match[0]);
}

async function getWorldDaily(grade) {
  const key = `${todayKey()}_${grade}`;

  if (cache[key]) return cache[key];

  const [groqData, currentAffairs] = await Promise.all([
    generateGroqContent(grade),
    fetchCurrentAffairs(grade),
  ]);

  const today = new Date();
  const month = today.toLocaleString('en-US', { month: 'long' });
  const day   = today.getDate();

  const data = {
    date: `${month} ${day}`,
    grade,
    onThisDay:      groqData.onThisDay || [],
    gkFact:         groqData.gkFact || { title: 'Did You Know?', fact: 'Loading...', category: 'Science' },
    currentAffairs: currentAffairs || [],
    funChallenge:   groqData.funChallenge || { question: 'Think about it!', answer: 'Keep exploring!' },
  };

  cache[key] = data;
  return data;
}

module.exports = { getWorldDaily };
