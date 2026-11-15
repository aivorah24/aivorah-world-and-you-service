# Aivorah World & You Service

Standalone microservice for "The World & You" — GK Fact, On This Day, Fun
Challenge, Current Affairs, and the comprehension quiz — extracted from
`ai-mentor/server`.

## Structure

```
routes/
  daily-tidbit.js   — thin route handlers: GET /, POST /quiz, POST /quiz-complete
  world.js          — thin route handler: GET /daily
services/
  dailyTidbit.js    — GK Fact generation, Current Affairs fetch/fallback,
                       quiz generation + option normalization, XP leveling
  world.js          — On This Day + GK Fact + Fun Challenge generation,
                       Current Affairs fetch/fallback (separate cache/prompt
                       set from dailyTidbit.js — both currently generate
                       overlapping content independently, not yet unified)
  supabase.js       — Supabase client
```

## Setup

```bash
npm install
cp .env.example .env   # fill in real keys
npm run dev             # nodemon, or `npm start` for a plain run
```

Runs on `PORT` (default `3010`).

## Endpoints

- `GET /daily-tidbit?grade=&bust=&currentAffairs=1` — today's GK Fact (grade-specific, cached per day); `currentAffairs=1` also adds the old current-affairs item. Answers within ~2 s: if the AI is slow a checked fact is returned with `partial: true`
- `POST /daily-tidbit/quiz` — generate 2 MCQ comprehension questions from a current-affairs article
- `POST /daily-tidbit/quiz-complete` — award XP for quiz results
- `GET /world/daily?grade=` — On This Day (3 real events from Wikipedia's feed, child-safe filter), Fun Challenge (AI; a ready-made puzzle with `partial: true` if the AI is slow). Every grade is prepared at start-up and when the date changes (`PREWARM=off` disables)
- `GET /health`

## Current Affairs (`/current-affairs`)

The daily news digest and the weekly quiz shown in the app's
The World & You → Current Affairs tab. **This service is the source of truth**
(moved here from aivorah-attendance-service, which now only forwards old app
versions' `/current-affairs` calls to this service).

```
current-affairs/
  routes/       digest, story, quiz, progress, admin (content tool)
  services/     content (age groups, stories), quiz, progress, rewards, analytics
  middleware/   auth.js (student = token email), adminAuth.js (editor allowlist)
services/firebaseAdmin.js   — verifies Firebase ID tokens
tests/current-affairs/      — supertest + an in-memory Supabase fake
```

- Tables `ca_*` and the `ca_apply_progress()` function: aivorah-db migrations
  (`0023_current_affairs.sql` and later).
- Stories and quiz questions are drafted by the pipeline below and finished
  in the admin content tool. **Only an editor publishes**: the pipeline saves
  everything with status `review` (stories also `is_true_fact = false`).
- Environment: see the Current Affairs block in `.env.example`
  (`FIREBASE_SERVICE_ACCOUNT_B64`, `AUTH_ENFORCE` — never `monitor` in production).

Endpoints: `GET /current-affairs/digest/today`, `GET /current-affairs/digest/list`,
`GET /current-affairs/story/:id`, `GET /current-affairs/quiz/week`,
`POST /current-affairs/quiz/check`, `POST /current-affairs/quiz/submit`,
`GET /current-affairs/progress/:studentEmail`,
`POST /current-affairs/progress/{digest-complete,story-read,quiz-complete}`,
`/current-affairs/admin/*` (editors only), `/current-affairs/pipeline/*` (scheduler only, below).

### Daily news pipeline (`current-affairs/pipeline/`)

1. **Collect** (`feeds.js`, `collect.js`): the approved feeds only (The Hindu,
   RBI, UN News, Sportstar; PIB from its RSS page). 15 s timeout, one retry; a
   failing feed is skipped and reported. Keeps the last 24 hours, strips HTML,
   drops duplicate links and near-identical titles, and anything already in
   `ca_stories` in any status (same `source_url_hash` as the admin tool).
2. **Select** (`select.js`): a child-safety filter, then one AI call picks 5-7
   stories (India 2-3, World 2, Science 1, one of sports/environment/society;
   economy may take one place). Never padded.
3. **Verify** (`verify.js`): reads each source page and asks the AI whether the
   key facts are supported. CONTRADICTED is dropped; an unreadable page is UNCLEAR.
4. **Write** (`write.js`): both versions (7-12: 50-80 words, 13-15: 100-150),
   a fact, three words (the first for age 7) and a question; length-checked,
   one retry.
5. **Save** (`run.js`): one `ca_stories` row each, `status 'review'`,
   `is_true_fact false`, `review_notes` = `AUTO: VERIFIED` or
   `AUTO: CHECK - <what to check>`.

AI calls per run are capped (selection 1, checks 8, writing 8, quiz 4).

**Weekly quiz** (`quizGen.js`): the quiz of week_start S (a Sunday) uses only
**published** stories dated S-6 to S. For 7-12 and 13-15: 10 questions each
(2 per category slot; 6 multiple choice, 2 true/false, 2 reasoning), each
with the story it comes from. Saved as `review`; publish the week in the admin
tool. A week that already has questions is skipped unless `force` is sent.

**Run it**

```bash
node scripts/runDailyPipeline.js --dry-run          # report + rows it would save; writes nothing
node scripts/generateWeeklyQuiz.js --dry-run [--week=2026-11-22] [--force]
```

Writes happen only when `CA_PIPELINE_ENABLED=true`. The scheduler calls:

```bash
curl -X POST https://aivorah-world-and-you-service.onrender.com/current-affairs/pipeline/run \
  -H "x-pipeline-secret: $CA_PIPELINE_SECRET"
curl -X POST https://aivorah-world-and-you-service.onrender.com/current-affairs/pipeline/quiz \
  -H "x-pipeline-secret: $CA_PIPELINE_SECRET" -H "Content-Type: application/json" -d '{}'
```

Both answer `202 { runId, started: true }` at once and run in the background;
the report is printed to the service log (`[ca-pipeline]` / `[ca-quiz]`). A
missing or wrong header (or no `CA_PIPELINE_SECRET` on the service) is `401`.

**Schedule** (cron times are UTC):

| Job | When (India) | Cron (UTC) |
|---|---|---|
| Daily news | 6:00 AM every day | `30 0 * * *` |
| Weekly quiz | Saturday 8:00 PM (for Sunday's quiz) | `30 14 * * 6` |

A Render Cron Job running the `curl` above works, but Render bills cron jobs
by the minute (no free tier). A free option is a scheduled GitHub Actions
workflow that runs the same `curl` with the secret stored as a repository
secret. Nothing was created for this; set it up by hand.

**Editor's daily routine**

1. After 6 AM open Admin → Current Affairs → Stories → **To review**. The top
   line shows the last automatic run.
2. Open each story's source link. **VERIFIED** (green) means the key facts
   matched the source page; **CHECK** (amber) says what to look at.
3. Open a story to fix either age version (word counters warn outside the targets).
4. Tick the good stories (or **Select all verified** after checking them),
   **Publish selected as today's digest**, confirm. **Reject selected** for the rest.
5. On Sunday open **Weekly quiz**, read both age groups' questions (each shows
   its story), fix or reject any, then publish the week.

## Known gaps (carried over from the monolith, not introduced here)

- `POST /daily-tidbit/quiz-complete` has no server-side "already awarded
  today" check — XP can be awarded more than once per day if the client's
  local completion flag is bypassed (cleared storage, different device/
  browser context).
- `routes/daily-tidbit.js` and `routes/world.js` both independently
  generate a GK fact for the same day via separate prompts/caches — not
  reconciled into one source of truth.

## Branching

`main` is protected by convention — no direct pushes. Work on a feature
branch and open a PR.
