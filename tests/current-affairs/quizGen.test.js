// Weekly quiz generator with a fake Supabase and a mocked AI: no network.
jest.mock('../../services/supabase', () => require('./helpers/fakeSupabase').createFakeSupabase());
jest.mock('../../services/firebaseAdmin', () => require('./helpers/fakeFirebase'));
jest.mock('../../services/dailyTidbit', () => ({}));
jest.mock('../../services/world', () => ({}));

const request = require('supertest');
const supabase = require('../../services/supabase');
const { generateWeeklyQuiz, checkQuestion, fillSlots, defaultWeekStart } = require('../../current-affairs/pipeline/quizGen');
const { createLlm } = require('../../current-affairs/pipeline/llm');
const { storyRow, auth } = require('./helpers/fixtures');

const WEEK = '2026-11-15'; // a Sunday: stories 9-15 Nov
const ENABLED = { CA_PIPELINE_ENABLED: 'true' };
const CATS = ['india', 'india', 'world', 'world', 'science', 'science', 'economy', 'environment', 'sports', 'society'];
const TYPES = ['mcq', 'mcq', 'mcq', 'mcq', 'mcq', 'mcq', 'true_false', 'true_false', 'reasoning', 'reasoning'];

// One published story per category in the week, plus ones the quiz must ignore.
function seedWeek() {
  const stories = CATS.map((category, i) => storyRow({ n: i, category, status: 'published', publish_date: `2026-11-${String(9 + (i % 7)).padStart(2, '0')}` }));
  supabase.__seed('ca_stories', [
    ...stories,
    storyRow({ n: 20, status: 'review', publish_date: '2026-11-12' }),     // not published
    storyRow({ n: 21, status: 'published', publish_date: '2026-11-08' }),  // the week before
    storyRow({ n: 22, status: 'published', publish_date: '2026-11-16' }),  // after the Sunday
  ]);
  return stories;
}

function question(i, over = {}) {
  const type = TYPES[i];
  return {
    story_index: i, category: CATS[i], question_type: type, question: `What happened in story number ${i}?`,
    options: type === 'true_false' ? ['True', 'False'] : ['Option A', 'Option B', 'Option C', 'Option D'],
    correct_index: 1, explanation: 'The story says so.', extra_fact: 'A fact from the story.', ...over,
  };
}
const tenQuestions = () => CATS.map((_, i) => question(i));

function fakeAi(answers) {
  const queue = [...answers];
  const ask = jest.fn(async () => {
    const next = queue.length ? queue.shift() : { questions: tenQuestions() };
    if (next instanceof Error) throw next;
    return next;
  });
  return { llm: createLlm({ ask }), ask };
}

beforeEach(() => supabase.__reset());

test('the default week is the upcoming Sunday, or today on a Sunday', () => {
  expect(defaultWeekStart(new Date('2026-11-14T14:30:00Z'))).toBe('2026-11-15'); // Saturday 8 PM in India
  expect(defaultWeekStart(new Date('2026-11-15T05:00:00Z'))).toBe('2026-11-15'); // Sunday
  expect(defaultWeekStart(new Date('2026-11-16T05:00:00Z'))).toBe('2026-11-22'); // Monday
});

test('10 questions per age group in the required mix, each tied to a story of that week, all for review', async () => {
  const stories = seedWeek();
  const { llm, ask } = fakeAi([]);
  const report = await generateWeeklyQuiz({ supabase, llm, weekStart: WEEK, env: ENABLED });
  expect(report).toMatchObject({ storiesFrom: '2026-11-09', storiesTo: WEEK, stories: 10, mode: 'write' });
  expect(ask).toHaveBeenCalledTimes(2); // one per age group
  const rows = supabase.__rows('ca_quiz_questions');
  const weekIds = new Set(stories.map((s) => s.id));
  for (const age of ['7-12', '13-15']) {
    const qs = rows.filter((r) => r.age_group === age).sort((a, b) => a.position - b.position);
    expect(qs).toHaveLength(10);
    expect(qs.map((q) => q.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(qs.map((q) => q.category)).toEqual(CATS);
    const types = qs.reduce((t, q) => ({ ...t, [q.question_type]: (t[q.question_type] || 0) + 1 }), {});
    expect(types).toEqual({ mcq: 6, true_false: 2, reasoning: 2 });
    for (const q of qs) {
      expect(q).toMatchObject({ week_start: WEEK, status: 'review' });
      expect(weekIds.has(q.story_id)).toBe(true);
      expect(q.explanation).toBeTruthy();
    }
  }
  expect(rows.some((r) => r.status === 'published')).toBe(false);
  // The prompt names the age group and gives that age's text.
  expect(ask.mock.calls[0][0]).toMatch(/Age group: 7-12/);
  expect(ask.mock.calls[0][0]).toMatch(/Kid title 0/);
  expect(ask.mock.calls[1][0]).toMatch(/Age group: 13-15/);
  expect(ask.mock.calls[1][0]).toMatch(/Teen title 0/);
});

test('a week that already has questions is not generated again, unless forced', async () => {
  seedWeek();
  supabase.__seed('ca_quiz_questions', [
    { id: 'q1', week_start: WEEK, age_group: '7-12', status: 'review' },
    { id: 'q2', week_start: WEEK, age_group: '13-15', status: 'rejected' },
  ]);
  const { llm, ask } = fakeAi([]);
  const report = await generateWeeklyQuiz({ supabase, llm, weekStart: WEEK, env: ENABLED });
  expect(report.ageGroups['7-12'].skipped).toMatch(/already has 1 question/);
  expect(report.ageGroups['13-15'].produced).toBe(10); // only a rejected one existed
  expect(ask).toHaveBeenCalledTimes(1);
  const forced = await generateWeeklyQuiz({ supabase, llm: fakeAi([]).llm, weekStart: WEEK, env: ENABLED, force: true });
  expect(forced.ageGroups['7-12'].produced).toBe(10);
});

test('invalid questions are retried once, then dropped and reported', async () => {
  seedWeek();
  const broken = tenQuestions();
  broken[0] = question(0, { correct_index: 7 });
  broken[6] = question(6, { options: ['Yes', 'No'] });
  broken[9] = question(9, { explanation: '' });
  const { llm, ask } = fakeAi([
    { questions: broken },
    { questions: [question(0), question(6, { options: ['True', 'True'] })] }, // one fixed, one still bad
    { questions: tenQuestions() },
  ]);
  const report = await generateWeeklyQuiz({ supabase, llm, weekStart: WEEK, dryRun: true });
  const kid = report.ageGroups['7-12'];
  expect(ask.mock.calls[1][0]).toMatch(/Write 3 replacement question\(s\) only/);
  expect(kid.produced).toBe(8);
  expect(kid.shortSlots).toEqual(['economy/environment (1 of 2)', 'sports/society (1 of 2)']);
  expect(kid.dropped.map((d) => d.error)).toEqual([
    'correct_index is not one of the options',
    'true_false needs options exactly ["True","False"]',
    'explanation is empty',
    'true_false needs options exactly ["True","False"]',
  ]);
});

test('fewer than 5 stories: only what they support, short slots named, nothing invented', async () => {
  supabase.__seed('ca_stories', [
    storyRow({ n: 1, category: 'india', status: 'published', publish_date: '2026-11-10' }),
    storyRow({ n: 2, category: 'science', status: 'published', publish_date: '2026-11-11' }),
  ]);
  const { llm } = fakeAi([
    { questions: [question(0, { category: 'india' }), question(1, { category: 'science', story_index: 1 }), question(5, { story_index: 5 })] },
    { questions: [] },
    { questions: [question(0, { category: 'india' })] },
  ]);
  const report = await generateWeeklyQuiz({ supabase, llm, weekStart: WEEK, dryRun: true });
  expect(report.note).toMatch(/Only 2 published stories/);
  expect(report.ageGroups['7-12'].produced).toBe(2); // story_index 5 does not exist: dropped
  expect(report.ageGroups['7-12'].shortSlots).toContain('world (0 of 2)');
  expect(report.rows.every((r) => r.status === 'review')).toBe(true);
});

test('a dry run (or no CA_PIPELINE_ENABLED) saves nothing', async () => {
  seedWeek();
  const dry = await generateWeeklyQuiz({ supabase, llm: fakeAi([]).llm, weekStart: WEEK, dryRun: true, env: ENABLED });
  expect(dry.rows).toHaveLength(20);
  const off = await generateWeeklyQuiz({ supabase, llm: fakeAi([]).llm, weekStart: WEEK, env: {} });
  expect(off.mode).toBe('dry-run');
  expect(supabase.__rows('ca_quiz_questions')).toHaveLength(0);
});

test('checkQuestion and fillSlots', () => {
  const stories = [{ id: 's0' }];
  expect(checkQuestion(question(0), stories).question).toMatchObject({ story_id: 's0', correct_index: 1 });
  expect(checkQuestion(question(0, { options: ['A', 'A', 'B', 'C'] }), stories).error).toBe('options are not distinct');
  expect(checkQuestion(question(0, { question: 'Short?' }), stories).error).toBe('question length is not sensible');
  expect(checkQuestion(question(0, { story_index: 3 }), stories).error).toBe('story_index does not match a story');
  const { questions, short } = fillSlots([{ category: 'india' }, { category: 'india' }, { category: 'india' }, { category: 'sports' }]);
  expect(questions.map((q) => q.category)).toEqual(['india', 'india', 'sports']);
  expect(short).toEqual(['world (0 of 2)', 'science (0 of 2)', 'economy/environment (0 of 2)', 'sports/society (1 of 2)']);
});

test('the admin quiz tool shows the story title next to each question', async () => {
  const [story] = seedWeek();
  supabase.__seed('ca_quiz_questions', [{ id: 'q1', week_start: WEEK, age_group: '7-12', status: 'review', position: 1, story_id: story.id, options: ['True', 'False'], correct_index: 0 }]);
  const app = require('../../index');
  const res = await request(app).get(`/current-affairs/admin/quiz?weekStart=${WEEK}&ageGroup=7-12`).set(auth('admin@aivorah.ai'));
  expect(res.body.questions[0].story_title).toBe('Kid title 0');
});

describe('POST /current-affairs/pipeline/quiz', () => {
  const app = require('../../index');
  afterEach(() => { delete process.env.CA_PIPELINE_SECRET; });

  test('refused without the secret set, with a missing or a wrong header', async () => {
    expect((await request(app).post('/current-affairs/pipeline/quiz').set('x-pipeline-secret', 'x')).status).toBe(401);
    process.env.CA_PIPELINE_SECRET = 'right-secret';
    expect((await request(app).post('/current-affairs/pipeline/quiz')).status).toBe(401);
    expect((await request(app).post('/current-affairs/pipeline/quiz').set('x-pipeline-secret', 'wrong')).status).toBe(401);
  });

  test('a week that is not a Sunday is refused; otherwise it starts in the background', async () => {
    process.env.CA_PIPELINE_SECRET = 'right-secret';
    const quizGen = require('../../current-affairs/pipeline/quizGen');
    const spy = jest.spyOn(quizGen, 'generateWeeklyQuiz').mockResolvedValue({ runId: 'r', weekStart: WEEK, mode: 'dry-run', stories: 0, storiesFrom: '', storiesTo: '', ageGroups: {} });
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const send = (body) => request(app).post('/current-affairs/pipeline/quiz').set('x-pipeline-secret', 'right-secret').send(body);
    expect((await send({ weekStart: '2026-11-16' })).status).toBe(400);
    const res = await send({ weekStart: WEEK, force: true });
    expect(res.status).toBe(202);
    await new Promise((r) => setImmediate(r));
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ weekStart: WEEK, force: true }));
    spy.mockRestore();
    log.mockRestore();
  });
});
