import { useEffect, useMemo, useRef, useState } from 'react'
import { ReactFlow, Background, Controls, MiniMap, MarkerType } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { EditorView, keymap } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { Annotation } from '@codemirror/state'
import { autocompletion, completionKeymap } from '@codemirror/autocomplete'
import { linter, lintGutter } from '@codemirror/lint'
import { parseDsl } from '../strategy/parser'
import { lintStrategy } from '../strategy/lints'
import { layoutStrategy } from '../strategy/layout'
import { dslLanguage, makeDslCompletions } from '../strategy/editorLang'
import { TaskNode, DecisionNode, StartEndNode, NoteNode } from '../strategy/StrategyNodes'
import { loadStrategy, saveStrategy } from '../lib/db'
import '../strategy/strategy.css'

const STARTER_TEXT = `title: My strategy

# Type here and watch the flowchart build itself.
# Chains:        Research -> Prototype -> Ship
# Decisions:     decision Worth it?   then indented branches
# Dependencies:  Ship needs Legal review

start
Start -> Research -> Prototype

decision Worth shipping?
Prototype -> Worth shipping?
  yes -> Ship
  no -> Research

Ship needs Legal review
Ship -> end
`

const nodeTypes = { task: TaskNode, decision: DecisionNode, start: StartEndNode, end: StartEndNode, note: NoteNode }
const remoteChange = Annotation.define()

const editorTheme = EditorView.theme(
  {
    '&': { height: '100%', fontSize: '13px', backgroundColor: '#161616', color: '#ddd' },
    '.cm-scroller': { fontFamily: "'JetBrains Mono', 'Fira Code', monospace", overflow: 'auto' },
    '.cm-content': { paddingBottom: '40vh', caretColor: '#fff' },
    '&.cm-focused': { outline: 'none' },
    '.cm-gutters': { backgroundColor: '#161616', color: '#555', border: 'none' },
    '.cm-activeLine': { backgroundColor: '#ffffff08' },
    '.cm-activeLineGutter': { backgroundColor: '#ffffff08' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: '#264f7855' },
    '.cm-cursor': { borderLeftColor: '#fff' },
    '.cm-tooltip': { backgroundColor: '#222', color: '#ddd', border: '1px solid #333' },
    '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: '#2563eb', color: '#fff' },
    '.cm-keyword': { color: '#c084fc' },
    '.cm-comment': { color: '#6b7280' },
    '.cm-operator': { color: '#67e8f9' },
  },
  { dark: true },
)

function dslLinter(view) {
  const doc = view.state.doc.toString()
  return parseDsl(doc).diagnostics.map(d => ({
    from: Math.min(d.from, doc.length),
    to: Math.min(d.to, doc.length),
    severity: d.severity,
    message: d.message,
  }))
}

export default function Strategy({ projectId }) {
  const [loaded, setLoaded] = useState(false)
  const [parse, setParse] = useState(() => parseDsl(''))
  const [positions, setPositions] = useState({})
  const [saveState, setSaveState] = useState('saved') // 'saved' | 'dirty' | 'saving' | 'error'
  const [gapsOpen, setGapsOpen] = useState(true)

  const editorHostRef = useRef(null)
  const viewRef = useRef(null)
  const textRef = useRef('')
  const pinnedRef = useRef({})
  const parseTimer = useRef(null)
  const saveTimer = useRef(null)

  const reparse = () => {
    const result = parseDsl(textRef.current)
    const fresh = layoutStrategy(result.strategy)
    setPositions(prev => {
      const merged = {}
      const prunedPins = {}
      for (const node of result.strategy.nodes) {
        if (pinnedRef.current[node.id] && prev[node.id]) {
          merged[node.id] = prev[node.id]
          prunedPins[node.id] = true
        } else {
          merged[node.id] = fresh[node.id]
        }
      }
      pinnedRef.current = prunedPins
      return merged
    })
    setParse(result)
  }

  const scheduleSave = () => {
    setSaveState('dirty')
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      setSaveState('saving')
      try {
        await saveStrategy(projectId, { text: textRef.current, positions: positionsRef.current, pinned: pinnedRef.current })
        setSaveState('saved')
      } catch (e) {
        console.warn('Strategy save failed:', e)
        setSaveState('error')
      }
    }, 1200)
  }

  // keep a ref of positions for the save closure
  const positionsRef = useRef({})
  useEffect(() => { positionsRef.current = positions }, [positions])

  // Load once per project, then mount the editor.
  useEffect(() => {
    let cancelled = false
    setLoaded(false)
    loadStrategy(projectId)
      .catch(() => null)
      .then(data => {
        if (cancelled) return
        textRef.current = data?.text ?? STARTER_TEXT
        pinnedRef.current = data?.pinned ?? {}
        if (data?.positions) setPositions(data.positions)
        reparse()
        setLoaded(true)
      })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  useEffect(() => {
    if (!loaded || !editorHostRef.current) return
    const view = new EditorView({
      doc: textRef.current,
      parent: editorHostRef.current,
      extensions: [
        basicSetup,
        dslLanguage,
        editorTheme,
        autocompletion({ override: [makeDslCompletions(() => parseRef.current.names)], activateOnTyping: true }),
        keymap.of(completionKeymap),
        linter(dslLinter, { delay: 250 }),
        lintGutter(),
        EditorView.updateListener.of(update => {
          if (!update.docChanged) return
          if (update.transactions.some(tr => tr.annotation(remoteChange))) return
          textRef.current = update.state.doc.toString()
          clearTimeout(parseTimer.current)
          parseTimer.current = setTimeout(reparse, 150)
          scheduleSave()
        }),
      ],
    })
    viewRef.current = view
    return () => { view.destroy(); viewRef.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, projectId])

  // latest parse for the completion source
  const parseRef = useRef(parse)
  useEffect(() => { parseRef.current = parse }, [parse])

  // flush pending save on unmount / tab switch
  useEffect(() => () => {
    clearTimeout(parseTimer.current)
    clearTimeout(saveTimer.current)
    if (saveTimer.current) {
      saveStrategy(projectId, { text: textRef.current, positions: positionsRef.current, pinned: pinnedRef.current }).catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  const lints = useMemo(() => lintStrategy(parse.strategy), [parse])

  const rfNodes = useMemo(
    () => parse.strategy.nodes.map(n => ({
      id: n.id,
      type: n.kind,
      position: positions[n.id] ?? { x: 0, y: 0 },
      data: { strategyNode: n },
    })),
    [parse, positions],
  )

  const rfEdges = useMemo(
    () => parse.strategy.edges.map(e => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.label,
      animated: e.kind === 'dependency',
      style: e.kind === 'dependency'
        ? { strokeDasharray: '6 4', stroke: '#d97706' }
        : { stroke: '#64748b' },
      labelStyle: { fill: '#ddd', fontSize: 12 },
      labelBgStyle: { fill: '#1b1b1b', fillOpacity: 0.9 },
      markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18 },
    })),
    [parse],
  )

  const onNodeDragStop = (_evt, node) => {
    pinnedRef.current = { ...pinnedRef.current, [node.id]: true }
    setPositions(prev => ({ ...prev, [node.id]: node.position }))
    scheduleSave()
  }

  const relayout = () => {
    pinnedRef.current = {}
    reparse()
    scheduleSave()
  }

  if (!loaded) return <div style={{ padding: 24, color: '#888' }}>Loading strategy…</div>

  return (
    <div className="strat-page">
      <div className="strat-left">
        <div className="strat-toolbar">
          <span className="strat-hint">Type your plan — the flowchart draws itself</span>
          <span className={`strat-save strat-save-${saveState}`}>
            {saveState === 'saved' ? 'Saved' : saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Save failed — retrying on next edit' : 'Unsaved'}
          </span>
          <button className="strat-btn" onClick={relayout}>Re-layout</button>
        </div>
        <div className="strat-editor" ref={editorHostRef} />
        {lints.length > 0 && (
          <div className="strat-gaps">
            <button className="strat-gaps-header" onClick={() => setGapsOpen(!gapsOpen)}>
              {gapsOpen ? '▾' : '▸'} Gaps ({lints.length})
            </button>
            {gapsOpen && (
              <ul>
                {lints.map(l => (
                  <li key={l.id} className={`strat-gap-${l.severity}`}>{l.message}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      <div className="strat-canvas">
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          onNodeDragStop={onNodeDragStop}
          nodesConnectable={false}
          colorMode="dark"
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={20} color="#2a2a2a" />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>
    </div>
  )
}
