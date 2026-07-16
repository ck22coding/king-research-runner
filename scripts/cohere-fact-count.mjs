// One-off: print current fact count (and section breakdown) for Cohere Health.
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

const { data: facts, error } = await supabase
  .from('facts')
  .select('id, section, status, text')
  .eq('company_id', COMPANY_ID);
if (error) throw error;

console.log(`fact_count=${facts.length}`);
const bySection = {};
for (const f of facts) bySection[f.section] = (bySection[f.section] || 0) + 1;
console.log(JSON.stringify(bySection, null, 2));
const byStatus = {};
for (const f of facts) byStatus[f.status] = (byStatus[f.status] || 0) + 1;
console.log(JSON.stringify(byStatus, null, 2));

const { data: company } = await supabase.from('companies').select('*').eq('id', COMPANY_ID).single();
console.log(JSON.stringify({ status: company.status, tldr: company.tldr, newsroom_url: company.newsroom_url }, null, 2));
