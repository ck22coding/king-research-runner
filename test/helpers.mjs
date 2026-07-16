// Shared test helpers: sign in as the runner account and find/create the
// one dedicated test company these tests are scoped to. Mirrors the pattern
// in web/tests/enrich-e2e.spec.ts (same createClient + signInWithPassword,
// same find-or-create-by-domain shape).
import { createClient } from '@supabase/supabase-js';

const ENV_PATH = '/Users/carterking/Projects/dad/.env';
process.loadEnvFile(ENV_PATH);

export const COMPANY_NAME = 'Runner Test Co';
export const COMPANY_DOMAIN = 'runner-test.example';

export async function signInRunner() {
  const runner = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  const { data, error } = await runner.auth.signInWithPassword({
    email: process.env.RUNNER_EMAIL,
    password: process.env.RUNNER_PASSWORD,
  });
  if (error) throw error;
  return { runner, userId: data.user.id };
}

export async function findOrCreateRunnerTestCo(runner, userId) {
  const { data: existing, error } = await runner
    .from('companies')
    .select('id')
    .eq('domain', COMPANY_DOMAIN)
    .maybeSingle();
  if (error) throw error;
  if (existing) return existing.id;

  const { data: created, error: insertError } = await runner
    .from('companies')
    .insert({ name: COMPANY_NAME, domain: COMPANY_DOMAIN, created_by: userId })
    .select('id')
    .single();
  if (insertError) throw insertError;
  return created.id;
}
