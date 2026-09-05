// Tiny synthesized UI sounds — no assets. One shared AudioContext, lazily created on first use
// (browsers require a user gesture before audio; drops are gesture-driven, so this is fine).
let _ctx = null
function ctx() {
  if (typeof window === 'undefined') return null
  if (!_ctx) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) _ctx = new AC() }
  if (_ctx && _ctx.state === 'suspended') _ctx.resume().catch(() => {})
  return _ctx
}

// A short, soft "bleep" — the single confirm sound for any drop-into across the app.
export function playDrop() {
  const c = ctx(); if (!c) return
  const t = c.currentTime
  const osc = c.createOscillator(), gain = c.createGain()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(660, t)
  osc.frequency.exponentialRampToValueAtTime(990, t + 0.08)
  gain.gain.setValueAtTime(0.0001, t)
  gain.gain.exponentialRampToValueAtTime(0.16, t + 0.015)
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18)
  osc.connect(gain); gain.connect(c.destination)
  osc.start(t); osc.stop(t + 0.2)
}
