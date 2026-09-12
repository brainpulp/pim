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
import Strategy from './pages/Strategy'
import CommandPalette from './components/CommandPalette'
import SharedView from './pages/SharedView'
import ShareDialog from './components/ShareDialog'
import RemoteControl from './pages/RemoteControl'
import ViewManager from './components/ViewManager'

const parseShareToken = () => {
  const m = window.location.hash.match(/^#\/share\/([A-Za-z0-9]+)/)
  return m ? m[1] : null
}
const parseRemoteCode = () => {
  const m = window.location.hash.match(/^#\/remote\/([A-Za-z0-9]+)/)
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
    try { const v = localStorage.getItem('pim_last_view') || 'graph'; return v === 'write' ? 'graph' : v } catch { return 'graph' }
  })
  useEffect(() => { try { localStorage.setItem('pim_last_view', view) } catch { /* ignore */ } }, [view])
  // Docked outliner (the Writer as a resizable side panel beside the canvas), with selection synced.
  const [outlineDock, setOutlineDock] = useState(() => { try { return localStorage.getItem('pim_outline_dock') === '1' } catch { return false } })
  useEffect(() => { try { localStorage.setItem('pim_outline_dock', outlineDock ? '1' : '0') } catch { /* ignore */ } }, [outlineDock])
  // Maximize the docked outliner: slide the graph/outliner divider fully right so the outliner is the only visible panel.
  const [outlineMax, setOutlineMax] = useState(false)
  const [presenting, setPresenting] = useState(false)   // Graph is in presentation mode → hide all app chrome
  useEffect(() => { if (!outlineDock) setOutlineMax(false) }, [outlineDock])
  // "View" dropdown (next to the tabs) — one place to toggle the canvas panels: Outline / Draw / Slides / Views.
  const [viewMenuOpen, setViewMenuOpen] = useState(false)
  const [viewSub, setViewSub] = useState(null)   // inline submenu expanded in the View menu: 'views' | 'slides' | null
  const showDrawPanel = useGraphStore(s => s.showDraw)
  const showSlidesPanel = useGraphStore(s => s.showSlideSidebar)
  const showViewsPanel = useGraphStore(s => s.showViews)
  const hideFrames = useGraphStore(s => s.hideFrames)
  const storeViews = useGraphStore(s => s.views)
  const activeViewId = useGraphStore(s => s.activeViewId)
  const activeViewObj = storeViews?.find(v => v.id === activeViewId)
  const activeSlideshows = activeViewObj?.slideshows || []
  const activeSlideshowId = activeViewObj?.activeSlideshowId
  // Run a canvas-only view action (fit / present / fullscreen); switch to the graph canvas first if needed.
  const runGraphAction = (name) => {
    if (view !== 'graph') { setView('graph'); setTimeout(() => useGraphStore.getState().viewActions?.[name]?.(), 140) }
    else useGraphStore.getState().viewActions?.[name]?.()
  }
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
  const [remoteCode, setRemoteCode] = useState(() => parseRemoteCode())
  const [authOverShare, setAuthOverShare] = useState(false)   // user chose "sign in to edit" from a share link
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
    const onHash = () => { setShareToken(parseShareToken()); setRemoteCode(parseRemoteCode()) }
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
  const saveConflict = useGraphStore(s => s.saveConflict)
  const [conflictBusy, setConflictBusy] = useState(false)
  // Another device saved newer work while this tab had the project open. Rather than silently overwrite
  // (which lost work before), autosave is paused and the user chooses: take the latest, or force-push theirs.
  const resolveConflictReload = async () => {
    if (!project?.id) return
    setConflictBusy(true)
    try {
      const d = await loadProject(project.id)
      loadProjectData({ nodes: d.nodes, edges: d.edges, views: d.views, activeViewId: d.active_view_id, propertyDefs: d.property_defs, styles: d.styles, loadedProjectId: project.id, loadedUpdatedAt: d.updated_at })
    } catch (e) { console.error('Reload failed:', e) } finally { setConflictBusy(false) }
  }
  const resolveConflictOverwrite = async () => {
    if (!project?.id) return
    setConflictBusy(true)
    try {
      const s = useGraphStore.getState()
      useGraphStore.getState().setSaveConflict(false)   // clear first so the forced write isn't re-blocked
      const res = await saveProject(project.id, { nodes: s.nodes, edges: s.edges, views: s.views, activeViewId: s.activeViewId, propertyDefs: s.propertyDefs, styles: s.styles }, null)   // null = force unconditional
      useGraphStore.getState().setLoadedUpdatedAt(res.updatedAt)
      useGraphStore.getState().setSaveConflict(false)
    } catch (e) { console.error('Overwrite failed:', e) } finally { setConflictBusy(false) }
  }
  const [projectLoadErr, setProjectLoadErr] = useState(null)
  useEffect(() => {
    if (!project?.id || shareToken) return
    let cancelled = false
    setProjectLoadErr(null)
    if (useGraphStore.getState().loadedProjectId !== project.id) {
      loadProject(project.id)
        .then(async d => {
          if (cancelled) return
          loadProjectData({ nodes: d.nodes, edges: d.edges, views: d.views, activeViewId: d.active_view_id, propertyDefs: d.property_defs, styles: d.styles, loadedProjectId: project.id, loadedUpdatedAt: d.updated_at })
          // One-time compaction: offload any embedded base64 images to Storage so the project row
          // shrinks — this is what was making loads slow and oversized saves silently fail.
          try {
            const { views: v2, changed } = await compactProjectViews(project.id, d.views)
            if (changed && !cancelled && useGraphStore.getState().loadedProjectId === project.id) {
              const s = useGraphStore.getState()
              loadProjectData({ nodes: s.nodes, edges: s.edges, views: v2, activeViewId: s.activeViewId, propertyDefs: s.propertyDefs, styles: s.styles, loadedProjectId: project.id, loadedUpdatedAt: d.updated_at })
              const res = await saveProject(project.id, { nodes: s.nodes, edges: s.edges, views: v2, activeViewId: s.activeViewId, propertyDefs: s.propertyDefs, styles: s.styles }, d.updated_at)
              if (res?.conflict) useGraphStore.getState().setSaveConflict(true)
              else useGraphStore.getState().setLoadedUpdatedAt(res.updatedAt)
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

  // A `#/remote/<code>` link is the phone remote — pure Realtime broadcast, no sign-in, no project load.
  if (remoteCode) return <RemoteControl code={remoteCode} />

  // A `#/share/<token>` link is handled before the auth gate so view-only links
  // work with no sign-in. Wait for the session to resolve first (editor links redeem).
  if (shareToken) {
    if (session === undefined) return <div style={loadingStyle}>Loading…</div>
    // "Sign in to edit" from the share landing → show the normal auth screen but KEEP the token, so
    // once signed in we fall back into SharedView and (for an edit link) redeem into the editing flow.
    if (authOverShare && !session) return <Auth />
    return <SharedView token={shareToken} session={session}
      onSignIn={() => setAuthOverShare(true)}
      onOpenOwned={(id, name) => { window.location.hash = ''; setShareToken(null); setAuthOverShare(false); openProject(id, name) }} />
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
      {saveConflict && !presenting && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 100000, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          padding: '10px 16px', background: '#3a1e10', borderBottom: '1px solid #7a4a22', color: '#ffd9b0', fontSize: '0.86rem',
          fontFamily: '-apple-system, sans-serif', boxShadow: '0 6px 24px rgba(0,0,0,0.5)' }}>
          <span style={{ fontSize: '1.1rem' }}>⚠️</span>
          <span style={{ flex: 1, minWidth: 220, color: '#ffe6cc' }}>
            <b>This project was changed on another device.</b> Your edits here haven't been saved — to avoid overwriting the newer version, pick one:
          </span>
          <button disabled={conflictBusy} onClick={resolveConflictReload}
            style={{ background: '#1f6f43', border: '1px solid #2f9a5f', color: '#eafff2', borderRadius: 8, padding: '7px 12px', cursor: 'pointer', fontWeight: 700, fontSize: '0.82rem' }}>
            ↻ Load the latest (discard my recent edits)</button>
          <button disabled={conflictBusy} onClick={resolveConflictOverwrite}
            style={{ background: '#5a2a2a', border: '1px solid #8a3a3a', color: '#ffd9d9', borderRadius: 8, padding: '7px 12px', cursor: 'pointer', fontWeight: 700, fontSize: '0.82rem' }}>
            ⇪ Keep mine (overwrite the other device)</button>
        </div>
      )}
      {!presenting && <nav style={navStyle}>
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
          {[['graph', 'Graph'], ['board', 'Grouping'], ['strategy', 'Strategy'], ['table', 'Table'], ['lab', 'Lab']].map(([v, label]) => (
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
          <div style={{ position: 'relative' }}>
            <button title="Show / hide the canvas panels"
              className="pim-nav-btn"
              style={{ ...iconBtnStyle, ...(viewMenuOpen || outlineDock || (view === 'graph' && (showDrawPanel || showSlidesPanel || showViewsPanel)) ? iconBtnActiveStyle : {}) }}
              onClick={() => setViewMenuOpen(o => !o)}>View ▾</button>
            {viewMenuOpen && (
              <>
                <div onClick={() => setViewMenuOpen(false)}
                  style={{ position: 'fixed', inset: 0, zIndex: 200 }} />
                <div style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 201, minWidth: 200, maxHeight: '78vh', overflowY: 'auto',
                  background: '#14141f', border: '1px solid #2a2a3c', borderRadius: 10, padding: 5,
                  boxShadow: '0 16px 44px rgba(0,0,0,0.55)' }}>
                  {(() => {
                    const st = () => useGraphStore.getState()
                    const rowStyle = (on) => ({ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
                      padding: '7px 10px', borderRadius: 7, border: 'none', cursor: 'pointer', fontSize: '0.82rem', boxSizing: 'border-box',
                      fontFamily: FONT, background: on ? '#20233c' : 'transparent', color: on ? '#cbd3ff' : '#a9b0d0' })
                    const head = (t) => <div style={{ padding: '7px 10px 3px', fontSize: '0.6rem', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#6f78a0', fontWeight: 700 }}>{t}</div>
                    const divider = <div style={{ borderTop: '1px solid #23233a', margin: '4px 4px' }} />
                    // A plain action/toggle row. `on` shows the ✓ column; leave undefined for a plain action.
                    const Row = ({ label, icon, on, close = true, onRun }) => (
                      <button className="pim-nav-tab" onClick={() => { onRun(); if (close) setViewMenuOpen(false) }} style={rowStyle(!!on)}>
                        <span style={{ width: 14, display: 'inline-block', color: '#7c8cff' }}>{on ? '✓' : (icon || '')}</span>
                        <span style={{ flex: 1 }}>{label}</span>
                      </button>
                    )
                    return (
                      <>
                        {head('Panels')}
                        <Row label="Outliner" on={outlineDock} onRun={() => setOutlineDock(o => !o)} />
                        <Row label="Draw" on={view === 'graph' && showDrawPanel} onRun={() => { if (view !== 'graph') setView('graph'); st().setShowDraw(v => !v); st().setShowSlideSidebar(false) }} />
                        <Row label="Slides panel" on={view === 'graph' && showSlidesPanel} onRun={() => { if (view !== 'graph') setView('graph'); st().setShowSlideSidebar(v => !v); st().setShowDraw(false) }} />
                        <Row label="Views panel" on={view === 'graph' && showViewsPanel} onRun={() => { if (view !== 'graph') setView('graph'); st().setShowViews(v => !v) }} />

                        {divider}
                        {head('Display')}
                        <Row label={hideFrames ? 'Frames: hidden' : 'Frames: shown'} icon="▢" on={!hideFrames}
                          onRun={() => { if (view !== 'graph') setView('graph'); st().setHideFrames(v => !v) }} close={false} />
                        <Row label="Fit to screen" icon="⊡" onRun={() => runGraphAction('fit')} />
                        <Row label="Fullscreen" icon="⛶" onRun={() => runGraphAction('toggleFullscreen')} />

                        {divider}
                        <Row label="Present" icon="▶" onRun={() => runGraphAction('present')} />

                        {divider}
                        {/* Views submenu — quick switch / manage, inline */}
                        <button className="pim-nav-tab" onClick={() => setViewSub(s => s === 'views' ? null : 'views')} style={rowStyle(viewSub === 'views')}>
                          <span style={{ width: 14, display: 'inline-block', color: '#7c8cff' }}>🗂</span>
                          <span style={{ flex: 1 }}>Views</span>
                          <span style={{ color: '#7080a0' }}>{viewSub === 'views' ? '▾' : '▸'}</span>
                        </button>
                        {viewSub === 'views' && (
                          <div style={{ margin: '2px 4px 4px', border: '1px solid #23233a', borderRadius: 8, overflow: 'hidden', maxHeight: 240, overflowY: 'auto' }}>
                            <ViewManager />
                          </div>
                        )}

                        {/* Slideshows submenu — switch the active slideshow, or open the Slides panel */}
                        <button className="pim-nav-tab" onClick={() => setViewSub(s => s === 'slides' ? null : 'slides')} style={rowStyle(viewSub === 'slides')}>
                          <span style={{ width: 14, display: 'inline-block', color: '#7c8cff' }}>🎞️</span>
                          <span style={{ flex: 1 }}>Slideshows{activeSlideshows.length ? ` (${activeSlideshows.length})` : ''}</span>
                          <span style={{ color: '#7080a0' }}>{viewSub === 'slides' ? '▾' : '▸'}</span>
                        </button>
                        {viewSub === 'slides' && (
                          <div style={{ margin: '2px 4px 4px', border: '1px solid #23233a', borderRadius: 8, padding: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
                            {activeSlideshows.length === 0 && <div style={{ color: '#7080a0', fontSize: '0.75rem', padding: '5px 8px' }}>No slideshows yet.</div>}
                            {activeSlideshows.map(ss => (
                              <button key={ss.id} className="pim-nav-tab"
                                onClick={() => { st().setActiveSlideshowId(ss.id); if (view !== 'graph') setView('graph'); st().setShowSlideSidebar(true); st().setShowDraw(false); setViewMenuOpen(false) }}
                                style={{ ...rowStyle(ss.id === activeSlideshowId), padding: '6px 9px' }}>
                                <span style={{ width: 12, display: 'inline-block', color: '#7c8cff' }}>{ss.id === activeSlideshowId ? '●' : '○'}</span>
                                <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{ss.name || 'Slideshow'}</span>
                                <span style={{ color: '#7080a0', fontSize: '0.68rem' }}>{(ss.slides || []).length}</span>
                              </button>
                            ))}
                            <button className="pim-nav-tab"
                              onClick={() => { if (view !== 'graph') setView('graph'); st().addSlideshow?.('New Slideshow'); st().setShowSlideSidebar(true); st().setShowDraw(false); setViewMenuOpen(false) }}
                              style={{ ...rowStyle(false), padding: '6px 9px', color: '#8ea2ff' }}>
                              <span style={{ width: 12, display: 'inline-block' }}>＋</span><span style={{ flex: 1 }}>New slideshow</span>
                            </button>
                          </div>
                        )}
                      </>
                    )
                  })()}
                </div>
              </>
            )}
          </div>
        )}
        <button className="pim-nav-btn" style={kbarStyle} onClick={() => setPaletteOpen(true)} title="Quick jump / commands">
          <span style={{ opacity: 0.7 }}>Search</span>
          <span style={kbdStyle}>⌘K</span>
        </button>
        <button className="pim-nav-btn" style={shareBtnStyle} onClick={() => setShowShare(true)} title="Share this project">
          Share
        </button>
        <button className="pim-nav-btn" style={signOutStyle} onClick={() => supabase.auth.signOut()} title="Sign out">⏻</button>
      </nav>}
      {showShare && (
        <ShareDialog projectId={project.id} projectName={project.name} tab={view} onClose={() => setShowShare(false)} />
      )}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        nodes={paletteNodes}
        onJump={(id) => { useGraphStore.getState().setSelectedNodeId(id); if (!outlineDock && (view === 'board' || view === 'graph')) setOutlineDock(true) }}
        actions={[
          { label: 'Go to Canvas', hint: 'view', run: () => setView('board') },
          { label: 'Go to Graph', hint: 'view', run: () => setView('graph') },
          { label: 'Go to Table', hint: 'view', run: () => setView('table') },
          { label: outlineDock ? 'Hide outliner panel' : 'Show outliner panel', hint: 'toggle', run: () => { if (view !== 'board' && view !== 'graph') setView('board'); setOutlineDock(o => !o) } },
          { label: 'New item (in outliner)', hint: 'create', run: () => { const id = useGraphStore.getState().addNode('', null); useGraphStore.getState().setSelectedNodeId(id); if (view !== 'board' && view !== 'graph') setView('board'); setOutlineDock(true) } },
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
        {/* Outliner docks on the LEFT, beside the canvas. Maximized → it takes the full width and the
            graph/resize-handle are hidden (the divider is slid all the way to the right). */}
        {outlineDock && (view === 'board' || view === 'graph') && (
          <>
            <div style={{ width: outlineMax ? '100%' : outlineW, flexShrink: 0, height: '100%', overflow: 'hidden' }}>
              <AppErrorBoundary><Writer key={'dock-' + project.id} projectName={project.name} embedded maximized={outlineMax} onExpand={() => setOutlineMax(m => !m)} onClose={() => setOutlineDock(false)} /></AppErrorBoundary>
            </div>
            {!outlineMax && (
              <div onMouseDown={startDockResize} title="Drag to resize"
                style={{ width: 6, flexShrink: 0, cursor: 'col-resize', background: '#15151f', borderRight: '1px solid #24243a' }} />
            )}
          </>
        )}
        <div style={{ flex: 1, minWidth: 0, height: '100%', position: 'relative', display: outlineMax && (view === 'board' || view === 'graph') ? 'none' : 'block' }}>
          {view === 'graph' && (
            <AppErrorBoundary>
            <Graph
              key={project.id}
              projectId={project.id}
              projectName={project.name}
              onBack={() => setProject(null)}
              onPresentingChange={setPresenting}
            />
            </AppErrorBoundary>
          )}
          {view === 'table' && <Table key={project.id} projectId={project.id} />}
          {view === 'strategy' && <AppErrorBoundary><Strategy key={project.id} projectId={project.id} /></AppErrorBoundary>}
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
