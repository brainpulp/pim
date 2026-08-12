// Word-generation tool.
//
// A "master" node's criteria (its non-generated children + its own label) are combined into a prompt
// that generates child WORDS. Triggering a word generates child VARIATIONS, optionally with an injected
// modifier. Generated nodes are tagged in the store as meta.wg = 'word' | 'variation' so they're excluded
// from the criteria on the next run.
//
// Backend: if the user has pasted an Anthropic API key (stored locally), we call the API directly from
// the browser (single-user app; the key never leaves their machine). With no key we fall back to a stub
// generator so the whole mechanic is usable/demonstrable offline. Swapping the direct call for a Supabase
// Edge Function later is a drop-in change inside `callClaude`.

const KEY_LS = 'pim_wordgen_key'
const MODEL_LS = 'pim_wordgen_model'
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001'

export const getWordgenKey = () => { try { return localStorage.getItem(KEY_LS) || '' } catch { return '' } }
export const setWordgenKey = (k) => { try { k ? localStorage.setItem(KEY_LS, k) : localStorage.removeItem(KEY_LS) } catch { /* ignore */ } }
export const getWordgenModel = () => { try { return localStorage.getItem(MODEL_LS) || DEFAULT_MODEL } catch { return DEFAULT_MODEL } }
export const setWordgenModel = (m) => { try { m ? localStorage.setItem(MODEL_LS, m) : localStorage.removeItem(MODEL_LS) } catch { /* ignore */ } }
export const hasWordgenKey = () => !!getWordgenKey()

// ── Prompt building ─────────────────────────────────────────────────────────
function buildPrompt({ mode, theme, criteria, seed, modifier, count }) {
  const lines = []
  if (mode === 'variations') {
    lines.push(`Generate ${count} creative variations of the word/name: "${seed}".`)
    if (theme) lines.push(`It belongs to this theme: ${theme}.`)
  } else {
    lines.push(`Generate ${count} original words/names.`)
    if (theme) lines.push(`Overall theme: ${theme}.`)
    if (criteria && criteria.length) lines.push(`They must satisfy ALL of these criteria:\n- ${criteria.join('\n- ')}`)
  }
  if (modifier) lines.push(`Additional instruction: ${modifier}.`)
  lines.push('Return ONLY a compact JSON array of strings, no prose, no numbering, no code fences.')
  return lines.join('\n')
}

// ── Real backend (direct browser call to Anthropic) ──────────────────────────
async function callClaude(prompt) {
  const key = getWordgenKey()
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: getWordgenModel(),
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try { const j = await res.json(); msg = j?.error?.message || msg } catch { /* ignore */ }
    throw new Error(msg)
  }
  const data = await res.json()
  const text = (data?.content || []).map(b => b?.text || '').join('').trim()
  return text
}

// Pull a JSON array of strings out of a model response (tolerant of stray prose / fences).
function parseWords(text) {
  if (!text) return []
  let t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const start = t.indexOf('['), end = t.lastIndexOf(']')
  if (start !== -1 && end !== -1 && end > start) t = t.slice(start, end + 1)
  try {
    const arr = JSON.parse(t)
    if (Array.isArray(arr)) return arr.map(x => String(x).trim()).filter(Boolean)
  } catch { /* fall through to line parsing */ }
  return t.split('\n').map(l => l.replace(/^[\s\-*\d.)]+/, '').trim()).filter(Boolean).slice(0, 50)
}

// ── Stub generator (no key) ──────────────────────────────────────────────────
// Deterministic-ish, plausible-looking made-up words derived from the inputs, so the tool is fully
// usable to shape the tree before wiring a key. Varied by index so repeats differ.
const SYL = ['ka', 'lo', 'ven', 'tri', 'sol', 'mar', 'quo', 'bel', 'nyx', 'zeph', 'ora', 'lum', 'fen', 'ryl', 'thes', 'vio', 'cad', 'mun', 'per', 'sil']
function stubWords({ mode, seed, theme, criteria, count, salt = 0 }) {
  const base = (mode === 'variations' ? seed : (criteria?.[0] || theme || 'word')) || 'word'
  const clean = base.toLowerCase().replace(/[^a-z]/g, '').slice(0, 4) || 'wor'
  const out = []
  for (let i = 0; i < count; i++) {
    const a = SYL[(i * 7 + salt + clean.length) % SYL.length]
    const b = SYL[(i * 13 + salt + 3) % SYL.length]
    let w
    if (mode === 'variations') w = clean.charAt(0).toUpperCase() + clean.slice(1) + a + (i % 2 ? b : '')
    else w = (a.charAt(0).toUpperCase() + a.slice(1) + b + (i % 3 === 0 ? clean.slice(0, 2) : ''))
    out.push(w.charAt(0).toUpperCase() + w.slice(1))
  }
  return out
}

// ── Public API ───────────────────────────────────────────────────────────────
// opts: { mode:'words'|'variations', theme, criteria:string[], seed, modifier, count }
// returns { words: string[], stub: boolean }
export async function generateWords(opts) {
  const count = Math.max(1, Math.min(30, opts.count || 8))
  if (!hasWordgenKey()) {
    return { words: stubWords({ ...opts, count, salt: (opts.seed || '').length + (opts.modifier || '').length }), stub: true }
  }
  const prompt = buildPrompt({ ...opts, count })
  const text = await callClaude(prompt)
  const words = parseWords(text).slice(0, count)
  return { words, stub: false }
}
