const request = require('supertest');

jest.mock('../../services/dailyTidbit', () => ({
  computeLevel: jest.fn(() => 2),
  getDailyTidbit: jest.fn(),
  generateComprehensionQuiz: jest.fn(),
}));
jest.mock('../../services/world', () => ({
  getWorldDaily: jest.fn(),
}));
jest.mock('../../services/supabase', () => {
  const chain = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    single: jest.fn(),
    update: jest.fn().mockReturnThis(),
  };
  return { from: jest.fn(() => chain), _chain: chain };
});

const { getDailyTidbit, generateComprehensionQuiz } = require('../../services/dailyTidbit');
const { getWorldDaily } = require('../../services/world');
const supabase = require('../../services/supabase');
const app = require('../../index');

beforeEach(() => {
  jest.clearAllMocks();
  supabase.from.mockImplementation(() => supabase._chain);
});

describe('GET /health', () => {
  test('reports ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', service: 'aivorah-world-and-you-service' });
  });
});

describe('GET /daily-tidbit', () => {
  test('defaults grade to Grade 3 and returns the real tidbit content', async () => {
    getDailyTidbit.mockResolvedValue({ grade: 'Grade 3', gk: { fact: 'A fact' } });
    const res = await request(app).get('/daily-tidbit');
    expect(res.status).toBe(200);
    expect(getDailyTidbit).toHaveBeenCalledWith('Grade 3', undefined);
    expect(res.body.gk.fact).toBe('A fact');
  });

  test('passes through a real custom grade and bust param', async () => {
    getDailyTidbit.mockResolvedValue({ grade: 'Grade 5' });
    await request(app).get('/daily-tidbit?grade=Grade%205&bust=1');
    expect(getDailyTidbit).toHaveBeenCalledWith('Grade 5', '1');
  });

  test('a service error maps to a real friendly 500 message', async () => {
    getDailyTidbit.mockRejectedValue(new Error('groq down'));
    const res = await request(app).get('/daily-tidbit');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Could not fetch daily tidbit. Please try again.' });
  });
});

describe('POST /daily-tidbit/quiz', () => {
  test('requires headline and summary', async () => {
    const res = await request(app).post('/daily-tidbit/quiz').send({});
    expect(res.status).toBe(400);
  });

  test('returns the real generated questions', async () => {
    generateComprehensionQuiz.mockResolvedValue([{ question: 'Q1', options: ['A', 'B'], correct: 0 }]);
    const res = await request(app).post('/daily-tidbit/quiz').send({ headline: 'H', summary: 'S', grade: 'Grade 4' });
    expect(res.status).toBe(200);
    expect(res.body.questions).toEqual([{ question: 'Q1', options: ['A', 'B'], correct: 0 }]);
  });

  test('a generation failure maps to a real friendly 500 message', async () => {
    generateComprehensionQuiz.mockRejectedValue(new Error('groq timeout'));
    const res = await request(app).post('/daily-tidbit/quiz').send({ headline: 'H', summary: 'S' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Could not generate quiz. Please try again.' });
  });
});

describe('POST /daily-tidbit/quiz-complete', () => {
  test('zero correct answers awards zero XP without touching the database', async () => {
    const res = await request(app).post('/daily-tidbit/quiz-complete').send({ studentId: 's1', correct: 0 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ xpAwarded: 0 });
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test('missing studentId awards zero XP without touching the database', async () => {
    const res = await request(app).post('/daily-tidbit/quiz-complete').send({ correct: 2 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ xpAwarded: 0 });
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test('awards 10 XP per real correct answer and updates the real student_stats row', async () => {
    supabase._chain.single.mockResolvedValue({ data: { xp_points: 100, today_xp: 0 } });
    const res = await request(app).post('/daily-tidbit/quiz-complete').send({ studentId: 's1', correct: 2 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ xpAwarded: 20 });
    expect(supabase._chain.update).toHaveBeenCalledWith(expect.objectContaining({ xp_points: 120, today_xp: 20 }));
  });

  test('a missing student_stats row awards XP in the response without crashing on the update', async () => {
    supabase._chain.single.mockResolvedValue({ data: null });
    const res = await request(app).post('/daily-tidbit/quiz-complete').send({ studentId: 's1', correct: 1 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ xpAwarded: 10 });
    expect(supabase._chain.update).not.toHaveBeenCalled();
  });

  test('a database error is swallowed, still resolves with xpAwarded: 0', async () => {
    supabase._chain.single.mockRejectedValue(new Error('db down'));
    const res = await request(app).post('/daily-tidbit/quiz-complete').send({ studentId: 's1', correct: 1 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ xpAwarded: 0 });
  });
});

describe('GET /world/daily', () => {
  test('defaults grade to Grade 3 and returns the real daily content', async () => {
    getWorldDaily.mockResolvedValue({ grade: 'Grade 3', gkFact: { fact: 'A fact' } });
    const res = await request(app).get('/world/daily');
    expect(res.status).toBe(200);
    expect(getWorldDaily).toHaveBeenCalledWith('Grade 3');
    expect(res.body.gkFact.fact).toBe('A fact');
  });

  test('passes through a real custom grade', async () => {
    getWorldDaily.mockResolvedValue({ grade: 'Grade 6' });
    await request(app).get('/world/daily?grade=Grade%206');
    expect(getWorldDaily).toHaveBeenCalledWith('Grade 6');
  });

  test('a service error maps to a real friendly 500 message', async () => {
    getWorldDaily.mockRejectedValue(new Error('groq down'));
    const res = await request(app).get('/world/daily');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Could not generate daily content' });
  });
});
