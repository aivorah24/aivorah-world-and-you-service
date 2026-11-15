// Step 1: read every approved feed, keep the last 24 hours, drop duplicates
// and anything already saved (any status, rejected included).
const { FEEDS, PIB_INDEX, fetchText, parseFeed, extractPibFeeds } = require('./feeds');
const { urlHash } = require('../services/sourceUrl');
const { check } = require('../services/db');

const WINDOW_MS = 24 * 60 * 60 * 1000;

function titleTokens(title) {
  return new Set(String(title).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 3));
}
function similar(a, b) {
  const A = titleTokens(a); const B = titleTokens(b);
  if (!A.size || !B.size) return false;
  let both = 0;
  for (const t of A) if (B.has(t)) both++;
  return both / (A.size + B.size - both) >= 0.7;
}

async function readFeed(feed, fetchImpl, report) {
  try {
    const items = parseFeed(await fetchText(feed.url, { fetchImpl }));
    // Without dates we cannot tell what is from the last 24 hours (PIB's feeds today).
    if (items.length && items.every((i) => !i.publishedAt)) throw new Error('no publish dates in the feed');
    report.feedsRead.push({ source: feed.source, url: feed.url, items: items.length });
    return items.map((i) => ({ ...i, source: feed.source, feedCategory: feed.category }));
  } catch (err) {
    report.feedsFailed.push({ source: feed.source, url: feed.url, reason: err.message });
    return [];
  }
}

async function pibFeeds(fetchImpl, report) {
  try {
    const links = extractPibFeeds(await fetchText(PIB_INDEX.url, { fetchImpl }));
    if (!links.length) throw new Error('no RSS links found on the PIB RSS page');
    return links.map((url) => ({ source: 'PIB', category: 'india', url }));
  } catch (err) {
    report.feedsFailed.push({ source: 'PIB', url: PIB_INDEX.url, reason: `PIB skipped: ${err.message}` });
    return [];
  }
}

async function existingHashes(supabase, hashes) {
  const found = new Set();
  for (let i = 0; i < hashes.length; i += 100) {
    const rows = check(await supabase.from('ca_stories').select('source_url_hash').in('source_url_hash', hashes.slice(i, i + 100)));
    for (const r of rows || []) found.add(r.source_url_hash);
  }
  return found;
}

async function collect({ supabase, fetchImpl, now = new Date(), feeds = FEEDS } = {}) {
  const report = { feedsRead: [], feedsFailed: [], collected: 0, tooOld: 0, noDate: 0, duplicates: 0, alreadySaved: 0, kept: 0 };
  const allFeeds = [...feeds, ...(feeds === FEEDS ? await pibFeeds(fetchImpl, report) : [])];
  const raw = (await Promise.all(allFeeds.map((f) => readFeed(f, fetchImpl, report)))).flat();
  report.collected = raw.length;

  const since = now.getTime() - WINDOW_MS;
  const fresh = raw.filter((i) => {
    if (!i.publishedAt) { report.noDate++; return false; }
    const t = new Date(i.publishedAt).getTime();
    if (t < since || t > now.getTime() + 60 * 60 * 1000) { report.tooOld++; return false; }
    return true;
  }).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));

  const unique = [];
  const seen = new Set();
  for (const item of fresh) {
    const hash = urlHash(item.link);
    if (seen.has(hash) || unique.some((u) => similar(u.title, item.title))) { report.duplicates++; continue; }
    seen.add(hash);
    unique.push({ ...item, hash });
  }

  const saved = unique.length ? await existingHashes(supabase, unique.map((i) => i.hash)) : new Set();
  const items = unique.filter((i) => {
    if (saved.has(i.hash)) { report.alreadySaved++; return false; }
    return true;
  });
  report.kept = items.length;
  return { items, report };
}

module.exports = { collect, similar, WINDOW_MS };
