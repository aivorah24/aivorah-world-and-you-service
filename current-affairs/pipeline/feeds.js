// Approved news sources (and only these), fetching and RSS/Atom parsing.
// A feed that fails is skipped and listed in the run report; it never stops a run.

const FEEDS = [
  { source: 'The Hindu', category: 'india', url: 'https://www.thehindu.com/news/national/feeder/default.rss' },
  { source: 'RBI', category: 'economy', url: 'https://rbi.org.in/pressreleases_rss.xml' },
  { source: 'The Hindu', category: 'economy', url: 'https://www.thehindu.com/business/Economy/feeder/default.rss' },
  { source: 'UN News', category: 'world', url: 'https://news.un.org/feed/subscribe/en/news/all/rss.xml' },
  { source: 'The Hindu', category: 'world', url: 'https://www.thehindu.com/news/international/feeder/default.rss' },
  { source: 'The Hindu', category: 'science', url: 'https://www.thehindu.com/sci-tech/science/feeder/default.rss' },
  { source: 'UN News', category: 'environment', url: 'https://news.un.org/feed/subscribe/en/news/topic/climate-change/feed/rss.xml' },
  { source: 'Sportstar', category: 'sports', url: 'https://sportstar.thehindu.com/feeder/default.rss' },
  { source: 'UN News', category: 'society', url: 'https://news.un.org/feed/subscribe/en/news/topic/culture-and-education/feed/rss.xml' },
  { source: 'The Hindu', category: 'society', url: 'https://www.thehindu.com/education/feeder/default.rss' },
];
// PIB lists its RSS feeds on this page; the feed links are read from it each run.
const PIB_INDEX = { source: 'PIB', category: 'india', url: 'https://www.pib.gov.in/ViewRss.aspx?reg=3&lang=1' };
const PIB_MAX_FEEDS = 4;

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const TIMEOUT_MS = 15000;

// GET with a normal browser User-Agent, a 15 s timeout and one retry.
async function fetchText(url, { fetchImpl = (...a) => fetch(...a), timeoutMs = TIMEOUT_MS } = {}) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchImpl(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.8' },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(text) {
  return String(text || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

// Text without HTML tags, entities decoded, spaces collapsed.
function stripHtml(raw) {
  const unwrapped = String(raw || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  return decodeEntities(decodeEntities(unwrapped).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : '';
}

// RSS 2.0 <item> and Atom <entry> → [{ title, link, summary, publishedAt }].
function parseFeed(xml) {
  const text = String(xml || '');
  const blocks = text.match(/<item[\s>][\s\S]*?<\/item>/gi) || text.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  return blocks.map((block) => {
    let link = stripHtml(tag(block, 'link'));
    if (!link) {
      const href = block.match(/<link[^>]*href=["']([^"']+)["']/i);
      link = href ? decodeEntities(href[1]) : '';
    }
    const date = stripHtml(tag(block, 'pubDate') || tag(block, 'published') || tag(block, 'updated') || tag(block, 'dc:date'));
    const parsed = date ? new Date(date) : null;
    return {
      title: stripHtml(tag(block, 'title')),
      link: link.trim(),
      summary: stripHtml(tag(block, 'description') || tag(block, 'summary') || tag(block, 'content')).slice(0, 1500),
      publishedAt: parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null,
    };
  }).filter((i) => i.title && /^https?:\/\//i.test(i.link));
}

// The English RSS links listed on PIB's RSS page (absolute URLs).
function extractPibFeeds(html) {
  const links = new Set();
  for (const m of String(html || '').matchAll(/href=["']([^"']*RssMain\.aspx[^"']*)["']/gi)) {
    try { links.add(new URL(decodeEntities(m[1]), PIB_INDEX.url).toString()); } catch { /* skip */ }
  }
  return [...links].slice(0, PIB_MAX_FEEDS);
}

module.exports = { FEEDS, PIB_INDEX, USER_AGENT, fetchText, parseFeed, stripHtml, decodeEntities, extractPibFeeds };
