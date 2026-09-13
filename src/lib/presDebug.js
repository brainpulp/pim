// Tiny shared logger for diagnosing presentation control (arrows / bar / remote) on a real machine.
// Both Graph.jsx and YTSlideshow.jsx push to it; the on-screen overlay in Graph renders the tail.
export const presLog = []
let seq = 0
export function plog(m) {
  seq++
  const t = new Date()
  const ts = `${String(t.getSeconds()).padStart(2, '0')}.${String(t.getMilliseconds()).padStart(3, '0')}`
  presLog.push(`${String(seq).padStart(3, '0')} ${ts} ${m}`)
  while (presLog.length > 16) presLog.shift()
}
