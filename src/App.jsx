import { useEffect, useState, useRef, Component } from 'react'
import { supabase } from './lib/supabase'
import { renameProject, loadProject, listProjects, compactProjectViews, saveProject } from './lib/db'
import useGraphStore from './lib/graphStore'
import Auth from './components/Auth'
import Projects from './pages/Projects'
import Graph from './pages/Graph'
import Table from './pages/Table'
import Writer from './pages/Writer'
import PackBoard from './pages/PackBoard'
import PackLab from './pages/PackLab'
import CommandPalette from './components/CommandPalette'
import SharedView from './pages/SharedView'
import ShareDialog from './components/ShareDialog'

const parseShareToken = () => {
  const m = window.location.hash.match(/^#\/share\/([A-Za-z0-9]+)/)
  return m ? m[1] : null
}

class AppErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { err: null } }
  static getDerivedStateFromError(e) { return { err: e } }
  render() {
    if (this.state.err) return (
      <div style={{ padding: 24, color: '#f87171', fontFamily: 'monospace', fontSize: 13, background: '#0f0f0f', height: '100%', overflow: 'auto' }}>
        <div style={{ marginBottom: 8, color: '#fff', fontSize: 15 }}>App crashed — error details:</div>
        <div style={{ color: '#fbbf24', marginBottom: 8 }}>{String(this.state.err.message)}</div>
        <pre style={{ color: '#aaa', whiteSpace: 'pre-wrap' }}>{this.state.err.stack}</pre>
      </div>
    )
    return this.props.children
  }
}

export default function App() {
  // DEV-ONLY UI sandbox: ?uidev=1 seeds a fixture project and bypasses auth so the chrome can be
  // screenshotted without Supabase. Gated on import.meta.env.DEV → dead code in production builds.
  const DEVUI = import.meta.env.DEV && typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('uidev') === '1'
  const _loadForDev = useGraphStore(s => s.loadProjectData)
  useEffect(() => {
    if (!DEVUI) return
    if (useGraphStore.getState().loadedProjectId === 'devui') return
    const nodeProps = {
      n1: { shape: 'roundrect', fillColor: '#5b6af0', textColor: '#fff' },
      n2: { shape: 'circle', fillColor: '#0f766e', textColor: '#fff' },
      n3: { shape: 'circle', fillColor: '#b45309', textColor: '#fff' },
      n4: { shape: 'diamond', fillColor: '#7c3aed', textColor: '#fff' },
      n5: { shape: 'roundrect', fillColor: '#be123c', textColor: '#fff' },
      n6: { shape: 'ellipse', fillColor: '#2563eb', textColor: '#fff' },
    }
    _loadForDev({
      nodes: [ { id:'n1',label:'Projects' },{ id:'n2',label:'PIM' },{ id:'n3',label:'Marketing' },{ id:'n4',label:'Ideas' },{ id:'n5',label:'Ship v2' },{ id:'n6',label:'Research' } ],
      edges: [ {id:'e1',source:'n1',target:'n2'},{id:'e2',source:'n1',target:'n3'},{id:'e3',source:'n2',target:'n5'},{id:'e4',source:'n2',target:'n6'},{id:'e5',source:'n3',target:'n4'} ],
      views: [ { id:'v1', name:'Main', nodeProps, bgColor:'#0c0c1a', images:[], slides:[] } ],
      activeViewId: 'v1', propertyDefs: [], styles: [], loadedProjectId: 'devui',
    })
    setSession({ user: { email: 'ui@dev' } })
    setProject({ id: 'devui', name: 'UI Sandbox' })
  }, [DEVUI, _loadForDev])
  const [session, setSession] = useState(undefined) // undefined = loading
  // Initialize project synchronously from localStorage — avoids race with onAuthStateChange
  const [project, setProject] = useState(() => {
    try {
      const saved = localStorage.getItem('pim_last_project')
      return saved ? JSON.parse(saved) : null
    } catch { return null }
  })
  const [view, setView] = useState(() => {   // restore the last-used tab (canvas/graph/table/lab)
    try { return localStorage.getItem('pim_last_view') || 'board' } catch { return 'board' }
  })
  useEffect(() => { try { localStorage.setItem('pim_last_view', view) } catch { /* ignore */ } }, [view])
  // Docked outliner (the Writer as a resizable side panel beside the canvas), with selection synced.
  const [outlineDock, setOutlineDock] = useState(() => { try { return localStorage.getItem('pim_outline_dock') === '1' } catch { return false } })
  useEffect(() => { try { localStorage.setItem('pim_outline_dock', outlineDock ? '1' : '0') } catch { /* ignore */ } }, [outlineDock])
  const [outlineW, setOutlineW] = useState(() => { try { return Math.max(240, Math.min(720, +localStorage.getItem('pim_outline_w') || 380)) } catch { return 380 } })
  useEffect(() => { try { localStorage.setItem('pim_outline_w', String(outlineW)) } catch { /* ignore */ } }, [outlineW])
  const startDockResize = (e) => {
    e.preventDefault()
    const startX = e.clientX, startW = outlineW
    const move = ev => setOutlineW(Math.max(240, Math.min(720, startW + (ev.clientX - startX))))
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
  }
  // ⌘K / Ctrl-K command palette.
  const [paletteOpen, setPaletteOpen] = useState(false)
  const paletteNodes = useGraphStore(s => s.nodes)
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); setPaletteOpen(o => !o) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const [renamingProject, setRenamingProject] = useState(false)
  const [projectDraft, setProjectDraft] = useState('')
  const [shareToken, setShareToken] = useState(() => parseShareToken())
  const [showShare, setShowShare] = useState(false)
  const renameInputRef = useRef()
  // Cross-project links: a node can jump to another project; a back-stack lets you return.
  // Kept in sessionStorage so a chain (A → B → C) survives reload within the tab.
  const [projectList, setProjectList] = useState([])
  const [backStack, setBackStack] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem('pim_back_stack') || '[]') } catch { return [] }
  })
  useEffect(() => { sessionStorage.setItem('pim_back_stack', JSON.stringify(backStack)) }, [backStack])

  useEffect(() => {
    const onHash = () => setShareToken(parseShareToken())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const openProject = (id, name) => {
    localStorage.setItem('pim_last_project', JSON.stringify({ id, name }))
    setProject({ id, name })
  }
  // Follow a node's cross-project link: remember where we came from, then open the target.
  const navigateToProject = (id, name) => {
    if (!id || id === project?.id) return
    if (project) setBackStack(st => [...st, { id: project.id, name: project.name }])
    openProject(id, name)
  }
  const goBack = () => {
    if (!backStack.length) return
    const prev = backStack[backStack.length - 1]
    setBackStack(backStack.slice(0, -1))
    openProject(prev.id, prev.name)
  }

  // Load the open project's snapshot into the store here (not inside Graph) so EVERY tab —
  // graph, table, pack, board, lab — reflects the project you opened. Loading it only inside
  // Graph meant switching projects while on a non-graph tab left the previous project on screen.
  const loadProjectData = useGraphStore(s => s.loadProjectData)
  const [projectLoadErr, setProjectLoadErr] = useState(null)
  useEffect(() => {
    if (!project?.id || shareToken) return
    let cancelled = false
    setProjectLoadErr(null)
    if (useGraphStore.getState().loadedProjectId !== project.id) {
      loadProject(project.id)
        .then(async d => {
          if (cancelled) return
          loadProjectData({ nodes: d.nodes, edges: d.edges, views: d.views, activeViewId: d.active_view_id, propertyDefs: d.property_defs, styles: d.styles, loadedProjectId: project.id })
          // One-time compaction: offload any embedded base64 images to Storage so the project row
          // shrinks — this is what was making loads slow and oversized saves silently fail.
          try {
            const { views: v2, changed } = await compactProjectViews(project.id, d.views)
            if (changed && !cancelled && useGraphStore.getState().loadedProjectId === project.id) {
              const s = useGraphStore.getState()
              loadProjectData({ nodes: s.nodes, edges: s.edges, views: v2, activeViewId: s.activeViewId, propertyDefs: s.propertyDefs, styles: s.styles, loadedProjectId: project.id })
              await saveProject(project.id, { nodes: s.nodes, edges: s.edges, views: v2, activeViewId: s.activeViewId, propertyDefs: s.propertyDefs, styles: s.styles })
            }
          } catch (e) { console.warn('Compaction skipped:', e?.message || e) }
        })
        .catch(e => { if (!cancelled) { console.error('Load failed:', e); setProjectLoadErr(e.message || 'Failed to load project') } })
    }
    return () => { cancelled = true }
  }, [project?.id, shareToken, loadProjectData])
  const closeProject = () => {
    localStorage.removeItem('pim_last_project')
    setBackStack([])   // leaving via the picker breaks any link chain
    setProject(null)
  }

  // Keep the list of projects fresh for the "link to project" picker (and back-button names).
  useEffect(() => {
    if (!session || shareToken) return
    let cancelled = false
    listProjects().then(d => { if (!cancelled) setProjectList(d || []) }).catch(() => {})
    return () => { cancelled = true }
  }, [session, shareToken, project?.id])

  useEffect(() => {
    if (DEVUI) return   // dev sandbox seeds its own fake session
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s)
      if (!s) { setProject(null); localStorage.removeItem('pim_last_project') }
    })
    return () => subscription.unsubscribe()
  }, [])

  // A `#/share/<token>` link is handled before the auth gate so view-only links
  // work with no sign-in. Wait for the session to resolve first (editor links redeem).
  if (shareToken) {
    if (session === undefined) return <div style={loadingStyle}>Loading…</div>
    return <SharedView token={shareToken} session={session}
      onOpenOwned={(id, name) => { window.location.hash = ''; setShareToken(null); openProject(id, name) }} />
  }

  if (session === undefined) return <div style={loadingStyle}>Loading…</div>
  if (!session) return <Auth />
  if (!project) return (
    <Projects
      onOpen={openProject}
      onSignOut={() => supabase.auth.signOut()}
    />
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#0f0f0f' }}>
      <nav style={navStyle}>
        <button className="pim-nav-btn" style={backBtnStyle} onClick={closeProject} title="All projects">
          <span style={{ fontSize: '1em', opacity: 0.7 }}>‹</span> Projects
        </button>
        <div style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', display: 'flex', alignItems: 'center', pointerEvents: 'none', maxWidth: '40%' }}>
          {renamingProject ? (
            <input
              ref={renameInputRef}
              value={projectDraft}
              onChange={e => setProjectDraft(e.target.value)}
              onBlur={async () => {
                const name = projectDraft.trim() || project.name
                if (name !== project.name) {
                  await renameProject(project.id, name)
                  const updated = { ...project, name }
                  localStorage.setItem('pim_last_project', JSON.stringify(updated))
                  setProject(updated)
                }
                setRenamingProject(false)
              }}
              onKeyDown={e => {
                if (e.key === 'Enter') e.currentTarget.blur()
                if (e.key === 'Escape') { setRenamingProject(false) }
                e.stopPropagation()
              }}
              style={{ ...projectRenameInputStyle, pointerEvents: 'auto' }}
              autoFocus
            />
          ) : (
            <span
              style={{ ...projectNameStyle, pointerEvents: 'auto' }}
              title="Rename project"
              onClick={() => { setProjectDraft(project.name); setRenamingProject(true) }}
            >{project.name}<span style={{ marginLeft: 6, opacity: 0.6, fontSize: '0.8em' }}>✎</span></span>
          )}
        </div>
        {/* Segmented tab control — Figma/Linear style */}
        <div style={segStyle}>
          {[['board', 'Canvas'], ['graph', 'Graph'], ['write', 'Write'], ['table', 'Table'], ['lab', 'Lab']].map(([v, label]) => (
            <button
              key={v}
              className="pim-nav-tab"
              style={{ ...segTabStyle, ...(view === v ? segTabActiveStyle : {}) }}
              onClick={() => setView(v)}
            >
              {label}
            </button>
          ))}
        </div>
        {(view === 'board' || view === 'graph') && (
          <button title="Toggle the outliner panel beside the canvas"
            className="pim-nav-btn"
            style={{ ...iconBtnStyle, ...(outlineDock ? iconBtnActiveStyle : {}) }}
            onClick={() => setOutlineDock(o => !o)}>◨ Outline</button>
        )}
        <button className="pim-nav-btn" style={kbarStyle} onClick={() => setPaletteOpen(true)} title="Quick jump / commands">
          <span style={{ opacity: 0.7 }}>Search</span>
          <span style={kbdStyle}>⌘K</span>
        </button>
        <button className="pim-nav-btn" style={shareBtnStyle} onClick={() => setShowShare(true)} title="Share this project">
          Share
        </button>
        <button className="pim-nav-btn" style={signOutStyle} onClick={() => supabase.auth.signOut()} title="Sign out">⏻</button>
      </nav>
      {showShare && (
        <ShareDialog projectId={project.id} projectName={project.name} onClose={() => setShowShare(false)} />
      )}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        nodes={paletteNodes}
        onJump={(id) => { useGraphStore.getState().setSelectedNodeId(id); if (!outlineDock && (view === 'board' || view === 'graph')) setOutlineDock(true) }}
        actions={[
          { label: 'Go to Canvas', hint: 'view', run: () => setView('board') },
          { label: 'Go to Graph', hint: 'view', run: () => setView('graph') },
          { label: 'Go to Write', hint: 'view', run: () => setView('write') },
          { label: 'Go to Table', hint: 'view', run: () => setView('table') },
          { label: outlineDock ? 'Hide outliner panel' : 'Show outliner panel', hint: 'toggle', run: () => setOutlineDock(o => !o) },
          { label: 'New item (in outliner)', hint: 'create', run: () => { const id = useGraphStore.getState().addNode('', null); useGraphStore.getState().setSelectedNodeId(id); if (view !== 'write' && !outlineDock) setOutlineDock(true) } },
        ]}
      />
      {projectLoadErr && (
        <div style={{ background: '#2a1a1a', borderBottom: '1px solid #f87171', color: '#f87171', fontSize: '0.8rem', padding: '6px 14px', flexShrink: 0 }}>
          Couldn’t load this project: {projectLoadErr}
        </div>
      )}
      {/* key={project.id} → remount views on project switch so no per-project state leaks (view ids
          like "view-default" are shared across projects, so keying effects on the view id alone was
          not enough — a fresh mount guarantees clusters, pan/zoom, and refs reset). */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative', display: 'flex' }}>
        {/* Outliner docks on the LEFT, beside the canvas. */}
        {outlineDock && (view === 'board' || view === 'graph') && (
          <>
            <div style={{ width: outlineW, flexShrink: 0, height: '100%', overflow: 'hidden' }}>
              <AppErrorBoundary><Writer key={'dock-' + project.id} projectName={project.name} embedded /></AppErrorBoundary>
            </div>
            <div onMouseDown={startDockResize} title="Drag to resize"
              style={{ width: 6, flexShrink: 0, cursor: 'col-resize', background: '#15151f', borderRight: '1px solid #24243a' }} />
          </>
        )}
        <div style={{ flex: 1, minWidth: 0, height: '100%', position: 'relative' }}>
          {view === 'graph' && (
            <AppErrorBoundary>
            <Graph
              key={project.id}
              projectId={project.id}
              projectName={project.name}
              onBack={() => setProject(null)}
            />
            </AppErrorBoundary>
          )}
          {view === 'write' && <AppErrorBoundary><Writer key={project.id} projectName={project.name} /></AppErrorBoundary>}
          {view === 'table' && <Table key={project.id} projectId={project.id} />}
          {view === 'board' && <AppErrorBoundary><PackBoard key={project.id} projectId={project.id} projectList={projectList} onNavigateProject={navigateToProject} /></AppErrorBoundary>}
          {view === 'lab' && <AppErrorBoundary><PackLab /></AppErrorBoundary>}
          {backStack.length > 0 && (
            <button style={backChipStyle} onClick={goBack}
              title={`Back to ${backStack[backStack.length - 1].name}`}>
              ← Back to {backStack[backStack.length - 1].name}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
const navStyle = {
  display: 'flex', alignItems: 'center', gap: '0.6rem',
  padding: '0 14px', height: 48, background: 'linear-gradient(#111119, #0d0d14)',
  borderBottom: '1px solid #1b1b26', flexShrink: 0, zIndex: 100,
  position: 'relative', fontFamily: FONT,
}
const backBtnStyle = {
  display: 'flex', alignItems: 'center', gap: 4,
  padding: '5px 11px', borderRadius: 8, border: '1px solid transparent',
  background: 'transparent', color: '#9aa2c2', cursor: 'pointer', fontSize: '0.82rem', fontWeight: 500,
}
const projectNameStyle = {
  fontSize: '0.9rem', color: '#e6e9f5', fontWeight: 600, letterSpacing: '0.01em',
  maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  cursor: 'pointer', fontFamily: FONT,
}
const projectRenameInputStyle = {
  fontSize: '0.88rem', color: '#fff', fontWeight: 500, fontFamily: FONT,
  background: '#14141f', border: '1px solid #5b6af0', borderRadius: 6,
  padding: '2px 8px', outline: 'none', width: 180,
}
// Segmented tab control
const segStyle = {
  display: 'flex', alignItems: 'center', gap: 2, padding: 3,
  background: '#14141d', border: '1px solid #21212e', borderRadius: 11,
}
const segTabStyle = {
  padding: '5px 13px', borderRadius: 8, border: 'none', background: 'transparent',
  color: '#7d84a4', cursor: 'pointer', fontSize: '0.82rem', fontWeight: 500, fontFamily: FONT,
  letterSpacing: '0.01em',
}
const segTabActiveStyle = {
  background: '#282c4a', color: '#f0f2ff', boxShadow: '0 1px 2px rgba(0,0,0,0.35), inset 0 0 0 1px rgba(120,130,220,0.25)',
}
const iconBtnStyle = {
  padding: '5px 11px', borderRadius: 8, border: '1px solid #21212e',
  background: 'transparent', color: '#8a92b4', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 500, fontFamily: FONT,
}
const iconBtnActiveStyle = { background: '#20233c', color: '#cbd3ff', borderColor: '#3a4270' }
const kbarStyle = {
  marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8,
  padding: '5px 10px 5px 12px', borderRadius: 8, border: '1px solid #21212e',
  background: '#12121b', color: '#8a92b4', cursor: 'pointer', fontSize: '0.8rem', fontFamily: FONT,
}
const kbdStyle = {
  fontSize: '0.68rem', color: '#9aa2c2', background: '#1c1c2a', border: '1px solid #2a2a3c',
  borderRadius: 5, padding: '1px 5px', fontWeight: 600, letterSpacing: '0.03em',
}
const shareBtnStyle = {
  padding: '5px 13px', borderRadius: 8, border: '1px solid #33407e',
  background: 'linear-gradient(#232a5c, #1b2048)', color: '#d3daff',
  cursor: 'pointer', fontSize: '0.8rem', fontWeight: 600, fontFamily: FONT,
}
const signOutStyle = {
  width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8,
  border: '1px solid #21212e', background: 'transparent', color: '#8a92b4',
  cursor: 'pointer', fontSize: '0.95rem',
}
const loadingStyle = {
  height: '100vh', display: 'flex', alignItems: 'center',
  justifyContent: 'center', color: '#8090b8', background: '#0f0f0f',
}
// Floating "← Back to <project>" chip, bottom-left of the canvas, shown while a link chain is active.
const backChipStyle = {
  position: 'absolute', left: 16, bottom: 16, zIndex: 40,
  display: 'flex', alignItems: 'center', gap: 6,
  padding: '8px 14px', borderRadius: 100,
  background: 'rgba(26,31,74,0.96)', border: '1px solid #3a4a8a', color: '#c5d0ff',
  cursor: 'pointer', fontSize: '0.82rem', fontWeight: 600,
  boxShadow: '0 8px 26px rgba(0,0,0,0.5)', maxWidth: 280,
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
}
