import { useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'

// Presenter side of the phone remote. Mounted (invisibly) whenever the remote link is enabled.
// Subscribes to `pim-remote-<code>`, routes incoming commands to actionsRef.current[action], and
// broadcasts the current `state` so the phone shows the live position. Answers a phone 'hello' with state.
// Auto-reconnects if the realtime channel drops (network blip, laptop sleep) so control isn't silently lost.
export default function PresenterRemote({ code, actionsRef, state }) {
  const chanRef = useRef(null)
  const stateRef = useRef(state)
  stateRef.current = state
  const lastSentRef = useRef('')

  useEffect(() => {
    if (!code) return
    let closed = false
    let retry = null
    const pushState = () => {
      const ch = chanRef.current; if (!ch) return
      lastSentRef.current = JSON.stringify(stateRef.current)
      try { ch.send({ type: 'broadcast', event: 'state', payload: stateRef.current }) } catch { /* ignore */ }
    }
    const setup = () => {
      if (closed) return
      const chan = supabase.channel(`pim-remote-${code}`, { config: { broadcast: { self: false } } })
      chanRef.current = chan
      chan.on('broadcast', { event: 'cmd' }, ({ payload }) => {
        const fn = actionsRef.current?.[payload?.action]
        if (fn) fn()
        setTimeout(pushState, 80)   // reflect the result back to the phone
      })
      chan.on('broadcast', { event: 'hello' }, () => pushState())
      chan.subscribe(s => {
        if (s === 'SUBSCRIBED') pushState()
        else if ((s === 'CHANNEL_ERROR' || s === 'TIMED_OUT' || s === 'CLOSED') && !closed) {
          // Channel died — rebuild it shortly. The client's socket also auto-reconnects underneath.
          try { supabase.removeChannel(chan) } catch { /* ignore */ }
          if (chanRef.current === chan) chanRef.current = null
          clearTimeout(retry); retry = setTimeout(setup, 1500)
        }
      })
    }
    setup()
    return () => { closed = true; clearTimeout(retry); try { supabase.removeChannel(chanRef.current) } catch { /* ignore */ } chanRef.current = null }
  }, [code]) // eslint-disable-line

  // Push state when meaningful fields change (compare serialized payload — the object is fresh each render).
  const json = JSON.stringify(state)
  useEffect(() => {
    if (!chanRef.current || json === lastSentRef.current) return
    lastSentRef.current = json
    try { chanRef.current.send({ type: 'broadcast', event: 'state', payload: state }) } catch { /* ignore */ }
  }, [json]) // eslint-disable-line

  return null
}
