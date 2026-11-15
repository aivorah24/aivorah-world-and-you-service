// Step 4: the AI writes both age versions from the key facts and source text
// (PROMPT C). Checked for shape and length; one retry, then the story is skipped.
const { wordCount } = require('../services/content');

const LIMITS = { kid: [45, 90], teen: [100, 165] };
const MAX_SOURCE_CHARS = 6000;

const PROMPT_C = 'You write for children in India. Using ONLY the KEY FACTS and the SOURCE TEXT given, write one story in two versions. Never add a fact that is not in the source. Write in your own words; do not copy sentences or phrases from the source. Use simple, warm, neutral language; no fear-inducing detail, no political opinions. Return only JSON: {"v712":{"title":"","summary":"one sentence","what_happened":"50-80 words in simple English","why_important":"1-2 sentences on what it means for India or the world"},"v1315":{"title":"","summary":"one sentence","what_happened":"100-150 words in intermediate English","why_important":"2-3 sentences covering why it matters and its impact"},"did_you_know":"one interesting related fact that is stated in the source text, otherwise an empty string","words":[{"word":"","definition":"one short child-friendly sentence"},{"word":"","definition":""},{"word":"","definition":""}],"think_about_it":"one open question that connects the story to a child\'s daily life"}. The first word must be simple enough for age 7; the other two are for ages 13-15.';

const str = (v) => String(v ?? '').trim();

// Returns { story } or { error }: the story in the shape run.js saves.
function checkWritten(answer) {
  const v712 = answer?.v712 || {};
  const v1315 = answer?.v1315 || {};
  for (const [name, v] of [['v712', v712], ['v1315', v1315]]) {
    for (const f of ['title', 'summary', 'what_happened', 'why_important']) {
      if (!str(v[f])) return { error: `${name}.${f} is missing` };
    }
  }
  const kid = wordCount(v712.what_happened);
  const teen = wordCount(v1315.what_happened);
  if (kid < LIMITS.kid[0] || kid > LIMITS.kid[1]) return { error: `v712.what_happened has ${kid} words (needs 50-80)` };
  if (teen < LIMITS.teen[0] || teen > LIMITS.teen[1]) return { error: `v1315.what_happened has ${teen} words (needs 100-150)` };
  const words = (Array.isArray(answer.words) ? answer.words : [])
    .map((w) => ({ word: str(w?.word), definition: str(w?.definition) }))
    .filter((w) => w.word && w.definition);
  if (!words.length) return { error: 'words: at least one word with a definition is needed' };
  return {
    story: {
      kid: { title: str(v712.title), summary: str(v712.summary), what_happened: str(v712.what_happened), why_important: str(v712.why_important) },
      teen: { title: str(v1315.title), summary: str(v1315.summary), what_happened: str(v1315.what_happened), why_important: str(v1315.why_important) },
      did_you_know: str(answer.did_you_know) || null,
      words: words.slice(0, 3),
      think_about_it: str(answer.think_about_it) || null,
      wordCounts: { kid, teen },
    },
  };
}

async function writeOne(item, llm) {
  const source = (item.pageText || `${item.title}. ${item.summary}`).slice(0, MAX_SOURCE_CHARS);
  const base = `${PROMPT_C}\n\nKEY FACTS:\n${item.keyFacts.map((f) => `- ${f}`).join('\n')}\n\nSOURCE TEXT:\n${source}`;
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = attempt ? `${base}\n\nYour previous answer was not usable (${lastError}). Return corrected JSON only.` : base;
    let answer;
    try {
      answer = await llm.json('write', prompt, { maxTokens: 2200 });
    } catch (err) {
      if (err.budget) return { error: err.message };
      lastError = `not valid JSON: ${err.message}`;
      continue;
    }
    const checked = checkWritten(answer);
    if (checked.story) return checked;
    lastError = checked.error;
  }
  return { error: `could not write a valid story after a retry (${lastError})` };
}

async function write(items, llm) {
  const report = { written: 0, skipped: [] };
  const stories = [];
  for (const item of items) {
    const result = await writeOne(item, llm);
    if (result.error) { report.skipped.push({ title: item.title, reason: result.error }); continue; }
    report.written++;
    stories.push({ ...item, written: result.story });
  }
  return { stories, report };
}

module.exports = { write, checkWritten, PROMPT_C, LIMITS };
