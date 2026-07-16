// One-off script for the Task 9 live demo: find-or-create 'Cohere Health'
// (domain coherehealth.com), signed in as the runner user (can_enrich=true).
// Direct insert per the task — smaller diff than driving the Add-company UI.
// Not part of the runner's runtime — throwaway, run once by hand.
import { createClient } from '@supabase/supabase-js';

process.loadEnvFile('/Users/carterking/Projects/dad/.env');

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

const { data: signIn, error: signInError } = await supabase.auth.signInWithPassword({
  email: process.env.RUNNER_EMAIL,
  password: process.env.RUNNER_PASSWORD,
});
if (signInError) throw signInError;

const { data: existing, error: findError } = await supabase
  .from('companies')
  .select('*')
  .eq('domain', 'coherehealth.com')
  .maybeSingle();
if (findError) throw findError;

let company = existing;
if (!company) {
  const { data: inserted, error: insertError } = await supabase
    .from('companies')
    .insert({ name: 'Cohere Health', domain: 'coherehealth.com', created_by: signIn.user.id })
    .select('*')
    .single();
  if (insertError) throw insertError;
  company = inserted;
  console.log('created');
} else {
  console.log('found');
}

console.log(JSON.stringify(company, null, 2));

const { count: factCount, error: countError } = await supabase
  .from('facts')
  .select('*', { count: 'exact', head: true })
  .eq('company_id', company.id);
if (countError) throw countError;
console.log(`fact_count=${factCount}`);
