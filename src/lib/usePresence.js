import { useEffect, useRef, useState, useCallback } from 'react'
import { supabase } from './supabase'

// Phase 2a — realtime presence (who's here + live cursors) over a Supabase Realtime channel keyed by
// project. Ephemeral only (no DB writes): presence tracks the roster, broadcast carries cursor moves.
// Works for signed-in editors and anonymous shared-link viewers alike (they share the project channel).

const COLORS = ['#7c8cff', '#4fd1c5', '#f6ad55', '#fc8181', '#b794f4', '#68d391', '#63b3ed', '#f687b3', '#f6e05e']
const pickColor = (s = '') => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return COLORS[Math.abs(h) % COLORS.length] }

export function usePresence(projectId, enabled = true) {
  // A per-tab id is the presence key (two tabs of the same account are distinct participants).
  const selfIdRef = useRef(null)
  if (!selfIdRef.current) selfIdRef.current = crypto.randomUUID()
  const selfId = selfIdRef.current
  const selfRef = useRef({ id: selfId, name: 'Guest', color: pickColor(selfId) })
  const [self, setSelf] = useState(selfRef.current)
  const [peers, setPeers] = useState([])        // [{ id, name, color }] (excludes self)
  const [cursors, setCursors] = useState({})    // { peerId: { id, x, y, name, color } } in world coords
  const chRef = useRef(null)

  // Resolve identity from the signed-in user (guest otherwise); re-track if it lands after subscribe.
  useEffect(() => {
    let cancelled = false
    supabase.auth.getUser().then(({ data }) => {
      const u = data?.user; if (cancelled || !u) return
      const next = { id: selfId, name: (u.email || '').split('@')[0] || 'User', color: pickColor(u.id) }
      selfRef.current = next; setSelf(next)
      if (chRef.current) chRef.current.track(next)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [selfId])

  useEffect(() => {
    if (!enabled || !projectId) return
    const ch = supabase.channel('presence:' + projectId, {
      config: { presence: { key: selfId }, broadcast: { self: false } },
    })
    chRef.current = ch
    const syncPeers = () => {
      const state = ch.presenceState(); const seen = new Set(); const uniq = []
      Object.values(state).forEach(arr => arr.forEach(m => { if (m.id && m.id !== selfId && !seen.has(m.id)) { seen.add(m.id); uniq.push(m) } }))
      setPeers(uniq)
    }
    ch.on('presence', { event: 'sync' }, syncPeers)
    ch.on('presence', { event: 'leave' }, ({ key }) => setCursors(c => { if (!c[key]) return c; const n = { ...c }; delete n[key]; return n }))
    ch.on('broadcast', { event: 'cursor' }, ({ payload }) => {
      if (!payload || payload.id === selfId) return
      setCursors(c => ({ ...c, [payload.id]: payload }))
    })
    ch.subscribe(status => { if (status === 'SUBSCRIBED') ch.track(selfRef.current) })
    return () => { supabase.removeChannel(ch); chRef.current = null; setPeers([]); setCursors({}) }
  }, [enabled, projectId, selfId])

  // Throttled cursor broadcast (~22/s) in world coords, so a cursor points at the same content
  // regardless of each viewer's own pan/zoom.
  const lastSent = useRef(0)
  const sendCursor = useCallback((x, y) => {
    const ch = chRef.current; if (!ch) return
    const now = performance.now()
    if (now - lastSent.current < 45) return
    lastSent.current = now
    ch.send({ type: 'broadcast', event: 'cursor', payload: { id: selfId, x, y, name: selfRef.current.name, color: selfRef.current.color } })
  }, [selfId])

  return { self, peers, cursors, sendCursor }
}
