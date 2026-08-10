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

- `GET /daily-tidbit?grade=&bust=` — today's GK Fact + Current Affairs (grade-specific, cached per day)
- `POST /daily-tidbit/quiz` — generate 2 MCQ comprehension questions from a current-affairs article
- `POST /daily-tidbit/quiz-complete` — award XP for quiz results
- `GET /world/daily?grade=` — On This Day (3 events), GK Fact, Fun Challenge, Current Affairs
- `GET /health`

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
