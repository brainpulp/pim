import { useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'

// Presenter side of the phone remote. Mounted (invisibly) whenever the remote link is enabled.
// Subscribes to `pim-remote-<code>`, routes incoming commands to actionsRef.current[action], and
// broadcasts the current `state` so the phone shows the live position. Answers a phone 'hello' with state.
export default function PresenterRemote({ code, actionsRef, state }) {
  const chanRef = useRef(null)
  const stateRef = useRef(state)
  stateRef.current = state
  const lastSentRef = useRef('')

  useEffect(() => {
    if (!code) return
    const chan = supabase.channel(`pim-remote-${code}`, { config: { broadcast: { self: false } } })
    chanRef.current = chan
    const pushState = () => { lastSentRef.current = JSON.stringify(stateRef.current); chan.send({ type: 'broadcast', event: 'state', payload: stateRef.current }) }
    chan.on('broadcast', { event: 'cmd' }, ({ payload }) => {
      const fn = actionsRef.current?.[payload?.action]
      if (fn) fn()
      // Re-broadcast shortly after so the phone reflects the result of the command.
      setTimeout(pushState, 80)
    })
    chan.on('broadcast', { event: 'hello' }, () => pushState())
    chan.subscribe(s => { if (s === 'SUBSCRIBED') pushState() })
    return () => { supabase.removeChannel(chan); chanRef.current = null }
  }, [code]) // eslint-disable-line

  // Push state when meaningful fields change (compare serialized payload — the object is fresh each render).
  const json = JSON.stringify(state)
  useEffect(() => {
    if (!chanRef.current || json === lastSentRef.current) return
    lastSentRef.current = json
    chanRef.current.send({ type: 'broadcast', event: 'state', payload: state })
  }, [json]) // eslint-disable-line

  return null
}
