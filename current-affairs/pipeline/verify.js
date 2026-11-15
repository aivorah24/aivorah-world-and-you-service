// Step 3: read each chosen story's source page and let the AI check the key
// facts against it (PROMPT B). Page text is never logged or stored.
const { fetchText, stripHtml } = require('./feeds');

const MIN_PAGE_CHARS = 300;
const MAX_PAGE_CHARS = 8000;

const PROMPT_B = 'You are a careful fact checker. Given KEY FACTS and the SOURCE PAGE TEXT, decide whether each key fact is supported by the page text. Return only JSON: {"result":"VERIFIED|UNCLEAR|CONTRADICTED","note":"one short sentence for the human editor naming anything not supported or worth double-checking"}. VERIFIED only if every key fact is clearly supported. CONTRADICTED if the page text clearly disagrees with a key fact. Otherwise UNCLEAR. Use only the page text.';

// The page's main text: scripts, styles and page furniture removed; <article> or <main> preferred.
function extractPageText(html) {
  let h = String(html || '').replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|iframe)[\s\S]*?<\/\1>/gi, ' ');
  const main = h.match(/<article[\s\S]*?<\/article>/i) || h.match(/<main[\s\S]*?<\/main>/i);
  if (main) h = main[0];
  const paragraphs = [...h.matchAll(/<p[\s>][\s\S]*?<\/p>/gi)].map((m) => stripHtml(m[0])).filter((p) => p.length > 40);
  const text = paragraphs.length >= 2 ? paragraphs.join('\n') : stripHtml(h);
  return text.slice(0, MAX_PAGE_CHARS);
}

async function verifyOne(pick, llm, fetchImpl) {
  let pageText = '';
  try { pageText = extractPageText(await fetchText(pick.link, { fetchImpl })); } catch { pageText = ''; }
  if (pageText.length < MIN_PAGE_CHARS) {
    return { result: 'UNCLEAR', note: 'Source page could not be read, please open the link.', pageText: '' };
  }
  try {
    const answer = await llm.json('verify', `${PROMPT_B}\n\nKEY FACTS:\n${pick.keyFacts.map((f) => `- ${f}`).join('\n')}\n\nSOURCE PAGE TEXT:\n${pageText}`, { maxTokens: 400 });
    const result = ['VERIFIED', 'UNCLEAR', 'CONTRADICTED'].includes(answer?.result) ? answer.result : 'UNCLEAR';
    const note = String(answer?.note || '').trim() || (result === 'VERIFIED' ? 'Key facts match the source page.' : 'Please check the key facts against the source.');
    return { result, note, pageText };
  } catch (err) {
    return { result: 'UNCLEAR', note: err.budget ? 'Not checked automatically (limit reached); please check against the source.' : 'Automatic check failed; please check against the source.', pageText };
  }
}

async function verify(picks, llm, { fetchImpl } = {}) {
  const report = { verified: 0, unclear: 0, contradicted: 0, dropped: [] };
  const kept = [];
  for (const pick of picks) {
    const v = await verifyOne(pick, llm, fetchImpl);
    if (v.result === 'CONTRADICTED') {
      report.contradicted++;
      report.dropped.push({ title: pick.title, reason: `contradicted by the source: ${v.note}` });
      continue;
    }
    report[v.result === 'VERIFIED' ? 'verified' : 'unclear']++;
    kept.push({ ...pick, verification: { result: v.result, note: v.note }, pageText: v.pageText });
  }
  return { kept, report };
}

module.exports = { verify, extractPageText, PROMPT_B, MIN_PAGE_CHARS };
