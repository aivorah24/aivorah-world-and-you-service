// Admin content tool: only editors get in; stories and quiz questions can be
// reviewed, edited, written and published; analytics come from the activity tables.
jest.mock('../../services/supabase', () => require('./helpers/fakeSupabase').createFakeSupabase());
jest.mock('../../services/firebaseAdmin', () => require('./helpers/fakeFirebase'));
// index.js also loads World & You's AI routes, which create a Groq client on load.
jest.mock('../../services/dailyTidbit', () => ({}));
jest.mock('../../services/world', () => ({}));

const request = require('supertest');
const app = require('../../index');
const supabase = require('../../services/supabase');
const { freezeTime, storyRow, questionRow, weekQuestions, auth } = require('./helpers/fixtures');

const EDITOR = 'admin@aivorah.ai';
const get = (path, email = EDITOR) => request(app).get(`/current-affairs/admin${path}`).set(auth(email));
const send = (method, path, body, email = EDITOR) => request(app)[method](`/current-affairs/admin${path}`).set(auth(email)).send(body);

beforeEach(() => {
  supabase.__reset();
  freezeTime('2026-11-09T06:00:00Z'); // Monday 9 Nov, India time
});
afterEach(() => { jest.useRealTimers(); delete process.env.CA_EDITOR_EMAILS; });

describe('who can use it', () => {
  test('no sign-in is 401; a student is 403; an editor (or an extra editor from settings) gets in', async () => {
    expect((await request(app).get('/current-affairs/admin/me')).status).toBe(401);
    expect((await get('/me', 'kid@school.in')).status).toBe(403);
    expect((await get('/me')).body).toEqual({ email: EDITOR, editor: true });
    process.env.CA_EDITOR_EMAILS = 'writer@aivorah.ai, other@aivorah.ai';
    expect((await get('/me', 'Writer@Aivorah.ai')).status).toBe(200);
  });
});

describe('stories', () => {
  test('the review queue lists stories waiting for an editor with their check notes', async () => {
    supabase.__seed('ca_stories', [
      storyRow({ n: 1, status: 'review', review_notes: 'names not in source: Meghdoot' }),
      storyRow({ n: 2, status: 'published' }),
    ]);
    const res = await get('/stories?status=review');
    expect(res.status).toBe(200);
    expect(res.body.stories).toHaveLength(1);
    expect(res.body.stories[0]).toMatchObject({ title_kid: 'Kid title 1', review_notes: 'names not in source: Meghdoot' });
  });

  test('an editor fixes the text, then publishes; the story shows in the digest', async () => {
    const [row] = [storyRow({ n: 1, status: 'review', is_true_fact: false })];
    supabase.__seed('ca_stories', [row]);

    const edited = await send('patch', `/stories/${row.id}`, { title_kid: 'Fixed title', did_you_know: 'Checked fact.' });
    expect(edited.status).toBe(200);
    expect(edited.body.story).toMatchObject({ title_kid: 'Fixed title', did_you_know: 'Checked fact.' });
    expect((await send('patch', `/stories/${row.id}`, { title_kid: '  ' })).status).toBe(400);

    const before = await request(app).get('/current-affairs/digest/today?ageGroup=7-12');
    expect(before.body.stories || []).toHaveLength(0);

    const pub = await send('post', `/stories/${row.id}/status`, { status: 'published' });
    expect(pub.body.story).toMatchObject({ status: 'published', is_true_fact: true, reviewed_by: EDITOR });

    const after = await request(app).get('/current-affairs/digest/today?ageGroup=7-12');
    expect(after.body.stories.map((s) => s.title)).toEqual(['Fixed title']);
  });

  test('a story can be rejected; an unknown status or story is refused', async () => {
    const row = storyRow({ status: 'review' });
    supabase.__seed('ca_stories', [row]);
    expect((await send('post', `/stories/${row.id}/status`, { status: 'rejected' })).body.story.status).toBe('rejected');
    expect((await send('post', `/stories/${row.id}/status`, { status: 'live' })).status).toBe(400);
    expect((await send('post', '/stories/00000000-0000-4000-8000-000000000000/status', { status: 'published' })).status).toBe(404);
  });

  test('an editor writes a new story: the two age versions (7-12, 13-15) are required', async () => {
    const full = { category: 'science', source: 'NASA', source_url: 'https://www.nasa.gov/x' };
    for (const f of ['title', 'summary', 'what_happened', 'why_important']) for (const a of ['kid', 'teen']) full[`${f}_${a}`] = `${f} ${a}`;

    const missing = await send('post', '/stories', { ...full, why_important_teen: undefined });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/why_important_teen/);

    const draft = await send('post', '/stories', full);
    expect(draft.status).toBe(201);
    expect(draft.body.story).toMatchObject({ status: 'draft', publish_date: '2026-11-09', category: 'science' });
    expect(draft.body.story).not.toHaveProperty('title_young'); // no under-8 version any more

    const live = await send('post', '/stories', { ...full, publish: true });
    expect(live.body.story).toMatchObject({ status: 'published', reviewed_by: EDITOR, is_true_fact: true });
  });
});

describe('story checks (warnings, image, source link)', () => {
  const words = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
  const full = () => {
    const f = { category: 'science', source: 'NASA', source_url: 'https://www.nasa.gov/x?utm_source=feed' };
    for (const p of ['title', 'summary', 'why_important']) for (const a of ['kid', 'teen']) f[`${p}_${a}`] = `${p} ${a}`;
    f.what_happened_kid = words(65);
    f.what_happened_teen = words(120);
    return f;
  };

  test('lengths inside the targets give no warnings; outside give one per text, and still save', async () => {
    const ok = await send('post', '/stories', full());
    expect(ok.status).toBe(201);
    expect(ok.body.warnings).toEqual([]);
    const short = await send('post', '/stories', { ...full(), source_url: 'https://www.nasa.gov/y', what_happened_kid: words(20), what_happened_teen: words(200) });
    expect(short.status).toBe(201);
    expect(short.body.warnings).toEqual([
      { field: 'what_happened_kid', words: 20, message: 'Ages 7-12 "What happened" has 20 words; aim for 50-80.' },
      { field: 'what_happened_teen', words: 200, message: 'Ages 13-15 "What happened" has 200 words; aim for 100-150.' },
    ]);
    const edited = await send('patch', `/stories/${short.body.story.id}`, { what_happened_kid: words(60) });
    expect(edited.body.warnings.map((w) => w.field)).toEqual(['what_happened_teen']);
  });

  test('the source link gets the shared hash (tracking parameters ignored)', async () => {
    const { urlHash } = require('../../current-affairs/services/sourceUrl');
    const res = await send('post', '/stories', full());
    expect(res.body.story.source_url_hash).toBe(urlHash('https://nasa.gov/x'));
  });

  test('a picture link must be https', async () => {
    expect((await send('post', '/stories', { ...full(), image_url: 'http://x.in/a.jpg' })).status).toBe(400);
    const ok = await send('post', '/stories', { ...full(), image_url: 'https://x.in/a.jpg' });
    expect(ok.body.story.image_url).toBe('https://x.in/a.jpg');
  });
});

describe('bulk review', () => {
  test("publish selected as today's digest: stamped, dated today, then shown to students", async () => {
    const a = storyRow({ n: 1, status: 'review', publish_date: '2026-11-08', review_notes: 'AUTO: VERIFIED' });
    const b = storyRow({ n: 2, status: 'draft', publish_date: '2026-11-08' });
    const live = storyRow({ n: 3, status: 'published', publish_date: '2026-11-08' });
    const gone = storyRow({ n: 4, status: 'rejected' });
    supabase.__seed('ca_stories', [a, b, live, gone]);
    const res = await send('post', '/stories/bulk-status', { ids: [a.id, b.id, live.id, gone.id, 'nope'], status: 'published', publishDate: 'today' });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(2);
    expect(res.body.results).toEqual([
      { id: a.id, ok: true, status: 'published', publish_date: '2026-11-09' },
      { id: b.id, ok: true, status: 'published', publish_date: '2026-11-09' },
      { id: live.id, ok: false, reason: 'not waiting for review (it is published)' },
      { id: gone.id, ok: false, reason: 'not waiting for review (it is rejected)' },
      { id: 'nope', ok: false, reason: 'not a story id' },
    ]);
    const saved = supabase.__rows('ca_stories').find((r) => r.id === a.id);
    expect(saved).toMatchObject({ reviewed_by: EDITOR, is_true_fact: true });
    const digest = await request(app).get('/current-affairs/digest/today?ageGroup=7-12');
    expect(digest.body.date).toBe('2026-11-09');
    expect(digest.body.stories.map((s) => s.id).sort()).toEqual([a.id, b.id].sort());
  });

  test('reject selected; publishing without a date keeps each story’s own date', async () => {
    const a = storyRow({ n: 1, status: 'review', publish_date: '2026-11-08' });
    const b = storyRow({ n: 2, status: 'review', publish_date: '2026-11-07' });
    supabase.__seed('ca_stories', [a, b]);
    expect((await send('post', '/stories/bulk-status', { ids: [a.id], status: 'rejected' })).body.results[0]).toMatchObject({ ok: true, status: 'rejected' });
    expect((await send('post', '/stories/bulk-status', { ids: [b.id], status: 'published' })).body.results[0]).toMatchObject({ ok: true, publish_date: '2026-11-07' });
  });

  test('checks its input and needs an editor', async () => {
    const ids = Array.from({ length: 21 }, () => storyRow().id);
    expect((await send('post', '/stories/bulk-status', { ids, status: 'published' })).status).toBe(400);
    expect((await send('post', '/stories/bulk-status', { ids: [], status: 'published' })).status).toBe(400);
    expect((await send('post', '/stories/bulk-status', { ids: [ids[0]], status: 'archived' })).status).toBe(400);
    expect((await send('post', '/stories/bulk-status', { ids: [ids[0]], status: 'published', publishDate: '2026-01-01' })).status).toBe(400);
    expect((await send('post', '/stories/bulk-status', { ids: [ids[0]], status: 'published' }, 'kid@school.in')).status).toBe(403);
  });

  test('last auto run: when the pipeline last saved stories, and how many were verified', async () => {
    expect((await get('/pipeline/last-run')).body).toEqual({ lastRun: null });
    supabase.__seed('ca_stories', [
      storyRow({ n: 1, status: 'review', review_notes: 'AUTO: VERIFIED', created_at: '2026-11-09T00:31:00Z' }),
      storyRow({ n: 2, status: 'review', review_notes: 'AUTO: CHECK - the figure', created_at: '2026-11-09T00:32:00Z' }),
      storyRow({ n: 3, status: 'review', review_notes: null, created_at: '2026-11-09T05:00:00Z' }),
    ]);
    expect((await get('/pipeline/last-run')).body.lastRun).toEqual({ at: '2026-11-09T00:32:00Z', date: '2026-11-09', saved: 2, verified: 1 });
  });
});

describe('quiz question ↔ story link', () => {
  const q = (over) => ({
    week_start: '2026-11-08', age_group: '7-12', category: 'india', question_type: 'true_false',
    question: 'Q?', options: ['True', 'False'], correct_index: 0, explanation: 'Because.', ...over,
  });

  test('no story is fine (written by an editor)', async () => {
    const res = await send('post', '/quiz', q());
    expect(res.status).toBe(201);
    expect(res.body.warnings).toEqual([]);
  });

  test('an unknown, invalid or rejected story is refused with a clear message', async () => {
    const rejected = storyRow({ status: 'rejected' });
    supabase.__seed('ca_stories', [rejected]);
    expect((await send('post', '/quiz', q({ story_id: 'abc' }))).body.error).toBe('story_id is not a valid story id');
    expect((await send('post', '/quiz', q({ story_id: '00000000-0000-4000-8000-000000000000' }))).body.error).toBe('story_id does not match any story');
    const res = await send('post', '/quiz', q({ story_id: rejected.id }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('story_id points to a rejected story');
  });

  test('a story from outside the quiz week only warns, on create and on edit', async () => {
    const inWeek = storyRow({ n: 1, publish_date: '2026-11-03', status: 'review' });
    const old = storyRow({ n: 2, publish_date: '2026-10-20' });
    supabase.__seed('ca_stories', [inWeek, old]);
    const ok = await send('post', '/quiz', q({ story_id: inWeek.id }));
    expect(ok.status).toBe(201);
    expect(ok.body.warnings).toEqual([]);
    const edited = await send('patch', `/quiz/${ok.body.question.id}`, { story_id: old.id });
    expect(edited.status).toBe(200);
    expect(edited.body.warnings[0].message).toContain("published on 2026-10-20, outside this quiz's week (2026-11-02 to 2026-11-08)");
  });
});

describe('quiz', () => {
  test("lists this week's questions with answers, in order", async () => {
    supabase.__seed('ca_quiz_questions', weekQuestions({ status: 'review' }));
    const res = await get('/quiz?ageGroup=7-12');
    expect(res.status).toBe(200);
    expect(res.body.weekStart).toBe('2026-11-08');
    expect(res.body.questions.map((q) => q.question)).toEqual(['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8', 'Q9', 'Q10']);
    expect(res.body.questions[0]).toHaveProperty('correct_index', 1);
    expect((await get('/quiz?ageGroup=7-12&weekStart=2026-11-09')).status).toBe(400); // not a Sunday
  });

  test('editing keeps the answer pointing at an option', async () => {
    const q = questionRow({ status: 'review' });
    supabase.__seed('ca_quiz_questions', [q]);
    expect((await send('patch', `/quiz/${q.id}`, { correct_index: 7 })).status).toBe(400);
    expect((await send('patch', `/quiz/${q.id}`, { options: ['Yes', 'No'] })).status).toBe(200); // answer 1 still valid
    expect((await send('patch', `/quiz/${q.id}`, { options: ['Only one'] })).status).toBe(400);
    const ok = await send('patch', `/quiz/${q.id}`, { question: 'Better question?', correct_index: 0, explanation: 'Clearer.' });
    expect(ok.body.question).toMatchObject({ question: 'Better question?', correct_index: 0, explanation: 'Clearer.' });
  });

  test('publishing a week makes the quiz playable; rejected questions stay out', async () => {
    const qs = weekQuestions({ status: 'review' });
    qs[9].status = 'rejected';
    supabase.__seed('ca_quiz_questions', qs);
    const before = await request(app).get('/current-affairs/quiz/week?ageGroup=7-12');
    expect(before.body.questions || []).toHaveLength(0);

    const pub = await send('post', '/quiz/publish', { weekStart: '2026-11-08', ageGroup: '7-12' });
    expect(pub.body).toEqual({ published: 9 });
    const after = await request(app).get('/current-affairs/quiz/week?ageGroup=7-12');
    expect(after.body.questions).toHaveLength(9);
    expect(after.body.questions[0]).not.toHaveProperty('correct_index');
  });

  test('a question sent with an old age group (8-12) is saved as 7-12', async () => {
    const old = await send('post', '/quiz', {
      week_start: '2026-11-08', age_group: '8-12', category: 'india', question_type: 'true_false',
      question: 'Delhi is the capital.', options: ['True', 'False'], correct_index: 0, explanation: 'It is.',
    });
    expect(old.status).toBe(201);
    expect(old.body.question.age_group).toBe('7-12');
  });

  test('an editor can add a question and see the week in the list', async () => {
    const res = await send('post', '/quiz', {
      week_start: '2026-11-08', age_group: '13-15', category: 'world', question_type: 'true_false',
      question: 'The Pacific is the largest ocean.', options: ['True', 'False'], correct_index: 0, explanation: 'It is.',
    });
    expect(res.status).toBe(201);
    expect(res.body.question).toMatchObject({ status: 'review', age_group: '13-15' });
    const weeks = await get('/quiz/weeks');
    expect(weeks.body.weeks).toEqual([{ weekStart: '2026-11-08', ageGroup: '13-15', counts: { review: 1 } }]);
  });
});

describe('analytics', () => {
  test('computes the metrics from reads, finished digests and quiz attempts', async () => {
    const s1 = storyRow({ n: 1 });
    supabase.__seed('ca_stories', [s1]);
    supabase.__seed('ca_story_reads', [
      // a: reads on 2 days, finishes the digest on 1; b: reads on 1 day
      { student_email: 'a@x.in', story_id: s1.id, age_group: '7-12', read_date: '2026-11-08', duration_seconds: 60 },
      { student_email: 'a@x.in', story_id: 's2', age_group: '7-12', read_date: '2026-11-08', duration_seconds: 120 },
      { student_email: 'a@x.in', story_id: 's3', age_group: '7-12', read_date: '2026-11-09', duration_seconds: null },
      { student_email: 'b@x.in', story_id: s1.id, age_group: '7-12', read_date: '2026-11-09', duration_seconds: 90 },
      // c only in the earlier month: counts for retention, not for this range
      { student_email: 'c@x.in', story_id: s1.id, age_group: '7-12', read_date: '2026-09-20', duration_seconds: 30 },
      { student_email: 'a@x.in', story_id: 's4', age_group: '7-12', read_date: '2026-09-25', duration_seconds: 30 },
    ]);
    supabase.__seed('ca_digest_views', [{ student_email: 'a@x.in', age_group: '7-12', view_date: '2026-11-08', story_count: 2 }]);
    supabase.__seed('ca_quiz_attempts', [{ student_email: 'a@x.in', age_group: '7-12', week_start: '2026-11-08', percentage: 80 }]);
    supabase.__seed('ca_progress', [
      { student_email: 'a@x.in', age_group: '7-12', current_streak: 2, updated_at: '2026-11-09T05:00:00Z' },
      { student_email: 'b@x.in', age_group: '7-12', current_streak: 1, updated_at: '2026-11-09T05:00:00Z' },
    ]);

    const res = await get('/analytics?from=2026-11-08&to=2026-11-09');
    expect(res.status).toBe(200);
    expect(res.body.activeStudents).toBe(2);
    const m = res.body.metrics;
    expect(m.digestCompletionRate).toMatchObject({ value: 33.3, completed: 1, readingDays: 3 });
    expect(m.avgReadingSeconds.value).toBe(90);            // (60 + 120 + 90) / 3 timed reads
    expect(m.avgMinutesPerDay.value).toBe(2.3);            // a: 3 min on the 8th; b: 1.5 min on the 9th
    expect(m.quizParticipation).toMatchObject({ value: 50, players: 1 });
    expect(m.quizAccuracy.value).toBe(80);
    expect(m.retention30).toMatchObject({ value: 50, previous: 2, retained: 1 }); // a came back, c did not
    expect(m.dailyActiveReaders.value).toBe(1.5);          // 1 on the 8th, 2 on the 9th
    expect(m.avgStreak.value).toBe(1.5);
    expect(res.body.daily).toEqual([
      { date: '2026-11-08', readers: 1, storiesRead: 2, digestsCompleted: 1 },
      { date: '2026-11-09', readers: 2, storiesRead: 2, digestsCompleted: 0 },
    ]);
  });

  test('defaults to the last 30 days; rejects bad ranges', async () => {
    const res = await get('/analytics');
    expect(res.body.range).toMatchObject({ from: '2026-10-11', to: '2026-11-09', days: 30, ageGroup: 'all' });
    expect(res.body.metrics.digestCompletionRate.value).toBeNull(); // no data yet: no made-up zeros
    expect((await get('/analytics?from=2026-11-09&to=2026-11-01')).status).toBe(400);
    expect((await get('/analytics?from=2025-01-01&to=2026-11-09')).status).toBe(400);
  });
});
