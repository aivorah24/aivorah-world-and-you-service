// GK Facts RAG Service — "The World & You" menu feature
// Date-based lookup, TF-IDF semantic search, and quiz question generation.
// Pure functions — no database access — loads events from data/gk-events.json.

const fs = require('fs');
const path = require('path');

const EVENTS_PATH = path.join(__dirname, '..', 'data', 'gk-events.json');

let eventsCache = null;

// Load events once (lazy init).
function loadEvents() {
  if (eventsCache) return eventsCache;
  const raw = fs.readFileSync(EVENTS_PATH, 'utf-8');
  eventsCache = JSON.parse(raw);
  return eventsCache;
}

// ── Date helpers ────────────────────────────────────────────────────────────
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];
const MONTH_NUM = MONTHS.reduce((acc, m, i) => { acc[m] = i + 1; return acc; }, {});

// Parse "MM-DD" or "YYYY-MM-DD" into { month, day } (1-indexed).
function parseDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  const parts = dateStr.split('-');
  let month, day;
  if (parts.length === 3) {
    [, month, day] = parts;
  } else if (parts.length === 2) {
    [month, day] = parts;
  } else {
    return null;
  }
  const m = parseInt(month, 10);
  const d = parseInt(day, 10);
  if (isNaN(m) || isNaN(d) || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return { month: m, day: d };
}

// Today's date in MM-DD (Asia/Kolkata).
function todayMMDD() {
  const now = new Date();
  const iso = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now);
  const [, m, d] = iso.split('-');
  return { month: parseInt(m, 10), day: parseInt(d, 10) };
}

// ── Core retrieval ──────────────────────────────────────────────────────────

// Get all events for a specific date (MM-DD or YYYY-MM-DD).
function getEventsForDate(dateStr) {
  const parsed = parseDate(dateStr);
  if (!parsed) return [];
  const { month, day } = parsed;
  return loadEvents().filter((e) => {
    const [em, ed] = e.date.split('-').map(Number);
    return em === month && ed === day;
  });
}

// Get events for today.
function getTodaysEvents() {
  const today = todayMMDD();
  return getEventsForDate(`${String(today.month).padStart(2, '0')}-${String(today.day).padStart(2, '0')}`);
}

// Get events for a month (1-12).
function getEventsForMonth(monthNum) {
  const m = parseInt(monthNum, 10);
  if (isNaN(m) || m < 1 || m > 12) return [];
  return loadEvents().filter((e) => parseInt(e.date.split('-')[0], 10) === m);
}

// Get events for the next N days from today.
function getUpcomingEvents(daysAhead = 7) {
  const today = todayMMDD();
  const results = [];
  const todayDate = new Date(2000, today.month - 1, today.day);
  for (let i = 0; i <= daysAhead; i++) {
    const d = new Date(todayDate);
    d.setDate(d.getDate() + i);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const dateStr = `${mm}-${dd}`;
    const events = getEventsForDate(dateStr);
    for (const e of events) {
      results.push({ ...e, daysFromToday: i });
    }
  }
  return results;
}

// Get full details for an event by name (partial match).
function getEventDetails(name) {
  const lower = (name || '').toLowerCase();
  return loadEvents().find((e) => e.event_name.toLowerCase().includes(lower)) || null;
}

// ── TF-IDF semantic search ──────────────────────────────────────────────────

// Simple TF-IDF implementation for lightweight semantic search.
const tfidfCache = { vectorizer: null, matrix: null, texts: null };

function buildTfIdf() {
  if (tfidfCache.vectorizer) return;

  const events = loadEvents();
  const texts = events.map((e) =>
    `${e.event_name} ${e.description} ${e.why_special} ${e.how_celebrated} ${e.story} ${(e.facts || []).join(' ')} ${e.month} ${e.day}`.toLowerCase()
  );

  // Build vocabulary
  const vocab = new Map();
  const tokenized = texts.map((t) => {
    const tokens = t.match(/\b[a-z]{3,}\b/g) || [];
    return tokens;
  });
  let vocabId = 0;
  for (const tokens of tokenized) {
    for (const token of new Set(tokens)) {
      if (!vocab.has(token)) {
        vocab.set(token, vocabId++);
      }
    }
  }

  // Compute IDF
  const N = texts.length;
  const df = new Array(vocabId).fill(0);
  for (const tokens of tokenized) {
    for (const token of new Set(tokens)) {
      df[vocab.get(token)]++;
    }
  }
  const idf = df.map((d) => Math.log((N + 1) / (d + 1)) + 1);

  // Compute TF-IDF matrix (sparse)
  const matrix = tokenized.map((tokens) => {
    const tf = new Array(vocabId).fill(0);
    for (const token of tokens) {
      tf[vocab.get(token)]++;
    }
    // Normalize TF
    const maxTf = Math.max(...tf, 1);
    for (let i = 0; i < vocabId; i++) {
      if (tf[i] > 0) {
        tf[i] = (0.5 + 0.5 * tf[i] / maxTf) * idf[i];
      }
    }
    // L2 normalize
    const norm = Math.sqrt(tf.reduce((s, v) => s + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < vocabId; i++) tf[i] /= norm;
    }
    return tf;
  });

  tfidfCache.vectorizer = { vocab, vocabId };
  tfidfCache.matrix = matrix;
  tfidfCache.texts = texts;
}

// Semantic search by query.
function semanticSearch(query, topK = 5) {
  buildTfIdf();
  const { vocab, vocabId } = tfidfCache.vectorizer;

  // Vectorize query
  const queryTokens = (query.toLowerCase().match(/\b[a-z]{3,}\b/g) || []);
  const queryVec = new Array(vocabId).fill(0);
  const tokenCounts = {};
  for (const t of queryTokens) {
    tokenCounts[t] = (tokenCounts[t] || 0) + 1;
  }
  for (const [token, count] of Object.entries(tokenCounts)) {
    if (vocab.has(token)) {
      queryVec[vocab.get(token)] = count;
    }
  }
  const maxTf = Math.max(...queryVec, 1);
  for (let i = 0; i < vocabId; i++) {
    if (queryVec[i] > 0) {
      queryVec[i] = 0.5 + 0.5 * queryVec[i] / maxTf;
    }
  }
  const norm = Math.sqrt(queryVec.reduce((s, v) => s + v * v, 0));
  if (norm > 0) {
    for (let i = 0; i < vocabId; i++) queryVec[i] /= norm;
  }

  // Compute cosine similarity
  const scores = tfidfCache.matrix.map((docVec, idx) => {
    let dot = 0;
    for (let i = 0; i < vocabId; i++) {
      dot += queryVec[i] * docVec[i];
    }
    return { idx, score: dot };
  });

  scores.sort((a, b) => b.score - a.score);
  return scores.slice(0, topK)
    .filter((s) => s.score > 0.01)
    .map((s) => ({ ...loadEvents()[s.idx], relevanceScore: s.score }));
}

// ── Quiz generation ─────────────────────────────────────────────────────────

const QUESTION_TEMPLATES = {
  what_is: [
    'What is "{event}"?',
    'What do we celebrate on {event}?',
    'What is the significance of {event}?',
  ],
  when: [
    'When is "{event}" celebrated?',
    'On which date do we observe {event}?',
  ],
  why: [
    'Why is "{event}" important?',
    'What is the reason behind {event}?',
  ],
  fact: [
    'Which of the following is true about {event}?',
    'What interesting fact is associated with {event}?',
  ],
  how: [
    'How is "{event}" typically celebrated?',
    'What are the traditions of {event}?',
  ],
};

// Generate a quiz for events on a specific date.
function generateQuizForDate(dateStr, numQuestions = 3) {
  const events = getEventsForDate(dateStr);
  if (events.length === 0) {
    return [{ error: `No events found for ${dateStr}`, suggestion: 'Try a different date' }];
  }

  const questions = [];
  const allEvents = loadEvents();

  for (const event of events.slice(0, numQuestions)) {
    const q = generateQuestionForEvent(event, allEvents);
    if (q) questions.push(q);
  }

  return questions;
}

function generateQuestionForEvent(event, allEvents) {
  const { event_name: eventName, description, why_special: whySpecial, facts, how_celebrated: howCelebrated } = event;

  const types = Object.keys(QUESTION_TEMPLATES);
  const type = types[Math.floor(Math.random() * types.length)];

  let correct, distractors, question;

  if (type === 'what_is' && description) {
    correct = summarize(description, 120);
    question = pick(QUESTION_TEMPLATES.what_is).replace('{event}', eventName);
    distractors = getDistractors(allEvents, eventName, correct);
  } else if (type === 'why' && whySpecial) {
    correct = summarize(whySpecial, 120);
    question = pick(QUESTION_TEMPLATES.why).replace('{event}', eventName);
    distractors = getDistractors(allEvents, eventName, correct, 'why_special');
  } else if (type === 'fact' && facts && facts.length > 0) {
    correct = summarize(facts[0], 120);
    question = pick(QUESTION_TEMPLATES.fact).replace('{event}', eventName);
    distractors = getFactDistractors(allEvents, eventName, correct);
  } else if (type === 'how' && howCelebrated) {
    correct = summarize(howCelebrated, 120);
    question = pick(QUESTION_TEMPLATES.how).replace('{event}', eventName);
    distractors = getDistractors(allEvents, eventName, correct, 'how_celebrated');
  } else if (description) {
    correct = summarize(description, 120);
    question = pick(QUESTION_TEMPLATES.what_is).replace('{event}', eventName);
    distractors = getDistractors(allEvents, eventName, correct);
  } else if (facts && facts.length > 0) {
    correct = summarize(facts[0], 120);
    question = pick(QUESTION_TEMPLATES.fact).replace('{event}', eventName);
    distractors = getFactDistractors(allEvents, eventName, correct);
  } else {
    return null;
  }

  if (!correct || distractors.length < 2) return null;

  const options = [correct, ...distractors.slice(0, 3)];
  // Shuffle
  for (let i = options.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [options[i], options[j]] = [options[j], options[i]];
  }
  const correctIndex = options.indexOf(correct);

  return {
    event_name: eventName,
    date: event.date,
    question,
    options,
    correct_answer: correct,
    correct_index: correctIndex,
    explanation: whySpecial || description || '',
    type,
  };
}

function summarize(text, maxLen) {
  const cleaned = (text || '').split(/\s+/).join(' ').trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, cleaned.lastIndexOf(' ', maxLen)) + '...';
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Wrong options are drawn at random from OTHER events, using the same field as
// the correct answer (a "how is it celebrated" question gets other events'
// celebrations, not their descriptions), so the right answer doesn't stand out
// by style and every quiz doesn't reuse the first few events in the file.
function pickDistractors(allEvents, eventName, correct, textOf, max = 3) {
  const prefix = correct.slice(0, 30);
  const pool = [];
  const seen = new Set([correct]);
  for (const e of allEvents) {
    if (e.event_name === eventName) continue;
    const s = summarize(textOf(e) || '', 120);
    if (!s || seen.has(s) || s.startsWith(prefix)) continue;
    seen.add(s);
    pool.push(s);
  }
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, max);
}

const getDistractors = (allEvents, eventName, correct, field = 'description') =>
  pickDistractors(allEvents, eventName, correct, (e) => e[field]);

const getFactDistractors = (allEvents, eventName, correct) =>
  pickDistractors(allEvents, eventName, correct, (e) => (e.facts || [])[0]);

module.exports = {
  loadEvents,
  parseDate,
  getEventsForDate,
  getTodaysEvents,
  getEventsForMonth,
  getUpcomingEvents,
  getEventDetails,
  semanticSearch,
  generateQuizForDate,
};
