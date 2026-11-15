// The pipeline's AI calls: the service's Groq client and model
// (services/dailyTidbit.js), JSON answers only, with a per-run call budget.
const BUDGET = { select: 1, verify: 8, write: 8, quiz: 4 };

function createLlm({ ask } = {}) {
  const used = { select: 0, verify: 0, write: 0, quiz: 0 };
  const call = ask || (async (prompt, { maxTokens }) => {
    const { complete, extractJSON } = require('../../services/dailyTidbit');
    return extractJSON(await complete([{ role: 'user', content: prompt }], { temperature: 0.2, maxTokens }));
  });
  // Returns the parsed JSON, or throws { budget: true } once a step's calls are used up.
  async function json(step, prompt, { maxTokens = 1500 } = {}) {
    if (used[step] >= BUDGET[step]) {
      const err = new Error(`AI call limit for ${step} reached (${BUDGET[step]})`);
      err.budget = true;
      throw err;
    }
    used[step] += 1;
    return call(prompt, { maxTokens, step });
  }
  return { json, used };
}

module.exports = { createLlm, BUDGET };
