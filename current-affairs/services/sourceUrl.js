// One identity per source article, shared by the admin tool and the daily
// pipeline: ca_stories.source_url_hash (unique). Same normalization and hash
// as the first pipeline (aivorah-current-affairs-service scripts/lib/feeds.js)
// so stories it already saved are recognised.
const crypto = require('crypto');

const TRACKING = /^(utm_|fbclid$|gclid$|ref$|cmp$|at_)/i;

function normalizeUrl(link) {
  try {
    const u = new URL(link);
    u.hash = '';
    u.protocol = 'https:';
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    for (const key of [...u.searchParams.keys()]) if (TRACKING.test(key)) u.searchParams.delete(key);
    u.searchParams.sort();
    const path = u.pathname.replace(/\/+$/, '') || '/';
    return `${u.protocol}//${u.hostname}${path}${u.search}`;
  } catch {
    return String(link || '').trim().toLowerCase();
  }
}

function urlHash(link) {
  return crypto.createHash('sha256').update(normalizeUrl(link)).digest('hex');
}

const isHttpsUrl = (value) => /^https:\/\/[^\s]+$/i.test(String(value || '').trim());

module.exports = { normalizeUrl, urlHash, isHttpsUrl };
