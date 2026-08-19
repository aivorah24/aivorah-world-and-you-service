const mockGroqCreate = jest.fn();
jest.mock('groq-sdk', () => jest.fn().mockImplementation(() => ({
  chat: { completions: { create: (...args) => mockGroqCreate(...args) } },
})));
jest.mock('axios');
const axios = require('axios');

const {
  computeLevel,
  getDailyTidbit,
  generateComprehensionQuiz,
  normalizeQuizQuestions,
} = require('../../services/dailyTidbit');

function groqResponse(content) {
  return { choices: [{ message: { content } }] };
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.NEWS_API_KEY;
});

describe('computeLevel', () => {
  test('starts at level 1 with 0 xp', () => {
    expect(computeLevel(0)).toBe(1);
  });

  test('reaches level 2 exactly at the first threshold (500 xp)', () => {
    expect(computeLevel(499)).toBe(1);
    expect(computeLevel(500)).toBe(2);
  });
});

describe('normalizeQuizQuestions', () => {
  test('a non-array input returns an empty array', () => {
    expect(normalizeQuizQuestions(null)).toEqual([]);
    expect(normalizeQuizQuestions('not an array')).toEqual([]);
  });

  test('a letter correct answer ("B") is converted to its 0-based index', () => {
    const result = normalizeQuizQuestions([{ question: 'Q1', options: ['A', 'B', 'C', 'D'], correct: 'B' }]);
    expect(result[0].correct).toBe(1);
  });

  test('a numeric correct index passes through unchanged', () => {
    const result = normalizeQuizQuestions([{ question: 'Q1', options: ['A', 'B', 'C', 'D'], correct: 2 }]);
    expect(result[0].correct).toBe(2);
  });

  test('strips a real "A. " style prefix from option text', () => {
    const result = normalizeQuizQuestions([{ question: 'Q1', options: ['A. Paris', 'B. London', 'C. Rome', 'D. Berlin'], correct: 0 }]);
    expect(result[0].options).toEqual(['Paris', 'London', 'Rome', 'Berlin']);
  });

  test('does NOT strip a real leading letter that is not actually a prefix (no separator)', () => {
    // "Big bruise" starts with "B" but has no separator after it — must stay intact.
    const result = normalizeQuizQuestions([{ question: 'Q1', options: ['Big bruise', 'Small cut', 'No injury', 'Broken bone'], correct: 0 }]);
    expect(result[0].options).toEqual(['Big bruise', 'Small cut', 'No injury', 'Broken bone']);
  });

  test('unwraps a doubled options array (letter badges at even indices)', () => {
    const result = normalizeQuizQuestions([{
      question: 'Q1',
      options: ['A', 'Paris', 'B', 'London', 'C', 'Rome', 'D', 'Berlin'],
      correct: 0,
    }]);
    expect(result[0].options).toEqual(['Paris', 'London', 'Rome', 'Berlin']);
  });

  test('clamps an out-of-range correct index to the last valid option', () => {
    const result = normalizeQuizQuestions([{ question: 'Q1', options: ['A', 'B'], correct: 9 }]);
    expect(result[0].correct).toBe(1);
  });

  test('a missing question field defaults to an empty string', () => {
    const result = normalizeQuizQuestions([{ options: ['A', 'B'], correct: 0 }]);
    expect(result[0].question).toBe('');
  });

  test('a null entry in the questions array passes through unchanged', () => {
    const result = normalizeQuizQuestions([null]);
    expect(result).toEqual([null]);
  });
});

describe('generateComprehensionQuiz', () => {
  test('parses real Groq JSON output and normalizes the questions', async () => {
    mockGroqCreate.mockResolvedValue(groqResponse(JSON.stringify([
      { question: 'What happened?', options: ['A. Yes', 'B. No', 'C. Maybe', 'D. Unknown'], correct: 0 },
    ])));

    const result = await generateComprehensionQuiz({ headline: 'Big News', summary: 'Something happened.', grade: 'Grade 4' });

    expect(result[0].question).toBe('What happened?');
    expect(result[0].options).toEqual(['Yes', 'No', 'Maybe', 'Unknown']);
  });

  test('strips markdown code fences from the real Groq response before parsing', async () => {
    mockGroqCreate.mockResolvedValue(groqResponse('```json\n' + JSON.stringify([{ question: 'Q', options: ['A', 'B', 'C', 'D'], correct: 1 }]) + '\n```'));

    const result = await generateComprehensionQuiz({ headline: 'H', summary: 'S' });

    expect(result[0].question).toBe('Q');
  });
});

describe('getDailyTidbit', () => {
  test('returns real GK fact and current-affairs content when no NEWS_API_KEY is set (fallback path)', async () => {
    mockGroqCreate
      .mockResolvedValueOnce(groqResponse(JSON.stringify({ fact: 'Octopuses have three hearts.', category: 'Animals' })))
      .mockResolvedValueOnce(groqResponse(JSON.stringify({ headline: 'World Update', summary: 'Something good happened.' })));

    const result = await getDailyTidbit('Grade 3 Unit A', false);

    expect(result.grade).toBe('Grade 3 Unit A');
    expect(result.gk.fact).toBe('Octopuses have three hearts.');
    expect(result.currentAffairs.headline).toBe('World Update');
    expect(result.cached).toBeUndefined();
  });

  test('a second call for the same grade+day is served from the real in-memory cache (no new Groq calls)', async () => {
    mockGroqCreate
      .mockResolvedValueOnce(groqResponse(JSON.stringify({ fact: 'Fact one', category: 'Science' })))
      .mockResolvedValueOnce(groqResponse(JSON.stringify({ headline: 'H1', summary: 'S1' })));

    await getDailyTidbit('Grade 3 Unit B', false);
    mockGroqCreate.mockClear();

    const second = await getDailyTidbit('Grade 3 Unit B', false);

    expect(mockGroqCreate).not.toHaveBeenCalled();
    expect(second.cached).toBe(true);
    expect(second.gk.fact).toBe('Fact one');
  });

  test('passing bust=true skips the cache and regenerates real fresh content', async () => {
    mockGroqCreate
      .mockResolvedValueOnce(groqResponse(JSON.stringify({ fact: 'Old fact', category: 'Science' })))
      .mockResolvedValueOnce(groqResponse(JSON.stringify({ headline: 'Old', summary: 'Old summary' })))
      .mockResolvedValueOnce(groqResponse(JSON.stringify({ fact: 'New fact', category: 'Space' })))
      .mockResolvedValueOnce(groqResponse(JSON.stringify({ headline: 'New', summary: 'New summary' })));

    await getDailyTidbit('Grade 3 Unit C', false);
    const second = await getDailyTidbit('Grade 3 Unit C', true);

    expect(second.gk.fact).toBe('New fact');
  });

  test('unwraps a GK fact that came back as a nested stringified JSON object', async () => {
    mockGroqCreate
      .mockResolvedValueOnce(groqResponse(JSON.stringify({ fact: JSON.stringify({ fact: 'The real fact.' }), category: 'Science' })))
      .mockResolvedValueOnce(groqResponse(JSON.stringify({ headline: 'H', summary: 'S' })));

    const result = await getDailyTidbit('Grade 3 Unit D', false);

    expect(result.gk.fact).toBe('The real fact.');
  });
});

describe('fetchCurrentAffairs — with a real NEWS_API_KEY set', () => {
  beforeEach(() => { process.env.NEWS_API_KEY = 'real-key'; });

  test('filters out excluded-keyword articles and simplifies the picked one via Groq', async () => {
    axios.get.mockResolvedValue({
      data: {
        articles: [
          { title: 'Pokemon game update', description: 'desc' },
          { title: 'New volcano discovered', description: 'Scientists found a new volcano.' },
        ],
      },
    });
    // getDailyTidbit runs generateGKFact and fetchCurrentAffairs in parallel via
    // Promise.all — generateGKFact's single groq call fires first (before
    // fetchCurrentAffairs's first await on axios.get), so this must be first.
    mockGroqCreate
      .mockResolvedValueOnce(groqResponse(JSON.stringify({ fact: 'A fact', category: 'Science' }))) // GK fact
      .mockResolvedValueOnce(groqResponse('1')) // article-pick response
      .mockResolvedValueOnce(groqResponse(JSON.stringify({ headline: 'Volcano Found!', summary: 'Scientists found something cool.' })));

    const result = await getDailyTidbit('Grade 4 Unit E', false);

    expect(result.currentAffairs.headline).toBe('Volcano Found!');
  });

  test('falls back to Groq-generated affairs when NewsAPI returns zero usable articles', async () => {
    axios.get.mockResolvedValue({ data: { articles: [{ title: 'Pokemon news', description: 'd' }] } });
    mockGroqCreate
      .mockResolvedValueOnce(groqResponse(JSON.stringify({ fact: 'A fact', category: 'Science' })))
      .mockResolvedValueOnce(groqResponse(JSON.stringify({ headline: 'Fallback', summary: 'Fallback summary' })));

    const result = await getDailyTidbit('Grade 4 Unit F', false);

    expect(result.currentAffairs.headline).toBe('Fallback');
  });

  test('falls back to Groq-generated affairs when the NewsAPI request itself fails', async () => {
    axios.get.mockRejectedValue(new Error('network down'));
    mockGroqCreate
      .mockResolvedValueOnce(groqResponse(JSON.stringify({ fact: 'A fact', category: 'Science' })))
      .mockResolvedValueOnce(groqResponse(JSON.stringify({ headline: 'Fallback2', summary: 'Fallback summary' })));

    const result = await getDailyTidbit('Grade 4 Unit G', false);

    expect(result.currentAffairs.headline).toBe('Fallback2');
  });
});
