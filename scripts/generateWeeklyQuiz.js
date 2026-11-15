// Generates a week's Current Affairs quiz (both age groups) from the command line.
//   node scripts/generateWeeklyQuiz.js --dry-run [--week=YYYY-MM-DD] [--force]
// Saves (status 'review') only without --dry-run and with CA_PIPELINE_ENABLED=true.
require('dotenv').config();
const { generateWeeklyQuiz, summarizeQuiz } = require('../current-affairs/pipeline/quizGen');

(async () => {
  const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  const report = await generateWeeklyQuiz({
    supabase: require('../services/supabase'),
    weekStart: arg('week'),
    force: process.argv.includes('--force'),
    dryRun: process.argv.includes('--dry-run'),
  });
  console.log(JSON.stringify(report, null, 2));
  console.log(summarizeQuiz(report));
})().catch((err) => {
  console.error('[ca-quiz] failed:', err.message);
  process.exit(1);
});
