with open(r'F:\code\pim\src\pages\Graph.jsx', 'rb') as f:
    src = f.read()

changes = []

# ── 1. handleEmojiDragStart + handleRemoveEmoji in Graph (after handleRelease) ──
old = b"  const handleRelease = useCallback((nodeId) => {\r\n    releaseAnchor(nodeId)\r\n    const s = simNodesRef.current.find(n => n.id === nodeId)\r\n    if (s) { s.fx = null; s.fy = null }\r\n    simRef.current?.alpha(0.3).restart()\r\n  }, [releaseAnchor])"
new = (b"  const handleRelease = useCallback((nodeId) => {\r\n    releaseAnchor(nodeId)\r\n    const s = simNodesRef.current.find(n => n.id === nodeId)\r\n    if (s) { s.fx = null; s.fy = null }\r\n    simRef.current?.alpha(0.3).restart()\r\n  }, [releaseAnchor])\r\n\r\n  const handleEmojiDragStart = useCallback((e, nodeId, emojiId) => {\r\n    e.stopPropagation(); e.preventDefault()\r\n    const node = simNodesRef.current.find(n => n.id === nodeId)\r\n    if (!node) return\r\n    const onMove = me => {\r\n      const [sx, sy] = clientToSim(me.clientX, me.clientY)\r\n      const angle = Math.atan2(sy - (node.y || 0), sx - (node.x || 0))\r\n      const { views, activeViewId } = useGraphStore.getState()\r\n      const vp = views.find(v => v.id === activeViewId)?.nodeProps?.[nodeId] || {}\r\n      setNodeViewProp(nodeId, 'nodeEmojis', (vp.nodeEmojis || []).map(em => em.id === emojiId ? { ...em, angle } : em))\r\n    }\r\n    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }\r\n    document.addEventListener('mousemove', onMove)\r\n    document.addEventListener('mouseup', onUp)\r\n  }, [clientToSim, setNodeViewProp])\r\n\r\n  const handleRemoveEmoji = useCallback((nodeId, emojiId) => {\r\n    const { views, activeViewId } = useGraphStore.getState()\r\n    const vp = views.find(v => v.id === activeViewId)?.nodeProps?.[nodeId] || {}\r\n    setNodeViewProp(nodeId, 'nodeEmojis', (vp.nodeEmojis || []).filter(em => em.id !== emojiId))\r\n  }, [setNodeViewProp])")
n = src.count(old); print(f'1 handlers: {n}'); assert n == 1
src = src.replace(old, new)
changes.append('1. emoji drag+remove handlers')

# ── 2. Pass emoji handlers to NodeShape ──
old = (b'                onShowNotePopup={id => setNotePopupId(prev => prev === id ? null : id)}\r\n'
       b'                onMouseEnter={() => showToolbar(n.id)}\r\n'
       b'                onMouseLeave={hideToolbar}')
new = (b'                onShowNotePopup={id => setNotePopupId(prev => prev === id ? null : id)}\r\n'
       b'                onEmojiDragStart={handleEmojiDragStart}\r\n'
       b'                onRemoveEmoji={handleRemoveEmoji}\r\n'
       b'                onMouseEnter={() => showToolbar(n.id)}\r\n'
       b'                onMouseLeave={hideToolbar}')
n = src.count(old); print(f'2 NodeShape props: {n}'); assert n == 1
src = src.replace(old, new)
changes.append('2. NodeShape emoji props')

# ── 3. Pass emoji handlers to NodeToolbar ──
old = (b'              onSetMotion={m => setNodeViewProp(hn.id, \'nodeMotion\', m)}\r\n'
       b'              onSetColorCycle={spd => setNodeViewProp(hn.id, \'nodeColorCycle\', spd)}')
new = (b'              onSetMotion={m => setNodeViewProp(hn.id, \'nodeMotion\', m)}\r\n'
       b'              onSetColorCycle={spd => setNodeViewProp(hn.id, \'nodeColorCycle\', spd)}\r\n'
       b'              onAddEmoji={em => { const cur = getVP(hn.id).nodeEmojis || []; setNodeViewProp(hn.id, \'nodeEmojis\', [...cur, { id: crypto.randomUUID(), emoji: em, angle: -Math.PI / 4 }]) }}\r\n'
       b'              onRemoveEmojiById={eid => handleRemoveEmoji(hn.id, eid)}')
n = src.count(old); print(f'3 toolbar emoji props: {n}'); assert n == 1
src = src.replace(old, new)
changes.append('3. toolbar emoji props')

# ── 4. NodeShape: add emoji props to signature ──
old = b'function NodeShape({ node, viewProps, isSelected, isHovered, isDropTarget, autoEdit, onAutoEditDone, keepEdit, onKeepEditDone, onMouseDown, onConnectorMouseDown, onScaleMouseDown, onDelete, onLabelChange, onTab, onCreateSister, onShowNotePopup, onMouseEnter, onMouseLeave, modelThumb }) {'
new = b'function NodeShape({ node, viewProps, isSelected, isHovered, isDropTarget, autoEdit, onAutoEditDone, keepEdit, onKeepEditDone, onMouseDown, onConnectorMouseDown, onScaleMouseDown, onDelete, onLabelChange, onTab, onCreateSister, onShowNotePopup, onEmojiDragStart, onRemoveEmoji, onMouseEnter, onMouseLeave, modelThumb }) {'
n = src.count(old); print(f'4 NodeShape sig: {n}'); assert n == 1
src = src.replace(old, new)
changes.append('4. NodeShape sig')

# ── 5. Render emoji badges in NodeShape (after </AnimatedG>, before edit input) ──
old = b'      {/* Edit input \xe2\x80\x94 for 3D nodes render at caption position below box (inside box is covered by 3D div) */}'
new = (b'      {/* Emoji badges \xe2\x80\x94 outside AnimatedG so they stay fixed while node wiggles */}\r\n'
       b'      {(viewProps.nodeEmojis || []).map(em => {\r\n'
       b'        const ex = Math.cos(em.angle) * halfW\r\n'
       b'        const ey = Math.sin(em.angle) * halfH\r\n'
       b'        return (\r\n'
       b'          <g key={em.id} transform={`translate(${ex.toFixed(1)},${ey.toFixed(1)})`}>\r\n'
       b'            <circle r={13} fill="#16162a" fillOpacity={0.82} stroke={isSelected ? \'#5b6af0\' : \'rgba(255,255,255,0.12)\'} strokeWidth={1} />\r\n'
       b'            <text textAnchor="middle" dominantBaseline="central" fontSize={15} style={{ userSelect:\'none\', pointerEvents:\'none\' }}>{em.emoji}</text>\r\n'
       b'            {(isSelected || isHovered) && (\r\n'
       b'              <circle r={13} fill="transparent"\r\n'
       b'                onMouseDown={e => { e.stopPropagation(); onEmojiDragStart?.(e, node.id, em.id) }}\r\n'
       b'                style={{ cursor: \'grab\' }} />\r\n'
       b'            )}\r\n'
       b'            {isSelected && (\r\n'
       b'              <g transform="translate(9,-9)" onClick={e => { e.stopPropagation(); onRemoveEmoji?.(node.id, em.id) }} style={{ cursor:\'pointer\' }}>\r\n'
       b'                <circle r={5.5} fill="#f87171" />\r\n'
       b'                <text textAnchor="middle" dominantBaseline="central" fontSize={8} fill="#fff" style={{ userSelect:\'none\', pointerEvents:\'none\' }}>\xc3\x97</text>\r\n'
       b'              </g>\r\n'
       b'            )}\r\n'
       b'          </g>\r\n'
       b'        )\r\n'
       b'      })}\r\n\r\n'
       b'      {/* Edit input \xe2\x80\x94 for 3D nodes render at caption position below box (inside box is covered by 3D div) */}')
n = src.count(old); print(f'5 emoji render: {n}'); assert n == 1
src = src.replace(old, new)
changes.append('5. emoji render in NodeShape')

# ── 6. NodeToolbar signature: add onAddEmoji + onRemoveEmojiById ──
old = b'function NodeToolbar({ x, y, viewProps, notes, onSetFill, onSetTextColor, onSetStrokeColor, onSetStrokeWidth, onSetBorderBlur, onSetOpacity, onSetShape, onDrill, onHide, onRelease, onDelete, onNotesChange, isAnchored, onRadiate, onSetMotion, onSetColorCycle, onMouseEnter, onMouseLeave, onWheel }) {'
new = b'function NodeToolbar({ x, y, viewProps, notes, onSetFill, onSetTextColor, onSetStrokeColor, onSetStrokeWidth, onSetBorderBlur, onSetOpacity, onSetShape, onDrill, onHide, onRelease, onDelete, onNotesChange, isAnchored, onRadiate, onSetMotion, onSetColorCycle, onAddEmoji, onRemoveEmojiById, onMouseEnter, onMouseLeave, onWheel }) {'
n = src.count(old); print(f'6 toolbar sig: {n}'); assert n == 1
src = src.replace(old, new)
changes.append('6. toolbar sig')

# ── 7. Add emoji state + button to NodeToolbar ──
old = b"  const [panel, setPanel] = useState(null) // null | 'color' | 'shape' | 'note' | 'radiate' | 'motion'\r\n  const [notesDraft, setNotesDraft] = useState(notes)\r\n  const [colorPopup, setColorPopup] = useState(null) // 'fill' | 'text' | null"
new = b"  const [panel, setPanel] = useState(null) // null | 'color' | 'shape' | 'note' | 'radiate' | 'motion' | 'emoji'\r\n  const [notesDraft, setNotesDraft] = useState(notes)\r\n  const [colorPopup, setColorPopup] = useState(null) // 'fill' | 'text' | null\r\n  const [emojiInput, setEmojiInput] = useState('')"
n = src.count(old); print(f'7 toolbar state: {n}'); assert n == 1
src = src.replace(old, new)
changes.append('7. toolbar state')

# ── 8. Add emoji button to main icon row (before delete) ──
old = b"          <button style={{ ...iconBtn(false), color:'#f87171' }} title=\"Delete\" onClick={onDelete}>\xe2\x9c\x95</button>"
new = (b"          <button style={iconBtn(panel === 'emoji')} title=\"Emoji\" onClick={() => setPanel(panel === 'emoji' ? null : 'emoji')}>\xf0\x9f\x98\x8a</button>\r\n"
       b"          <button style={{ ...iconBtn(false), color:'#f87171' }} title=\"Delete\" onClick={onDelete}>\xe2\x9c\x95</button>")
n = src.count(old); print(f'8 emoji button: {n}'); assert n == 1
src = src.replace(old, new)
changes.append('8. emoji toolbar button')

# ── 9. Add emoji panel (after motion panel closing })()) ──
old = b"      {/* \xe2\x80\x94\xe2\x80\x94 Radiate panel \xe2\x80\x94\xe2\x80\x94 */}"
new = (b"      {/* \xe2\x80\x94\xe2\x80\x94 Emoji panel \xe2\x80\x94\xe2\x80\x94 */}\r\n"
       b"      {panel === 'emoji' && (() => {\r\n"
       b"        const QUICK = ['\xe2\xad\x90','\xf0\x9f\x94\xa5','\xe2\x9c\x85','\xe2\x9d\x8c','\xe2\x9a\xa0\xef\xb8\x8f','\xf0\x9f\x92\xa1','\xf0\x9f\x8e\xaf','\xf0\x9f\x93\x8c','\xf0\x9f\x9a\x80','\xe2\x9d\xa4\xef\xb8\x8f','\xf0\x9f\x91\x8d','\xf0\x9f\x92\xac','\xf0\x9f\x8f\xb7\xef\xb8\x8f','\xe2\x9a\xa1','\xf0\x9f\x8c\x9f','\xf0\x9f\x92\x8e','\xf0\x9f\x94\xb4','\xf0\x9f\x9f\xa1','\xf0\x9f\x9f\xa2','\xf0\x9f\x94\xb5']\r\n"
       b"        const curEmojis = viewProps.nodeEmojis || []\r\n"
       b"        return (\r\n"
       b"          <div style={{ display:'flex', flexDirection:'column', gap:6, minWidth:204 }}>\r\n"
       b"            <div style={{ display:'flex', alignItems:'center', gap:4 }}>\r\n"
       b"              <button style={backBtn} onClick={() => setPanel(null)}>\xe2\x80\xb9</button>\r\n"
       b"              <span style={{ fontSize:'0.72rem', color:'#7080a0', letterSpacing:'0.06em' }}>EMOJI</span>\r\n"
       b"            </div>\r\n"
       b"            <div style={{ display:'flex', flexWrap:'wrap', gap:3 }}>\r\n"
       b"              {QUICK.map(em => (\r\n"
       b"                <button key={em} onClick={() => onAddEmoji?.(em)} title={em}\r\n"
       b"                  style={{ background:'transparent', border:'1px solid #2a3358', borderRadius:4, cursor:'pointer', fontSize:'1.1rem', padding:'3px 5px', lineHeight:1 }}>{em}</button>\r\n"
       b"              ))}\r\n"
       b"            </div>\r\n"
       b"            <div style={{ display:'flex', gap:4 }}>\r\n"
       b"              <input value={emojiInput} onChange={e => setEmojiInput(e.target.value)}\r\n"
       b"                placeholder=\"Custom emoji\xe2\x80\xa6\" maxLength={8}\r\n"
       b"                style={{ flex:1, background:'#0e0e1c', border:'1px solid #2d3a6a', color:'#fff', borderRadius:4, padding:'3px 6px', fontSize:'0.9rem', outline:'none', fontFamily:'inherit' }} />\r\n"
       b"              <button onClick={() => { if (emojiInput.trim()) { onAddEmoji?.(emojiInput.trim()); setEmojiInput('') } }}\r\n"
       b"                style={{ background:'#2d3a6a', border:'none', color:'#fff', borderRadius:4, cursor:'pointer', padding:'3px 10px', fontSize:'0.8rem' }}>+</button>\r\n"
       b"            </div>\r\n"
       b"            {curEmojis.length > 0 && (\r\n"
       b"              <div style={{ display:'flex', flexWrap:'wrap', gap:5, borderTop:'1px solid #2a3358', paddingTop:5 }}>\r\n"
       b"                {curEmojis.map(em => (\r\n"
       b"                  <div key={em.id} style={{ position:'relative', display:'inline-flex', alignItems:'center', justifyContent:'center', width:28, height:28 }}>\r\n"
       b"                    <span style={{ fontSize:'1.2rem', lineHeight:1 }}>{em.emoji}</span>\r\n"
       b"                    <button onClick={() => onRemoveEmojiById?.(em.id)}\r\n"
       b"                      style={{ position:'absolute', top:-4, right:-4, background:'#f87171', border:'none', borderRadius:'50%', width:13, height:13, cursor:'pointer', fontSize:9, color:'#fff', display:'flex', alignItems:'center', justifyContent:'center', padding:0, lineHeight:1 }}>\xc3\x97</button>\r\n"
       b"                  </div>\r\n"
       b"                ))}\r\n"
       b"              </div>\r\n"
       b"            )}\r\n"
       b"          </div>\r\n"
       b"        )\r\n"
       b"      })()}\r\n\r\n"
       b"      {/* \xe2\x80\x94\xe2\x80\x94 Radiate panel \xe2\x80\x94\xe2\x80\x94 */}")
n = src.count(old); print(f'9 emoji panel: {n}'); assert n == 1
src = src.replace(old, new)
changes.append('9. emoji panel UI')

with open(r'F:\code\pim\src\pages\Graph.jsx', 'wb') as f:
    f.write(src)

print('\nAll done:', changes)
