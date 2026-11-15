// The daily pipeline with a fake Supabase, a mocked AI and mocked web pages: no network.
jest.mock('../../services/supabase', () => require('./helpers/fakeSupabase').createFakeSupabase());
jest.mock('../../services/firebaseAdmin', () => require('./helpers/fakeFirebase'));
jest.mock('../../services/dailyTidbit', () => ({}));
jest.mock('../../services/world', () => ({}));

const request = require('supertest');
const supabase = require('../../services/supabase');
const { collect } = require('../../current-affairs/pipeline/collect');
const { applyPicks, isSuitable } = require('../../current-affairs/pipeline/select');
const { verify, extractPageText } = require('../../current-affairs/pipeline/verify');
const { write, checkWritten } = require('../../current-affairs/pipeline/write');
const { runDailyPipeline } = require('../../current-affairs/pipeline/run');
const { createLlm } = require('../../current-affairs/pipeline/llm');
const { FEEDS, PIB_INDEX } = require('../../current-affairs/pipeline/feeds');
const { urlHash } = require('../../current-affairs/services/sourceUrl');
const { toStory } = require('../../current-affairs/services/content');
const { storyRow } = require('./helpers/fixtures');

const NOW = new Date('2026-11-15T03:00:00Z'); // 8:30 in India
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600 * 1000).toUTCString();
const words = (n, w = 'word') => Array.from({ length: n }, (_, i) => `${w}${i}`).join(' ');

const rss = (items) => `<?xml version="1.0"?><rss><channel>${items.map((i) => `<item><title><![CDATA[${i.title}]]></title>
  <link>${i.link}</link><description><![CDATA[<p>${i.summary || 'A summary.'}</p>]]></description><pubDate>${i.date}</pubDate></item>`).join('')}</channel></rss>`;
const ARTICLE = `<html><head><script>var x = 1;</script><style>p{}</style></head><body><nav>Home | News</nav>
  <article><p>${words(40, 'fact')} The minister announced a new school library plan for every district today in New Delhi.</p>
  <p>${words(30, 'more')} The plan will add books in many languages for children across the country.</p></article><footer>Copyright</footer></body></html>`;

// fetch mock: url → { status, body }; anything else is a 404.
function fetchFrom(pages) {
  return jest.fn(async (url) => {
    const page = pages[url];
    if (!page) return { ok: false, status: 404, text: async () => '' };
    if (page.throws) throw new Error(page.throws);
    return { ok: (page.status || 200) < 400, status: page.status || 200, text: async () => page.body };
  });
}

// The AI, by step. select picks by index; verify/write answer from queues.
function fakeAi({ selected, verdicts = [], writes = [] } = {}) {
  const v = [...verdicts]; const w = [...writes];
  const ask = jest.fn(async (prompt, { step }) => {
    if (step === 'select') return { selected };
    if (step === 'verify') return v.shift() || { result: 'VERIFIED', note: 'Key facts match.' };
    if (step === 'write') {
      const next = w.length ? w.shift() : goodStory();
      if (next instanceof Error) throw next;
      return next;
    }
    throw new Error(`unexpected step ${step}`);
  });
  return { llm: createLlm({ ask }), ask };
}

function goodStory(over = {}) {
  return {
    v712: { title: 'Libraries for every district', summary: 'New libraries are coming.', what_happened: words(60), why_important: 'More children can read.' },
    v1315: { title: 'A national library plan', summary: 'Each district gets a library.', what_happened: words(120), why_important: 'Reading helps learning. It reaches villages.' },
    did_you_know: 'The plan covers many languages.',
    words: [{ word: 'Library', definition: 'A place with books to read.' }, { word: 'District', definition: 'A part of a state.' }, { word: 'Initiative', definition: 'A new plan to do something.' }],
    think_about_it: 'Which book would you borrow first?',
    ...over,
  };
}

const ONE_FEED = [{ source: 'The Hindu', category: 'india', url: 'https://feeds.test/india.rss' }];

beforeEach(() => supabase.__reset());

describe('collect', () => {
  test('a failing feed is skipped and reported; the others are read', async () => {
    const feeds = [...ONE_FEED, { source: 'UN News', category: 'world', url: 'https://feeds.test/down.rss' }];
    const fetchImpl = fetchFrom({ 'https://feeds.test/india.rss': { body: rss([{ title: 'School libraries plan', link: 'https://news.test/a', date: hoursAgo(2) }]) } });
    const { items, report } = await collect({ supabase, fetchImpl, now: NOW, feeds });
    expect(items.map((i) => i.title)).toEqual(['School libraries plan']);
    expect(report.feedsFailed).toEqual([{ source: 'UN News', url: 'https://feeds.test/down.rss', reason: 'HTTP 404' }]);
    // one retry for the failing feed
    expect(fetchImpl.mock.calls.filter(([u]) => u === 'https://feeds.test/down.rss')).toHaveLength(2);
  });

  test('keeps only the last 24 hours; strips HTML from summaries', async () => {
    const fetchImpl = fetchFrom({ 'https://feeds.test/india.rss': { body: rss([
      { title: 'Fresh news item', link: 'https://news.test/fresh', date: hoursAgo(5), summary: '<b>Bold</b> &amp; clear' },
      { title: 'Old news item', link: 'https://news.test/old', date: hoursAgo(30) },
    ]) } });
    const { items, report } = await collect({ supabase, fetchImpl, now: NOW, feeds: ONE_FEED });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: 'Fresh news item', summary: 'Bold & clear', source: 'The Hindu' });
    expect(report.tooOld).toBe(1);
  });

  test('duplicate links and near-identical titles are removed', async () => {
    const fetchImpl = fetchFrom({ 'https://feeds.test/india.rss': { body: rss([
      { title: 'India launches new weather satellite today', link: 'https://news.test/sat?utm_source=rss', date: hoursAgo(1) },
      { title: 'Another title entirely different words', link: 'https://www.news.test/sat', date: hoursAgo(2) },
      { title: 'India launches new weather satellite today!', link: 'https://news.test/sat-2', date: hoursAgo(3) },
      { title: 'Monsoon rainfall report released', link: 'https://news.test/rain', date: hoursAgo(4) },
    ]) } });
    const { items, report } = await collect({ supabase, fetchImpl, now: NOW, feeds: ONE_FEED });
    expect(items.map((i) => i.link)).toEqual(['https://news.test/sat?utm_source=rss', 'https://news.test/rain']);
    expect(report.duplicates).toBe(2);
  });

  test('a link already saved in any status (rejected included) is skipped', async () => {
    supabase.__seed('ca_stories', [storyRow({ status: 'rejected', source_url_hash: urlHash('https://news.test/seen') })]);
    const fetchImpl = fetchFrom({ 'https://feeds.test/india.rss': { body: rss([
      { title: 'Seen before story', link: 'https://www.news.test/seen/', date: hoursAgo(1) },
      { title: 'Brand new story here', link: 'https://news.test/new', date: hoursAgo(1) },
    ]) } });
    const { items, report } = await collect({ supabase, fetchImpl, now: NOW, feeds: ONE_FEED });
    expect(items.map((i) => i.title)).toEqual(['Brand new story here']);
    expect(report.alreadySaved).toBe(1);
  });

  test('PIB feeds are read from its RSS page; if none are found PIB is skipped and reported', async () => {
    const PIB_FEED = 'https://www.pib.gov.in/RssMain.aspx?ModId=6&Lang=1&Regid=3';
    const pages = {
      [PIB_INDEX.url]: { body: '<a href="RssMain.aspx?ModId=6&amp;Lang=1&amp;Regid=3">Releases</a>' },
      [PIB_FEED]: { body: rss([{ title: 'Cabinet approves new rail line', link: 'https://pib.gov.in/PressRelease.aspx?PRID=1', date: hoursAgo(3) }]) },
    };
    const withPib = await collect({ supabase, fetchImpl: fetchFrom(pages), now: NOW });
    expect(withPib.items.find((i) => i.source === 'PIB')).toMatchObject({ title: 'Cabinet approves new rail line', feedCategory: 'india' });
    // A feed with no dates is skipped and reported (PIB sends none today).
    pages[PIB_FEED] = { body: '<rss><channel><item><title>No date here</title><link>https://pib.gov.in/x</link></item></channel></rss>' };
    const undated = await collect({ supabase, fetchImpl: fetchFrom(pages), now: NOW });
    expect(undated.report.feedsFailed.find((f) => f.url === PIB_FEED).reason).toBe('no publish dates in the feed');
    const noPib = await collect({ supabase, fetchImpl: fetchFrom({}), now: NOW });
    expect(noPib.report.feedsFailed.find((f) => f.source === 'PIB').reason).toMatch(/^PIB skipped/);
    expect(noPib.report.feedsFailed).toHaveLength(FEEDS.length + 1);
  });
});

describe('select', () => {
  const item = (i, category = 'india') => ({ title: `Item ${i}`, summary: 'S', link: `https://n.test/${i}`, source: 'The Hindu', feedCategory: category, hash: `h${i}` });

  test('keeps 5-7 stories within the category split, best scores first, never padding', () => {
    const items = Array.from({ length: 12 }, (_, i) => item(i));
    const pick = (index, category, score) => ({ index, category, score, why: 'w', key_facts: ['fact'] });
    const picks = applyPicks(items, [
      pick(0, 'india', 5), pick(1, 'india', 5), pick(2, 'india', 4), pick(3, 'india', 4), // 4th India is over the cap
      pick(4, 'world', 5), pick(5, 'world', 4), pick(6, 'world', 3),                         // 3rd World is over
      pick(7, 'science', 4), pick(8, 'science', 3),                                          // 2nd Science is over
      pick(9, 'sports', 3), pick(10, 'society', 5),                                          // one of sports/env/society
      pick(11, 'economy', 2),
    ]);
    expect(picks.length).toBeLessThanOrEqual(7);
    expect(picks.length).toBeGreaterThanOrEqual(5);
    const count = (c) => picks.filter((p) => p.category === c).length;
    expect(count('india')).toBe(3);
    expect(count('world')).toBe(2);
    expect(count('science')).toBe(1);
    expect(picks.filter((p) => ['sports', 'environment', 'society'].includes(p.category))).toHaveLength(1);
    expect(picks.find((p) => p.category === 'society')).toBeTruthy(); // the higher score won
  });

  test('fewer good items means fewer stories; bad picks are ignored', () => {
    const items = [item(0), item(1, 'world')];
    const picks = applyPicks(items, [
      { index: 0, category: 'india', score: 4, key_facts: ['a'] },
      { index: 1, category: 'world', score: 4, key_facts: [] },   // no facts
      { index: 7, category: 'world', score: 5, key_facts: ['x'] }, // not an item
      { index: 0, category: 'india', score: 3, key_facts: ['a'] }, // twice
    ]);
    expect(picks.map((p) => p.title)).toEqual(['Item 0']);
  });

  test('if the AI cannot be reached, nothing is selected and the report says why', async () => {
    const { select } = require('../../current-affairs/pipeline/select');
    const llm = createLlm({ ask: async () => { throw new Error('GROQ_API_KEY missing'); } });
    const { picks, report } = await select([item(0)], llm);
    expect(picks).toEqual([]);
    expect(report.error).toBe('AI selection failed: GROQ_API_KEY missing');
  });

  test('crime, betting, tenders, auctions and bank penalties never reach the AI', () => {
    for (const title of ['Man killed in road rage', 'Betting app banned', 'Tender for bridge work', 'Auction of spectrum', 'RBI imposes monetary penalty on bank']) {
      expect(isSuitable({ title, summary: '' })).toBe(false);
    }
    expect(isSuitable({ title: 'New national park opened', summary: 'Tigers and birds.' })).toBe(true);
  });
});

describe('verify', () => {
  const pick = (title, link) => ({ title, link, keyFacts: ['A library plan was announced'] });

  test('CONTRADICTED stories are dropped; an unreadable page is UNCLEAR without asking the AI', async () => {
    const { llm, ask } = fakeAi({ verdicts: [{ result: 'VERIFIED', note: 'ok' }, { result: 'CONTRADICTED', note: 'The page says 2025.' }] });
    const fetchImpl = fetchFrom({ 'https://n.test/a': { body: ARTICLE }, 'https://n.test/b': { body: ARTICLE } });
    const { kept, report } = await verify([pick('A', 'https://n.test/a'), pick('B', 'https://n.test/b'), pick('C', 'https://n.test/missing')], llm, { fetchImpl });
    expect(kept.map((k) => [k.title, k.verification.result])).toEqual([['A', 'VERIFIED'], ['C', 'UNCLEAR']]);
    expect(kept[1].verification.note).toBe('Source page could not be read, please open the link.');
    expect(report).toMatchObject({ verified: 1, unclear: 1, contradicted: 1 });
    expect(report.dropped[0]).toEqual({ title: 'B', reason: 'contradicted by the source: The page says 2025.' });
    expect(ask).toHaveBeenCalledTimes(2);
  });

  test('page text: scripts, styles, menus and footers removed', () => {
    const text = extractPageText(ARTICLE);
    expect(text).toMatch(/school library plan/);
    expect(text).not.toMatch(/var x|Home \| News|Copyright/);
  });
});

describe('write', () => {
  const item = { title: 'T', summary: 'S', keyFacts: ['f'], pageText: 'Source text.' };

  test('word counts follow the rules: 7-12 45-90, 13-15 100-165', () => {
    expect(checkWritten(goodStory()).story.wordCounts).toEqual({ kid: 60, teen: 120 });
    expect(checkWritten(goodStory({ v712: { ...goodStory().v712, what_happened: words(30) } })).error).toMatch(/v712.what_happened has 30 words/);
    expect(checkWritten(goodStory({ v1315: { ...goodStory().v1315, what_happened: words(200) } })).error).toMatch(/v1315.what_happened has 200 words/);
    expect(checkWritten(goodStory({ words: [] })).error).toMatch(/words/);
  });

  test('invalid JSON is retried once, then the story is skipped with a reason', async () => {
    const { llm, ask } = fakeAi({ writes: [new Error('No JSON in the AI reply'), new Error('No JSON in the AI reply')] });
    const { stories, report } = await write([item], llm);
    expect(stories).toEqual([]);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(report.skipped[0].reason).toMatch(/after a retry \(not valid JSON/);
  });

  test('a wrong length is retried with the reason, and the fixed answer is used', async () => {
    const { llm, ask } = fakeAi({ writes: [goodStory({ v712: { ...goodStory().v712, what_happened: words(10) } }), goodStory()] });
    const { stories } = await write([item], llm);
    expect(stories).toHaveLength(1);
    expect(ask.mock.calls[1][0]).toMatch(/previous answer was not usable \(v712.what_happened has 10 words/);
  });
});

describe('runDailyPipeline', () => {
  const FEED_URL = FEEDS[0].url;
  const pages = () => ({
    [FEED_URL]: { body: rss([
      { title: 'District libraries announced', link: 'https://www.thehindu.com/a', date: hoursAgo(2) },
      { title: 'Solar mission sends first images', link: 'https://www.thehindu.com/b', date: hoursAgo(3) },
    ]) },
    'https://www.thehindu.com/a': { body: ARTICLE },
    'https://www.thehindu.com/b': { body: ARTICLE },
  });
  const selected = [
    { index: 0, category: 'india', score: 5, why: 'w', key_facts: ['A library plan was announced'] },
    { index: 1, category: 'science', score: 4, why: 'w', key_facts: ['A solar mission sent images'] },
  ];

  test('saved rows are always for review, never true facts, with the AUTO note', async () => {
    const { llm } = fakeAi({ selected, verdicts: [{ result: 'VERIFIED', note: 'ok' }, { result: 'UNCLEAR', note: 'Check the date of the images.' }] });
    const report = await runDailyPipeline({ supabase, fetchImpl: fetchFrom(pages()), llm, now: NOW, env: { CA_PIPELINE_ENABLED: 'true' } });
    expect(report).toMatchObject({ mode: 'write', saved: 2, written: 2 });
    const rows = supabase.__rows('ca_stories');
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r).toMatchObject({ status: 'review', is_true_fact: false, publish_date: '2026-11-15', source: 'The Hindu' });
      expect(r.source_url_hash).toBe(urlHash(r.source_url));
      expect(r.title_young).toBeUndefined();
    }
    expect(rows.map((r) => r.review_notes).sort()).toEqual(['AUTO: CHECK - Check the date of the images.', 'AUTO: VERIFIED']);
    expect(report.aiCalls).toEqual({ select: 1, verify: 2, write: 2, quiz: 0 });
  });

  test('from the saved row, 7-12 sees 1 word and 13-15 sees 2-3', async () => {
    const { llm } = fakeAi({ selected: selected.slice(0, 1) });
    await runDailyPipeline({ supabase, fetchImpl: fetchFrom(pages()), llm, now: NOW, env: { CA_PIPELINE_ENABLED: 'true' } });
    const [row] = supabase.__rows('ca_stories');
    expect(toStory(row, '7-12').newWords.map((w) => w.word)).toEqual(['Library']);
    expect(toStory(row, '13-15').newWords.map((w) => w.word)).toEqual(['Library', 'District', 'Initiative']);
  });

  test('a dry run writes nothing and lists the rows it would save', async () => {
    const { llm } = fakeAi({ selected });
    const report = await runDailyPipeline({ supabase, fetchImpl: fetchFrom(pages()), llm, now: NOW, dryRun: true, env: { CA_PIPELINE_ENABLED: 'true' } });
    expect(report.mode).toBe('dry-run');
    expect(report.rows).toHaveLength(2);
    expect(report.rows.every((r) => r.status === 'review' && r.is_true_fact === false)).toBe(true);
    expect(supabase.__rows('ca_stories')).toHaveLength(0);
  });

  test('without CA_PIPELINE_ENABLED=true nothing is written', async () => {
    const { llm } = fakeAi({ selected });
    const report = await runDailyPipeline({ supabase, fetchImpl: fetchFrom(pages()), llm, now: NOW, env: {} });
    expect(report.note).toMatch(/CA_PIPELINE_ENABLED/);
    expect(supabase.__rows('ca_stories')).toHaveLength(0);
  });

  test('AI calls are capped: 1 selection, up to 8 checks, up to 8 writes', async () => {
    const { llm, ask } = fakeAi({ writes: Array.from({ length: 9 }, () => new Error('No JSON')) });
    const items = Array.from({ length: 6 }, (_, i) => ({ title: `T${i}`, summary: 'S', keyFacts: ['f'], pageText: 'x' }));
    const { report } = await write(items, llm);
    expect(ask).toHaveBeenCalledTimes(8);
    expect(report.skipped.at(-1).reason).toMatch(/AI call limit for write reached \(8\)/);
  });
});

describe('POST /current-affairs/pipeline/run', () => {
  const app = require('../../index');
  afterEach(() => { delete process.env.CA_PIPELINE_SECRET; });

  test('refused without the secret set, with a missing or a wrong header', async () => {
    expect((await request(app).post('/current-affairs/pipeline/run').set('x-pipeline-secret', 'anything')).status).toBe(401);
    process.env.CA_PIPELINE_SECRET = 'right-secret';
    expect((await request(app).post('/current-affairs/pipeline/run')).status).toBe(401);
    expect((await request(app).post('/current-affairs/pipeline/run').set('x-pipeline-secret', 'wrong')).status).toBe(401);
  });

  test('with the right secret it starts in the background and answers with a run id', async () => {
    process.env.CA_PIPELINE_SECRET = 'right-secret';
    const pipeline = require('../../current-affairs/pipeline/run');
    const spy = jest.spyOn(pipeline, 'runDailyPipeline').mockResolvedValue({
      runId: 'r', date: '2026-11-15', mode: 'dry-run', feeds: { read: 0, failed: [] }, collected: {}, selected: {},
      verification: { dropped: [] }, written: 0, saved: 0, skipped: [],
    });
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const res = await request(app).post('/current-affairs/pipeline/run').set('x-pipeline-secret', 'right-secret');
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ runId: expect.any(String), started: true });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[ca-pipeline] r 2026-11-15'));
    spy.mockRestore();
    log.mockRestore();
  });
});
