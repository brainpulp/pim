// Supabase Edge Function: unfurl
// Server-side link preview (the browser can't fetch cross-origin pages — CORS blocks it, which is why
// WhatsApp/Discord unfurl links on their servers). Fetches a URL, extracts Open Graph / Twitter Card /
// basic <title>/<meta> tags, and returns a compact preview.
//   POST { url } → { url, title, description, image, siteName, favicon }
//
// No secrets required. Fetches with a browser-like UA, a size cap, and a timeout.

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

// Pull the first matching attribute value out of a <meta ...> whose name/property equals `key`.
function metaContent(html: string, keys: string[]): string {
  for (const key of keys) {
    // property/name="key" ... content="value"  (either attribute order)
    const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']*)["']`, 'i')
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${key}["']`, 'i')
    const m = html.match(re1) || html.match(re2)
    if (m && m[1]) return decodeEntities(m[1].trim())
  }
  return ''
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&#x2F;/g, '/')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&nbsp;/g, ' ')
}

function absolutize(base: string, ref: string): string {
  if (!ref) return ''
  try { return new URL(ref, base).href } catch { return ref }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const { url } = await req.json().catch(() => ({}))
    if (!url || typeof url !== 'string') return json({ error: 'Missing url' }, 400)
    let target: URL
    try { target = new URL(url) } catch { return json({ error: 'Invalid url' }, 400) }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return json({ error: 'Unsupported protocol' }, 400)

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8000)
    let res: Response
    try {
      res = await fetch(target.href, {
        redirect: 'follow',
        signal: ctrl.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; PIMBot/1.0; +https://brainpulp.github.io/pim/)',
          'Accept': 'text/html,application/xhtml+xml',
        },
      })
    } finally { clearTimeout(timer) }

    const finalUrl = res.url || target.href
    const ctype = res.headers.get('content-type') || ''

    // If it's an image/video/pdf itself, just return it as the preview image.
    if (/^image\//i.test(ctype)) return json({ url: finalUrl, title: target.hostname, description: '', image: finalUrl, siteName: target.hostname, favicon: '' })
    if (!/text\/html|application\/xhtml/i.test(ctype)) {
      return json({ url: finalUrl, title: decodeURIComponent(target.pathname.split('/').pop() || target.hostname), description: '', image: '', siteName: target.hostname, favicon: '' })
    }

    // Read at most ~512KB of HTML (the <head> is all we need).
    const reader = res.body?.getReader()
    let html = ''
    if (reader) {
      const dec = new TextDecoder()
      let total = 0
      while (total < 512 * 1024) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.length
        html += dec.decode(value, { stream: true })
        if (/<\/head>/i.test(html)) break   // stop once head closes
      }
      try { await reader.cancel() } catch { /* ignore */ }
    } else {
      html = await res.text()
    }

    const titleTag = (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '').trim()
    let title = metaContent(html, ['og:title', 'twitter:title']) || decodeEntities(titleTag) || target.hostname
    const description = metaContent(html, ['og:description', 'twitter:description', 'description'])
    let image = metaContent(html, ['og:image:secure_url', 'og:image', 'twitter:image', 'twitter:image:src'])
    const siteName = metaContent(html, ['og:site_name']) || target.hostname

    // Favicon: <link rel="icon"|"shortcut icon"|"apple-touch-icon"> or fall back to /favicon.ico.
    let favicon = ''
    const iconMatch = html.match(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*>/i)
    if (iconMatch) { const href = iconMatch[0].match(/href=["']([^"']+)["']/i)?.[1]; if (href) favicon = absolutize(finalUrl, href) }
    if (!favicon) favicon = absolutize(finalUrl, '/favicon.ico')

    image = image ? absolutize(finalUrl, image) : ''

    return json({ url: finalUrl, title, description, image, siteName, favicon })
  } catch (e) {
    return json({ error: (e as Error)?.message || 'unfurl failed' }, 200)
  }
})
