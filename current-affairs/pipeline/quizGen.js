// Weekly quiz generator. For the quiz of week_start S (a Sunday) it uses only
// PUBLISHED stories with publish_date from S-6 to S (the 7 days ending on
// that Sunday) and writes up to 10 questions per age group (prompt D), each
// tied to the story it comes from. Saved with status 'review': an editor
// publishes the week in the admin tool (/admin/quiz/publish). Never published here.
const crypto = require('crypto');
const { AGE_GROUPS, CATEGORIES, localDate, addDays, quizWeekStart } = require('../services/content');
const { CATEGORY_SLOTS, QUIZ_SIZE } = require('../services/quiz');
const { check } = require('../services/db');
const { createLlm } = require('./llm');

const PER_SLOT = 2;
const TYPES = ['mcq', 'true_false', 'reasoning'];
const AGE_LABEL = { '7-12': '7-12', '13-15': '13-15' };

const PROMPT_D = 'You write quiz questions for children in India from a set of news stories published this week. Use ONLY the stories given; never use outside knowledge. Age group: {AGE}. For 7-12 write simple, basic-knowledge questions in simple English. For 13-15 write a mix of knowledge and reasoning questions in intermediate English. Write exactly 10 questions: 2 about India, 2 about World, 2 about Science, 2 about Economy or Environment, 2 about Sports or Society; 6 multiple choice (4 options), 2 true/false (options exactly ["True","False"]), 2 reasoning (4 options, asking why or how something applies). Return only JSON: {"questions":[{"story_index":number,"category":"india|world|economy|science|environment|sports|society","question_type":"mcq|true_false|reasoning","question":"","options":[],"correct_index":number,"explanation":"why the answer is correct, 1-2 sentences","extra_fact":"one short extra fact stated in the story"}]}. Every question must be answerable from the story it references.';

// The quiz to generate: the upcoming Sunday, or today when today is a Sunday.
function defaultWeekStart(now = new Date()) {
  const today = localDate(now);
  const sunday = quizWeekStart(today);
  return sunday === today ? today : addDays(sunday, 7);
}

const str = (v) => String(v ?? '').trim();

// Returns { question } (a ca_quiz_questions row without week/age/position) or { error }.
function checkQuestion(q, stories) {
  const story = stories[Number(q?.story_index)];
  if (!story) return { error: 'story_index does not match a story' };
  if (!CATEGORIES.includes(q.category)) return { error: `unknown category ${q.category}` };
  if (!TYPES.includes(q.question_type)) return { error: `unknown question_type ${q.question_type}` };
  const question = str(q.question);
  if (question.length < 10 || question.length > 300) return { error: 'question length is not sensible' };
  const options = (Array.isArray(q.options) ? q.options : []).map(str);
  if (q.question_type === 'true_false') {
    if (options.length !== 2 || options[0] !== 'True' || options[1] !== 'False') return { error: 'true_false needs options exactly ["True","False"]' };
  } else if (options.length !== 4) return { error: `${q.question_type} needs 4 options` };
  if (options.some((o) => !o || o.length > 160)) return { error: 'an option is empty or too long' };
  if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) return { error: 'options are not distinct' };
  const correct = Number(q.correct_index);
  if (!Number.isInteger(correct) || correct < 0 || correct >= options.length) return { error: 'correct_index is not one of the options' };
  const explanation = str(q.explanation);
  if (!explanation) return { error: 'explanation is empty' };
  return {
    question: {
      category: q.category, question_type: q.question_type, question, options, correct_index: correct,
      explanation, extra_fact: str(q.extra_fact) || null, story_id: story.id,
    },
  };
}

// Up to 2 questions per category slot (India, World, Science, Economy/Environment, Sports/Society), in slot order.
function fillSlots(questions) {
  const kept = [];
  const short = [];
  for (const cats of CATEGORY_SLOTS) {
    const inSlot = questions.filter((q) => cats.includes(q.category)).slice(0, PER_SLOT);
    kept.push(...inSlot);
    if (inSlot.length < PER_SLOT) short.push(`${cats.join('/')} (${inSlot.length} of ${PER_SLOT})`);
  }
  return { questions: kept.slice(0, QUIZ_SIZE), short };
}

function storyBlock(stories, ageGroup) {
  const col = AGE_GROUPS[ageGroup].column;
  return stories.map((s, i) => [
    `STORY ${i} [${s.category}] ${s[`title_${col}`]}`,
    `What happened: ${s[`what_happened_${col}`]}`,
    `Why it matters: ${s[`why_important_${col}`]}`,
    s.did_you_know ? `Did you know: ${s.did_you_know}` : '',
  ].filter(Boolean).join('\n')).join('\n\n');
}

// One AI call for the age group; questions that fail the checks get one
// retry call asking for replacements; whatever still fails is dropped.
async function generateForAge(stories, ageGroup, llm) {
  const prompt = `${PROMPT_D.replace('{AGE}', AGE_LABEL[ageGroup])}

STORIES:
${storyBlock(stories, ageGroup)}`;
  const valid = [];
  const ask = async (text) => {
    try { return { questions: (await llm.json('quiz', text, { maxTokens: 3500 }))?.questions }; } catch (err) { return { error: err.message }; }
  };
  const sort = (questions) => {
    const bad = [];
    for (const q of Array.isArray(questions) ? questions : []) {
      const checked = checkQuestion(q, stories);
      if (checked.question) valid.push(checked.question);
      else bad.push({ error: checked.error, question: str(q?.question).slice(0, 80) });
    }
    return bad;
  };

  const first = await ask(prompt);
  let invalid = first.error ? [{ error: `not valid JSON: ${first.error}` }] : sort(first.questions);
  if (invalid.length) {
    const reasons = invalid.map((x) => `- ${x.error}`).join('\n');
    const retry = await ask(first.error ? prompt
      : `${prompt}\n\nSome of your questions were not usable:\n${reasons}\nWrite ${invalid.length} replacement question(s) only, following every rule. Return only JSON in the same shape.`);
    const stillBad = retry.error ? [{ error: `retry failed: ${retry.error}` }] : sort(retry.questions);
    invalid = [...invalid, ...stillBad];
  }
  return { valid, dropped: invalid };
}

/**
 * Generates the week's quiz for both age groups. Writes only when dryRun is
 * false AND CA_PIPELINE_ENABLED=true. force regenerates a week that already has questions.
 */
async function generateWeeklyQuiz({ supabase, llm = createLlm(), weekStart, force = false, dryRun = false, env = process.env, now = new Date() } = {}) {
  const runId = crypto.randomUUID();
  const week = weekStart || defaultWeekStart(now);
  if (quizWeekStart(week) !== week) throw new Error('weekStart must be a Sunday (YYYY-MM-DD)');
  const from = addDays(week, -6);
  const writesEnabled = !dryRun && String(env.CA_PIPELINE_ENABLED || '').toLowerCase() === 'true';
  const report = {
    runId, weekStart: week, storiesFrom: from, storiesTo: week, mode: writesEnabled ? 'write' : 'dry-run',
    rule: `Published stories with publish_date ${from} to ${week} (the 7 days ending on the quiz's Sunday).`,
    stories: 0, ageGroups: {}, rows: [],
  };

  const stories = check(await supabase.from('ca_stories')
    .select('id, category, publish_date, title_kid, what_happened_kid, why_important_kid, title_teen, what_happened_teen, why_important_teen, did_you_know')
    .eq('status', 'published').gte('publish_date', from).lte('publish_date', week)
    .order('publish_date', { ascending: true }).order('priority', { ascending: false }).limit(60)) || [];
  report.stories = stories.length;
  if (stories.length < 5) report.note = `Only ${stories.length} published stories this week: questions only for what they support.`;

  for (const ageGroup of Object.keys(AGE_GROUPS)) {
    const existing = check(await supabase.from('ca_quiz_questions').select('id, status')
      .eq('week_start', week).eq('age_group', ageGroup)) || [];
    const live = existing.filter((q) => !['rejected', 'archived'].includes(q.status));
    if (live.length && !force) {
      report.ageGroups[ageGroup] = { skipped: `already has ${live.length} question(s); pass force to generate again` };
      continue;
    }
    if (!stories.length) {
      report.ageGroups[ageGroup] = { produced: 0, shortSlots: CATEGORY_SLOTS.map((c) => c.join('/')), dropped: [] };
      continue;
    }
    const { valid, dropped } = await generateForAge(stories, ageGroup, llm);
    const { questions, short } = fillSlots(valid);
    const rows = questions.map((q, i) => ({ ...q, week_start: week, age_group: ageGroup, status: 'review', position: i + 1 }));
    report.ageGroups[ageGroup] = {
      produced: rows.length,
      types: rows.reduce((t, r) => ({ ...t, [r.question_type]: (t[r.question_type] || 0) + 1 }), {}),
      shortSlots: short,
      dropped,
    };
    if (writesEnabled) {
      for (const row of rows) if (row.status !== 'review') throw new Error('The quiz generator may only save questions for review');
      if (rows.length) check(await supabase.from('ca_quiz_questions').insert(rows).select('id'));
      report.ageGroups[ageGroup].saved = rows.length;
    } else {
      report.rows.push(...rows);
    }
  }
  report.aiCalls = { quiz: llm.used.quiz };
  return report;
}

function summarizeQuiz(report) {
  const ages = Object.entries(report.ageGroups).map(([age, r]) => (r.skipped ? `${age}: skipped (${r.skipped})`
    : `${age}: ${r.produced} questions${r.shortSlots.length ? `, short: ${r.shortSlots.join(', ')}` : ''}${r.dropped.length ? `, dropped ${r.dropped.length}` : ''}`)).join('; ');
  return `[ca-quiz] ${report.runId} week ${report.weekStart} ${report.mode}: ${report.stories} published stories (${report.storiesFrom} to ${report.storiesTo}); ${ages}`;
}

module.exports = { generateWeeklyQuiz, summarizeQuiz, checkQuestion, fillSlots, defaultWeekStart, PROMPT_D };
