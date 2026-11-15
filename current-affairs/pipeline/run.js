// The daily Current Affairs pipeline: collect, select, verify, write, save.
// Every saved story waits for an editor: status 'review', is_true_fact false.
// Nothing here ever publishes.
const crypto = require('crypto');
const { localDate } = require('../services/content');
const { collect } = require('./collect');
const { select } = require('./select');
const { verify } = require('./verify');
const { write } = require('./write');
const { createLlm } = require('./llm');

const REVIEW_STATUS = 'review';

// One ca_stories row from a written story.
function toRow(story, { today, rank }) {
  const w = story.written;
  const [w1, w2, w3] = w.words;
  const v = story.verification;
  return {
    category: story.category,
    publish_date: today,
    priority: Math.round(story.score * 10) + Math.max(0, 7 - rank), // higher = more important
    status: REVIEW_STATUS,
    is_true_fact: false,
    title_kid: w.kid.title, summary_kid: w.kid.summary, what_happened_kid: w.kid.what_happened, why_important_kid: w.kid.why_important,
    title_teen: w.teen.title, summary_teen: w.teen.summary, what_happened_teen: w.teen.what_happened, why_important_teen: w.teen.why_important,
    did_you_know: w.did_you_know,
    new_word_1: w1?.word || null, def_1: w1?.definition || null,
    new_word_2: w2?.word || null, def_2: w2?.definition || null,
    new_word_3: w3?.word || null, def_3: w3?.definition || null,
    think_about_it: w.think_about_it,
    age_extras: {},
    source: story.source,
    source_url: story.link,
    source_url_hash: story.hash,
    review_notes: v.result === 'VERIFIED' ? 'AUTO: VERIFIED' : `AUTO: CHECK - ${v.note}`,
  };
}

async function saveRows(supabase, rows, report) {
  for (const row of rows) {
    if (row.status !== REVIEW_STATUS || row.is_true_fact !== false) throw new Error('The pipeline may only save stories for review');
    const { error } = await supabase.from('ca_stories').insert(row).select('id');
    if (!error) { report.saved++; continue; }
    if (error.code === '23505') report.skipped.push({ title: row.title_kid, reason: 'already saved (same source link)' });
    else report.skipped.push({ title: row.title_kid, reason: `save failed: ${error.message}` });
  }
}

/**
 * Runs the pipeline once. Writes only when dryRun is false AND
 * CA_PIPELINE_ENABLED=true; otherwise the report lists the rows it would save.
 */
async function runDailyPipeline({ supabase, fetchImpl, llm = createLlm(), now = new Date(), dryRun = false, env = process.env } = {}) {
  const runId = crypto.randomUUID();
  const today = localDate(now);
  const writesEnabled = !dryRun && String(env.CA_PIPELINE_ENABLED || '').toLowerCase() === 'true';
  const report = {
    runId, date: today, startedAt: now.toISOString(), mode: writesEnabled ? 'write' : 'dry-run',
    ...(dryRun || writesEnabled ? {} : { note: 'CA_PIPELINE_ENABLED is not "true": nothing was saved.' }),
    feeds: {}, collected: {}, selected: {}, verification: {}, written: 0, saved: 0, skipped: [], rows: [],
  };

  const collected = await collect({ supabase, fetchImpl, now });
  report.feeds = { read: collected.report.feedsRead.length, failed: collected.report.feedsFailed };
  report.collected = collected.report;

  const chosen = await select(collected.items, llm);
  report.selected = chosen.report;

  const checked = await verify(chosen.picks, llm, { fetchImpl });
  report.verification = { verified: checked.report.verified, unclear: checked.report.unclear, dropped: checked.report.dropped };

  const written = await write(checked.kept, llm);
  report.written = written.report.written;
  report.skipped.push(...written.report.skipped);

  const rows = written.stories.map((s, rank) => toRow(s, { today, rank }));
  if (writesEnabled) await saveRows(supabase, rows, report);
  else report.rows = rows;
  report.aiCalls = { ...llm.used };
  report.finishedAt = new Date().toISOString();
  return report;
}

// A short, safe summary for the server console (no page text, no secrets).
function summarize(report) {
  const failed = (report.feeds.failed || []).map((f) => `${f.source} (${f.reason})`).join('; ') || 'none';
  return `[ca-pipeline] ${report.runId} ${report.date} ${report.mode}: feeds read ${report.feeds.read}, failed ${failed}; `
    + `items ${report.collected.collected} -> kept ${report.collected.kept}; selected ${report.selected.selected}; `
    + `verified ${report.verification.verified}, unclear ${report.verification.unclear}, dropped ${report.verification.dropped.length}; `
    + `written ${report.written}; saved ${report.saved}; skipped ${report.skipped.length}`;
}

module.exports = { runDailyPipeline, toRow, summarize, REVIEW_STATUS };
