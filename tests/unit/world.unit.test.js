const mockGroqCreate = jest.fn();
jest.mock('groq-sdk', () => jest.fn().mockImplementation(() => ({
  chat: { completions: { create: (...args) => mockGroqCreate(...args) } },
})));
jest.mock('axios');
const axios = require('axios');

const { getWorldDaily } = require('../../services/world');

function groqResponse(content) {
  return { choices: [{ message: { content } }] };
}

function fullGroqContentJson(overrides = {}) {
  return JSON.stringify({
    onThisDay: [{ year: 1969, fact: 'Moon landing.' }],
    gkFact: { title: 'Did You Know?', fact: 'Octopuses have three hearts.', category: 'Science' },
    funChallenge: { question: 'Why is the sky blue?', answer: 'Light scattering.' },
    ...overrides,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.NEWS_API_KEY;
});

describe('getWorldDaily — no NEWS_API_KEY (fallback current affairs)', () => {
  test('returns real onThisDay, gkFact, funChallenge, and fallback current affairs', async () => {
    mockGroqCreate
      .mockResolvedValueOnce(groqResponse(fullGroqContentJson())) // generateGroqContent
      .mockResolvedValueOnce(groqResponse(JSON.stringify([{ headline: 'World News', detail: 'Good things happened.' }]))); // affairs fallback

    const result = await getWorldDaily('Grade 6 Unit A');

    expect(result.grade).toBe('Grade 6 Unit A');
    expect(result.onThisDay).toEqual([{ year: 1969, fact: 'Moon landing.' }]);
    expect(result.gkFact.fact).toBe('Octopuses have three hearts.');
    expect(result.funChallenge.answer).toBe('Light scattering.');
    expect(result.currentAffairs).toEqual([{ headline: 'World News', detail: 'Good things happened.' }]);
  });

  test('a second call for the same grade+day is served from the real in-memory cache (no new Groq calls)', async () => {
    mockGroqCreate
      .mockResolvedValueOnce(groqResponse(fullGroqContentJson()))
      .mockResolvedValueOnce(groqResponse(JSON.stringify([{ headline: 'H', detail: 'D' }])));

    await getWorldDaily('Grade 6 Unit B');
    mockGroqCreate.mockClear();

    await getWorldDaily('Grade 6 Unit B');

    expect(mockGroqCreate).not.toHaveBeenCalled();
  });

  test('a malformed content-generation JSON response throws (surfaced to the route as a 500)', async () => {
    mockGroqCreate.mockResolvedValueOnce(groqResponse('not valid json and no braces'));
    await expect(getWorldDaily('Grade 6 Unit C')).rejects.toThrow();
  });

  test('real defaults are applied when the Groq content is missing onThisDay/gkFact/funChallenge fields', async () => {
    mockGroqCreate
      .mockResolvedValueOnce(groqResponse(JSON.stringify({})))
      .mockResolvedValueOnce(groqResponse(JSON.stringify([{ headline: 'H', detail: 'D' }])));

    const result = await getWorldDaily('Grade 6 Unit D');

    expect(result.onThisDay).toEqual([]);
    expect(result.gkFact).toEqual({ title: 'Did You Know?', fact: 'Loading...', category: 'Science' });
    expect(result.funChallenge).toEqual({ question: 'Think about it!', answer: 'Keep exploring!' });
  });

  test('a broken affairs-fallback JSON response degrades to a real friendly default, not a crash', async () => {
    mockGroqCreate
      .mockResolvedValueOnce(groqResponse(fullGroqContentJson()))
      .mockResolvedValueOnce(groqResponse('not json'));

    const result = await getWorldDaily('Grade 6 Unit E');

    expect(result.currentAffairs).toEqual([{ headline: 'World News', detail: "Check back soon for today's top stories!" }]);
  });
});

describe('getWorldDaily — with a real NEWS_API_KEY set', () => {
  beforeEach(() => { process.env.NEWS_API_KEY = 'real-key'; });

  test('filters excluded-keyword articles and simplifies the remaining ones via Groq', async () => {
    axios.get.mockResolvedValue({
      data: {
        articles: [
          { title: 'Football match result', description: 'sports desc' },
          { title: 'New telescope discovers galaxy', description: 'A new galaxy was found.' },
          { title: 'Robot helps in surgery', description: 'A robot assisted doctors.' },
        ],
      },
    });
    mockGroqCreate
      .mockResolvedValueOnce(groqResponse(fullGroqContentJson()))
      .mockResolvedValueOnce(groqResponse(JSON.stringify([{ headline: 'Galaxy Found!', detail: 'Cool space news.' }, { headline: 'Robot Surgery', detail: 'Amazing tech.' }])));

    const result = await getWorldDaily('Grade 5 Unit F');

    expect(result.currentAffairs).toEqual([{ headline: 'Galaxy Found!', detail: 'Cool space news.' }, { headline: 'Robot Surgery', detail: 'Amazing tech.' }]);
  });

  test('a simplified-articles response array is capped at 2 entries', async () => {
    axios.get.mockResolvedValue({
      data: { articles: [
        { title: 'Story A', description: 'a' }, { title: 'Story B', description: 'b' },
      ] },
    });
    mockGroqCreate
      .mockResolvedValueOnce(groqResponse(fullGroqContentJson()))
      .mockResolvedValueOnce(groqResponse(JSON.stringify([{ headline: '1' }, { headline: '2' }, { headline: '3' }])));

    const result = await getWorldDaily('Grade 5 Unit G');

    expect(result.currentAffairs).toHaveLength(2);
  });

  test('fewer than 2 usable articles falls back to the Groq-generated affairs', async () => {
    axios.get.mockResolvedValue({ data: { articles: [{ title: 'Only one usable', description: 'desc' }] } });
    mockGroqCreate
      .mockResolvedValueOnce(groqResponse(fullGroqContentJson()))
      .mockResolvedValueOnce(groqResponse(JSON.stringify([{ headline: 'Fallback', detail: 'D' }])));

    const result = await getWorldDaily('Grade 5 Unit H');

    expect(result.currentAffairs).toEqual([{ headline: 'Fallback', detail: 'D' }]);
  });

  test('a NewsAPI request failure falls back to the Groq-generated affairs', async () => {
    axios.get.mockRejectedValue(new Error('timeout'));
    mockGroqCreate
      .mockResolvedValueOnce(groqResponse(fullGroqContentJson()))
      .mockResolvedValueOnce(groqResponse(JSON.stringify([{ headline: 'Fallback2', detail: 'D' }])));

    const result = await getWorldDaily('Grade 5 Unit I');

    expect(result.currentAffairs).toEqual([{ headline: 'Fallback2', detail: 'D' }]);
  });
});
