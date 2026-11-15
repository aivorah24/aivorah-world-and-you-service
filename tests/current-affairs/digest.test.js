jest.mock('../../services/supabase', () => require('./helpers/fakeSupabase').createFakeSupabase());
jest.mock('../../services/firebaseAdmin', () => require('./helpers/fakeFirebase'));
// index.js also loads World & You's AI routes, which create a Groq client on load.
jest.mock('../../services/dailyTidbit', () => ({}));
jest.mock('../../services/world', () => ({}));

const request = require('supertest');
const app = require('../../index');
const supabase = require('../../services/supabase');
const { freezeTime, storyRow, auth } = require('./helpers/fixtures');

const EMAIL = 'kid@school.in';

beforeEach(() => {
  supabase.__reset();
  freezeTime('2026-11-09T06:00:00Z'); // 11:30 in India, Monday 9 Nov
});
afterEach(() => jest.useRealTimers());

function seedStories(count, overrides = {}) {
  const rows = Array.from({ length: count }, (_, i) => storyRow({ n: i + 1, priority: i, ...overrides }));
  supabase.__seed('ca_stories', rows);
  return rows;
}

describe('GET /current-affairs/digest/today', () => {
  test('7-12 gets 6 stories, highest priority first, in the kid version with 1 new word', async () => {
    seedStories(12);
    const res = await request(app).get('/current-affairs/digest/today?ageGroup=7-12');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ date: '2026-11-09', isToday: true, ageGroup: '7-12', target: 6, completed: false });
    expect(res.body.stories).toHaveLength(6);
    expect(res.body.stories[0].title).toBe('Kid title 12');
    expect(res.body.stories[0]).toMatchObject({
      summary: 'Kid summary', whatHappened: 'Something happened in detail.', category: 'india', source: 'ISRO', read: false,
    });
    expect(res.body.stories[0].newWords).toEqual([{ word: 'Rover', definition: 'A vehicle that explores.' }]);
    expect(res.body.stories[0].readTimeSeconds).toBeGreaterThanOrEqual(30);
  });

  test('13-15 gets 7 teen stories with 3 words', async () => {
    seedStories(20);
    const teen = await request(app).get('/current-affairs/digest/today?ageGroup=13-15');
    expect(teen.status).toBe(200);
    expect(teen.body).toMatchObject({ ageGroup: '13-15', target: 7 });
    expect(teen.body.stories).toHaveLength(7);
    expect(teen.body.stories[0].title).toMatch(/^Teen title/);
    expect(teen.body.stories[0].newWords).toHaveLength(3);
  });

  describe('old age-group values from old app versions', () => {
    test.each([
      ['under-8', '7-12', /^Kid title/, 6],
      ['8-12', '7-12', /^Kid title/, 6],
      ['13%2B', '13-15', /^Teen title/, 7],
      ['13+', '13-15', /^Teen title/, 7], // an unencoded "+" arrives as a space
    ])('ageGroup=%s is read as %s', async (sent, expected, title, count) => {
      seedStories(20);
      const res = await request(app).get(`/current-affairs/digest/today?ageGroup=${sent}`);
      expect(res.status).toBe(200);
      expect(res.body.ageGroup).toBe(expected);
      expect(res.body.stories).toHaveLength(count);
      expect(res.body.stories[0].title).toMatch(title);
    });

    test('the retired under-8 (young) text is never shown', async () => {
      seedStories(3);
      const res = await request(app).get('/current-affairs/digest/today?ageGroup=under-8');
      expect(JSON.stringify(res.body)).not.toMatch(/Young/);
    });

    test('a story asked for in an old age group comes back in the new version', async () => {
      const [story] = seedStories(1);
      const res = await request(app).get(`/current-affairs/story/${story.id}?ageGroup=under-8`);
      expect(res.status).toBe(200);
      expect(res.body.story.title).toMatch(/^Kid title/);
    });

    test('unknown values are still rejected, naming the new values', async () => {
      const res = await request(app).get('/current-affairs/digest/today?ageGroup=adult');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("ageGroup must be one of '7-12', '13-15'");
    });
  });

  test('per-age extras override the shared fact; new words always come from new_word_1..3', async () => {
    seedStories(1, { age_extras: { kid: { didYouKnow: 'Kid fact', newWords: [{ word: 'Moon', definition: 'It shines at night.' }] } } });
    const res = await request(app).get('/current-affairs/digest/today?ageGroup=7-12');
    expect(res.body.stories[0].didYouKnow).toBe('Kid fact');
    expect(res.body.stories[0].newWords).toEqual([{ word: 'Rover', definition: 'A vehicle that explores.' }]);
  });

  test('13-15 sees the 2-3 words that are filled in; 7-12 only the first', async () => {
    seedStories(1, { new_word_3: '', def_3: '' });
    const teen = await request(app).get('/current-affairs/digest/today?ageGroup=13-15');
    expect(teen.body.stories[0].newWords.map((w) => w.word)).toEqual(['Rover', 'Lunar']);
    const kid = await request(app).get('/current-affairs/digest/today?ageGroup=7-12');
    expect(kid.body.stories[0].newWords.map((w) => w.word)).toEqual(['Rover']);
  });

  test('stories waiting for review, rejected or for other days are never shown', async () => {
    seedStories(2);
    seedStories(3, { status: 'review' });
    seedStories(1, { status: 'rejected' });
    seedStories(4, { publish_date: '2026-11-10' }); // tomorrow
    const res = await request(app).get('/current-affairs/digest/today?ageGroup=7-12');
    expect(res.body.stories).toHaveLength(2);
  });

  test('falls back to the most recent digest when nothing is published today', async () => {
    seedStories(2, { publish_date: '2026-11-07' });
    seedStories(1, { publish_date: '2026-11-05' });
    const res = await request(app).get('/current-affairs/digest/today?ageGroup=7-12');
    expect(res.body).toMatchObject({ date: '2026-11-07', isToday: false });
    expect(res.body.stories).toHaveLength(2);
  });

  test('returns an empty digest when nothing has ever been published', async () => {
    const res = await request(app).get('/current-affairs/digest/today?ageGroup=7-12');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ date: null, stories: [], readCount: 0 });
  });

  test('"today" is the India calendar day, not UTC', async () => {
    freezeTime('2026-11-08T20:00:00Z'); // still Sunday in UTC, already 01:30 Monday in India
    seedStories(1, { publish_date: '2026-11-09' });
    const res = await request(app).get('/current-affairs/digest/today?ageGroup=7-12');
    expect(res.body).toMatchObject({ date: '2026-11-09', isToday: true });
  });

  test('a past date can be requested; a future date cannot', async () => {
    seedStories(1, { publish_date: '2026-11-01' });
    const past = await request(app).get('/current-affairs/digest/today?ageGroup=7-12&date=2026-11-01');
    expect(past.body).toMatchObject({ date: '2026-11-01', isToday: false });
    expect(past.body.stories).toHaveLength(1);
    const future = await request(app).get('/current-affairs/digest/today?ageGroup=7-12&date=2026-11-20');
    expect(future.status).toBe(400);
  });

  test("with studentEmail, marks the student's read stories and whether today's digest is done", async () => {
    const [a, b] = seedStories(3);
    supabase.__seed('ca_story_reads', [
      { student_email: EMAIL, story_id: a.id }, { student_email: EMAIL, story_id: b.id },
      { student_email: 'other@school.in', story_id: 'x' },
    ]);
    supabase.__seed('ca_digest_views', [{ student_email: EMAIL, view_date: '2026-11-09' }]);
    const res = await request(app)
      .get(`/current-affairs/digest/today?ageGroup=7-12&studentEmail=${encodeURIComponent('Kid@School.in')}`)
      .set(auth(EMAIL));
    expect(res.status).toBe(200);
    expect(res.body.readCount).toBe(2);
    expect(res.body.completed).toBe(true);
    expect(res.body.stories.filter((s) => s.read).map((s) => s.id).sort()).toEqual([a.id, b.id].sort());
  });

  test("another student's read status needs their own sign-in", async () => {
    seedStories(1);
    const noToken = await request(app).get(`/current-affairs/digest/today?ageGroup=7-12&studentEmail=${EMAIL}`);
    expect(noToken.status).toBe(401);
    const wrong = await request(app)
      .get(`/current-affairs/digest/today?ageGroup=7-12&studentEmail=${EMAIL}`)
      .set(auth('someone@else.in'));
    expect(wrong.status).toBe(403);
  });

  test('rejects a missing or unknown age group', async () => {
    expect((await request(app).get('/current-affairs/digest/today')).status).toBe(400);
    expect((await request(app).get('/current-affairs/digest/today?ageGroup=adult')).status).toBe(400);
  });
});

// A query that fails like PostgREST does when a table/function is missing.
function failingQuery(code, message) {
  const q = {};
  for (const m of ['select', 'eq', 'in', 'lte', 'gte', 'order', 'limit', 'maybeSingle']) q[m] = () => q;
  q.then = (resolve) => resolve({ data: null, error: { code, message } });
  return q;
}

describe('when the database is not set up', () => {
  test.each(['PGRST205', '42P01'])('a missing table (%s) answers 503 "not ready yet", not a generic 500', async (code) => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(supabase, 'from').mockReturnValueOnce(failingQuery(code, "Could not find the table 'public.ca_stories'"));
    const res = await request(app).get('/current-affairs/digest/today?ageGroup=7-12');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'Current Affairs is not ready yet. Please check back soon.', reason: 'database tables missing' });
    error.mockRestore();
  });

  test('other database errors stay a 500', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(supabase, 'from').mockReturnValueOnce(failingQuery('57014', 'statement timeout'));
    const res = await request(app).get('/current-affairs/digest/today?ageGroup=7-12');
    expect(res.status).toBe(500);
    error.mockRestore();
  });
});

describe('GET /current-affairs/digest/list', () => {
  test('lists published dates newest first with story counts, up to the limit', async () => {
    seedStories(3, { publish_date: '2026-11-09' });
    seedStories(2, { publish_date: '2026-11-08' });
    seedStories(1, { publish_date: '2026-11-06' });
    seedStories(5, { publish_date: '2026-11-07', status: 'review' });
    seedStories(1, { publish_date: '2026-11-12' });

    const res = await request(app).get('/current-affairs/digest/list');
    expect(res.status).toBe(200);
    expect(res.body.dates).toEqual([
      { date: '2026-11-09', storyCount: 3 },
      { date: '2026-11-08', storyCount: 2 },
      { date: '2026-11-06', storyCount: 1 },
    ]);
    const limited = await request(app).get('/current-affairs/digest/list?limit=2');
    expect(limited.body.dates).toHaveLength(2);
  });
});

describe('GET /current-affairs/story/:id', () => {
  test('returns the published story in the requested age version', async () => {
    const [row] = seedStories(1);
    const res = await request(app).get(`/current-affairs/story/${row.id}?ageGroup=13%2B`);
    expect(res.status).toBe(200);
    expect(res.body.story).toMatchObject({
      id: row.id, title: 'Teen title 1', whyImportant: 'It matters because of impact.',
      didYouKnow: 'A fact.', thinkAboutIt: 'What do you think?', sourceUrl: 'https://www.isro.gov.in/x',
    });
  });

  test('unpublished, unknown and malformed ids are not found', async () => {
    const [row] = seedStories(1, { status: 'review' });
    expect((await request(app).get(`/current-affairs/story/${row.id}`)).status).toBe(404);
    expect((await request(app).get('/current-affairs/story/6f1c2a10-0000-4000-8000-00000000abcd')).status).toBe(404);
    expect((await request(app).get('/current-affairs/story/not-a-uuid')).status).toBe(404);
  });
});
