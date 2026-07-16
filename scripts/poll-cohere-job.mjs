// One-off: poll the most recent enrichment_jobs row for Cohere Health until
// it leaves queued/running. Prints a line per poll; used to wait out the
// live-demo real claude -p run without holding a browser session open.
import { createClient } from '@supabase/supabase-js';

process.loadEnvFile('/Users/carterking/Projects/dad/.env');

const COMPANY_ID = 'cb209ace-e849-4573-abe8-5975e730ebe4';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);
const { error: signInError } = await supabase.auth.signInWithPassword({
  email: process.env.RUNNER_EMAIL,
  password: process.env.RUNNER_PASSWORD,
});
if (signInError) throw signInError;

while (true) {
  const { data: jobs, error } = await supabase
    .from('enrichment_jobs')
    .select('id, status, started_at, finished_at, error')
    .eq('company_id', COMPANY_ID)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  const job = jobs?.[0];
  console.log(`${new Date().toISOString()} job=${job?.id} status=${job?.status}`);
  if (job && (job.status === 'done' || job.status === 'failed')) {
    console.log(JSON.stringify(job, null, 2));
    break;
  }
  await new Promise((r) => setTimeout(r, 20000));
}
