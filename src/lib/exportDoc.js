// Quick export of a project's outline and/or graph to PDF (via the browser print dialog) or a Word
// .doc (HTML-based, which Word opens). The graph is passed in as a self-contained SVG string built by
// the caller (clean vector — no foreignObjects), rasterized to PNG for reliable embedding.

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

// Nested <ul> outline from shared topology; `hidden` = that view's hidden node ids (excluded).
export function outlineHTML(nodes, edges, hidden) {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const childrenOf = {}, parentCount = {}
  nodes.forEach(n => { childrenOf[n.id] = []; parentCount[n.id] = 0 })
  edges.forEach(e => { if (childrenOf[e.source]) childrenOf[e.source].push(e.target); if (parentCount[e.target] !== undefined) parentCount[e.target]++ })
  const seen = new Set()
  const li = (id) => {
    if (seen.has(id) || hidden?.has(id)) return ''
    seen.add(id)
    const n = byId.get(id); if (!n) return ''
    const kids = (childrenOf[id] || []).map(li).filter(Boolean).join('')
    const note = n.notes ? `<div class="note">${esc(n.notes)}</div>` : ''
    return `<li>${esc(n.label || '(untitled)')}${note}${kids ? `<ul>${kids}</ul>` : ''}</li>`
  }
  const roots = nodes.filter(n => parentCount[n.id] === 0 && !hidden?.has(n.id)).map(n => n.id)
  let body = roots.map(li).filter(Boolean).join('')
  nodes.forEach(n => { if (!seen.has(n.id) && !hidden?.has(n.id)) { const s = li(n.id); if (s) body += s } })   // orphans/cycles
  return `<ul class="outline">${body || '<li>(empty)</li>'}</ul>`
}

// Rasterize a standalone SVG string to a white-safe PNG data URL (reliable in both print and Word).
export function svgToPng(svgString, width, height, bg = '#0c0c1a') {
  return new Promise(resolve => {
    const img = new Image()
    const url = URL.createObjectURL(new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' }))
    img.onload = () => {
      const scale = 2   // crisp on retina / print
      const c = document.createElement('canvas'); c.width = width * scale; c.height = height * scale
      const ctx = c.getContext('2d'); ctx.scale(scale, scale)
      ctx.fillStyle = bg; ctx.fillRect(0, 0, width, height)
      ctx.drawImage(img, 0, 0, width, height)
      URL.revokeObjectURL(url); resolve(c.toDataURL('image/png'))
    }
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null) }
    img.src = url
  })
}

const DOC_CSS = `
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; color: #111; margin: 32px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 28px 0 10px; color: #333; border-bottom: 1px solid #ccc; padding-bottom: 4px; }
  .section { page-break-inside: avoid; margin-bottom: 24px; }
  .section + .section { page-break-before: always; }
  ul.outline { list-style: none; padding-left: 0; }
  ul.outline ul { list-style: none; padding-left: 18px; border-left: 1px solid #ddd; margin-left: 6px; }
  ul.outline li { margin: 3px 0; font-size: 13px; line-height: 1.45; }
  .note { color: #666; font-size: 11.5px; margin: 1px 0 3px 2px; white-space: pre-wrap; }
  img.graph { max-width: 100%; height: auto; border: 1px solid #ddd; border-radius: 6px; }
  .muted { color: #888; font-size: 12px; }
`

// sections: [{ viewName, outline?: html, graphPng?: dataURL }]
export function buildDocumentHTML(title, sections, forWord) {
  const head = forWord
    ? `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${DOC_CSS}</style></head>`
    : `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${DOC_CSS}</style></head>`
  const body = sections.map(s => `
    <div class="section">
      <h2>${esc(s.viewName)}</h2>
      ${s.graphPng ? `<img class="graph" src="${s.graphPng}" />` : ''}
      ${s.outline || ''}
      ${!s.graphPng && !s.outline ? '<div class="muted">Nothing to export for this view.</div>' : ''}
    </div>`).join('')
  return `${head}<body><h1>${esc(title)}</h1>${body}</body></html>`
}

export function downloadDoc(html, filename) {
  const blob = new Blob(['﻿', html], { type: 'application/msword' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob); a.download = filename.endsWith('.doc') ? filename : filename + '.doc'
  document.body.appendChild(a); a.click()
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove() }, 1000)
}

export function printPDF(html) {
  const w = window.open('', '_blank')
  if (!w) { alert('Please allow pop-ups to export a PDF.'); return }
  w.document.write(html); w.document.close()
  w.onload = () => { w.focus(); w.print() }
  setTimeout(() => { try { w.focus(); w.print() } catch (_) { /* onload already fired */ } }, 400)
}
