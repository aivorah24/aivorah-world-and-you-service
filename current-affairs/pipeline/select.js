// Step 2: child-safety filter, then the AI picks the day's stories (PROMPT A).
const { CATEGORIES } = require('../services/content');

const MAX_ITEMS_TO_AI = 60;
const MAX_STORIES = 7;
// India 2-3, World 2, Science 1, one from sports/environment/society; economy
// (RBI, business) may take one place too. Never more than 7 in all.
const CAPS = { india: 3, world: 2, science: 1, economy: 1, other: 1 };
const capKey = (category) => (['sports', 'environment', 'society'].includes(category) ? 'other' : category);

// Clearly unsuitable before the AI sees it (the AI is told the same rules).
const UNSUITABLE = /\b(murder\w*|killed|killing|rape\w*|sexual\w*|stabb\w*|shot dead|lynch\w*|molest\w*|assault\w*|abduct\w*|kidnap\w*|suicide|beheaded|massacre\w*|betting|gambling|casino|tender\w*|auction\w*|monetary penalty|penalty on|imposes penalty|fined|editorial|op-ed|opinion|gossip|horoscope)\b/i;

function isSuitable(item) {
  return !UNSUITABLE.test(`${item.title} ${item.summary}`);
}

const PROMPT_A = 'You are the editor of a daily news digest for school children aged 7-15 in India. From the numbered items, choose the best stories. Score each 1-5 on significance, learning value, child relevance, and source strength (5 for PIB, RBI, UN; 3 for newspaper reports). Reject items with crime details, violence, sexual content, gossip, betting, partisan attacks, opinion pieces, tenders, auctions or individual bank penalties. Prefer constructive and educational stories when scores are close, but do not hide important serious news. Return only JSON: {"selected":[{"index":number,"category":"india|world|economy|science|environment|sports|society","score":number,"why":"one short sentence","key_facts":["3 to 5 short facts taken only from the given title and summary"]}]}. Choose 6 items (minimum 5, maximum 7): India 2-3, World 2, Science 1, and 1 from sports, environment or society. Choose fewer if there are not enough good items. Use only the given text; never add facts.';

function itemList(items) {
  return items.map((it, i) => `${i}. [${it.source}; feed: ${it.feedCategory}] ${it.title}\n   ${it.summary.slice(0, 400)}`).join('\n');
}

// Keeps the AI's picks that are real, well-formed and within the category caps, best score first.
function applyPicks(items, selected) {
  const counts = {};
  const used = new Set();
  const picks = [];
  const sorted = [...(Array.isArray(selected) ? selected : [])].sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
  for (const s of sorted) {
    const index = Number(s.index);
    const item = items[index];
    if (!item || used.has(index) || !CATEGORIES.includes(s.category)) continue;
    const facts = (Array.isArray(s.key_facts) ? s.key_facts : []).map((f) => String(f || '').trim()).filter(Boolean).slice(0, 5);
    if (!facts.length) continue;
    const key = capKey(s.category);
    if ((counts[key] || 0) >= CAPS[key] || picks.length >= MAX_STORIES) continue;
    counts[key] = (counts[key] || 0) + 1;
    used.add(index);
    picks.push({ ...item, category: s.category, score: Number(s.score) || 0, why: String(s.why || ''), keyFacts: facts });
  }
  return picks;
}

async function select(items, llm) {
  const suitable = items.filter(isSuitable);
  const report = { unsuitable: items.length - suitable.length, sentToAi: Math.min(suitable.length, MAX_ITEMS_TO_AI), selected: 0 };
  if (!suitable.length) return { picks: [], report };
  const batch = suitable.slice(0, MAX_ITEMS_TO_AI);
  const answer = await llm.json('select', `${PROMPT_A}\n\nITEMS:\n${itemList(batch)}`, { maxTokens: 2500 });
  const picks = applyPicks(batch, answer?.selected);
  report.selected = picks.length;
  return { picks, report };
}

module.exports = { select, applyPicks, isSuitable, PROMPT_A, CAPS, MAX_STORIES, MAX_ITEMS_TO_AI };
