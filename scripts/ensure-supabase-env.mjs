#!/usr/bin/env node
/**
 * Build/deploy guard for Supabase config.
 *
 * Why this exists: a deploy once shipped a blank page because the build ran in a
 * fresh environment with no `.env`, so Vite baked `undefined` in for the Supabase
 * URL/key and `createClient(undefined, undefined)` threw on load. This script runs
 * automatically before `build` and `deploy` (see package.json `prebuild`/`predeploy`)
 * and guarantees the credentials are present, so that can never recur.
 *
 * The values below are the PUBLISHABLE anon credentials (role `anon`, protected by
 * row-level security). They are already shipped in every client bundle by design, so
 * keeping them here is no additional exposure — it just makes builds self-healing.
 * NEVER put the service_role key in this file or any client-side env var.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ENV_PATH = join(ROOT, '.env')

const DEFAULTS = {
  VITE_SUPABASE_URL: 'https://ikztpvxfgmhmrcwolwgx.supabase.co',
  VITE_SUPABASE_ANON_KEY:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlrenRwdnhmZ21obXJjd29sd2d4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE0NzY1MDIsImV4cCI6MjA5NzA1MjUwMn0.zrdJb30FmQNwxfVnGOjNj6WB5WaCH0EsEvRdrPBw8IQ',
}

const PLACEHOLDERS = new Set(['', 'your-project.supabase.co', 'your-anon-key', undefined])

// Read existing .env (if any) into a map.
const env = {}
if (existsSync(ENV_PATH)) {
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m) env[m[1]] = m[2]
  }
}

const isMissing = (k) => {
  const v = process.env[k] ?? env[k]
  return v == null || PLACEHOLDERS.has(v) || v.includes('your-project') || v.includes('your-anon')
}

let restored = false
for (const k of Object.keys(DEFAULTS)) {
  if (isMissing(k)) {
    env[k] = DEFAULTS[k]
    restored = true
  }
}

if (restored) {
  const body = Object.keys(DEFAULTS).map((k) => `${k}=${env[k]}`).join('\n') + '\n'
  writeFileSync(ENV_PATH, body)
  console.log('[ensure-supabase-env] .env was missing/incomplete — restored from publishable defaults.')
}

// Final hard check: never let a build ship without real credentials.
const stillMissing = Object.keys(DEFAULTS).filter(isMissing)
if (stillMissing.length) {
  console.error(
    `\n[ensure-supabase-env] FATAL: missing ${stillMissing.join(', ')}.\n` +
    `Refusing to build — this would ship a blank page (createClient would throw).\n` +
    `Set them in .env before building.\n`,
  )
  process.exit(1)
}

console.log('[ensure-supabase-env] Supabase config present ✓')
