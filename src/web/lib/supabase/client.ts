import { createClient as createSupabaseClient, type SupabaseClient } from '@supabase/supabase-js'

// Local defaults match compose.yml. Bun inlines the `BUN_PUBLIC_*` variables set at build time (bunfig.toml);
// an unset one stays a `process.env` read, which throws in the browser.
const env = (read: () => string | undefined) => {
  try {
    return read()
  } catch {
    return undefined
  }
}
const url = env(() => process.env.BUN_PUBLIC_SUPABASE_URL) || 'http://localhost:54321'
const key =
  env(() => process.env.BUN_PUBLIC_SUPABASE_ANON_KEY) ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJpY2hlbGlldSIsInJvbGUiOiJhbm9uIiwiaWF0IjoxNzYyODE5MjAwLCJleHAiOjQxMDI0NDQ4MDB9.A7UFTz_dhd_vLCC895znt_r5pOuYCjzOnRSvk-oR-VI'

let client: SupabaseClient | undefined

export function createClient() {
  client ??= createSupabaseClient(url, key)
  return client
}
