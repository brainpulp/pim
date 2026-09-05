// Supabase Edge Function: assistant
// Thin, authenticated proxy to the Claude Messages API. Holds ANTHROPIC_API_KEY server-side (the
// browser must never see it). The BROWSER drives the agentic loop and executes tools against the
// live Zustand store — this function just forwards one Claude turn per call and returns the raw
// response, so tool schemas + the executor stay in one place on the client.
//   POST { messages, tools, system } -> Claude Messages API response JSON
// verify_jwt is ON: only signed-in users can call it (this is also the natural Pro gate).

const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY') || ''
const MODEL = 'claude-opus-5'   // swap to 'claude-sonnet-5' or 'claude-haiku-4-5' for cheaper/faster

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (!ANTHROPIC_KEY) return json({ error: 'ANTHROPIC_API_KEY not configured on the server.' }, 500)
  try {
    const { messages, tools, system } = await req.json()
    if (!Array.isArray(messages)) return json({ error: 'messages[] required' }, 400)

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        output_config: { effort: 'low' },   // command-bar edits are simple → keep it snappy
        system,
        tools,
        messages,
      }),
    })
    const data = await res.json()
    if (!res.ok) return json({ error: data?.error?.message || 'Claude API error', detail: data }, res.status)
    return json(data)
  } catch (e) {
    return json({ error: (e as Error)?.message || 'assistant failed' }, 500)
  }
})
