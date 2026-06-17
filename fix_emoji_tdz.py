with open(r'F:\code\pim\src\pages\Graph.jsx', 'rb') as f:
    src = f.read()

errors = []

# ── 1. NodeShape signature: add onEmojiDragStart, onRemoveEmoji ──
old = b'function NodeShape({ node, viewProps, isSelected, isHovered, isDropTarget, autoEdit, onAutoEditDone, keepEdit, onKeepEditDone, onMouseDown, onConnectorMouseDown, onScaleMouseDown, onDelete, onLabelChange, onTab, onCreateSister, onShowNotePopup, onMouseEnter, onMouseLeave, modelThumb })'
new = b'function NodeShape({ node, viewProps, isSelected, isHovered, isDropTarget, autoEdit, onAutoEditDone, keepEdit, onKeepEditDone, onMouseDown, onConnectorMouseDown, onScaleMouseDown, onDelete, onLabelChange, onTab, onCreateSister, onShowNotePopup, onEmojiDragStart, onRemoveEmoji, onMouseEnter, onMouseLeave, modelThumb })'
assert src.count(old) == 1, f'Step 1 anchor not found (count={src.count(old)})'
src = src.replace(old, new)
print('1 NodeShape signature: done')

# ── 2. NodeToolbar signature: add onAddEmoji, onRemoveEmojiById ──
old = b'function NodeToolbar({ x, y, viewProps, notes, onSetFill, onSetTextColor, onSetStrokeColor, onSetStrokeWidth, onSetBorderBlur, onSetOpacity, onSetShape, onDrill, onHide, onRelease, onDelete, onNotesChange, isAnchored, onRadiate, onSetMotion, onSetColorCycle, onMouseEnter, onMouseLeave, onWheel })'
new = b'function NodeToolbar({ x, y, viewProps, notes, onSetFill, onSetTextColor, onSetStrokeColor, onSetStrokeWidth, onSetBorderBlur, onSetOpacity, onSetShape, onDrill, onHide, onRelease, onDelete, onNotesChange, isAnchored, onRadiate, onSetMotion, onSetColorCycle, onAddEmoji, onRemoveEmojiById, onMouseEnter, onMouseLeave, onWheel })'
assert src.count(old) == 1, f'Step 2 anchor not found'
src = src.replace(old, new)
print('2 NodeToolbar signature: done')

# ── 3. NodeToolbar panel state: add 'emoji' to comment + declare emojiInput ──
old = b"  const [panel, setPanel] = useState(null) // null | 'color' | 'shape' | 'note' | 'radiate' | 'motion'\r\n  const [notesDraft, setNotesDraft] = useState(notes)"
new = b"  const [panel, setPanel] = useState(null) // null | 'color' | 'shape' | 'note' | 'radiate' | 'motion' | 'emoji'\r\n  const [notesDraft, setNotesDraft] = useState(notes)\r\n  const [emojiInput, setEmojiInput] = useState('')"
assert src.count(old) == 1, f'Step 3 anchor not found'
src = src.replace(old, new)
print('3 emojiInput state: done')

# ── 4. Icon row: add emoji button before delete ──
old = (b"          {divider}\r\n"
       b"          <button style={{ ...iconBtn(false), color:'#f87171' }} title=\"Delete\" onClick={onDelete}>\xe2\x9c\x95</button>")
new = (b"          <button style={iconBtn(panel === 'emoji')} title=\"Emoji\" onClick={() => setPanel(panel === 'emoji' ? null : 'emoji')}>\xf0\x9f\x98\x8a</button>\r\n"
       b"          {divider}\r\n"
       b"          <button style={{ ...iconBtn(false), color:'#f87171' }} title=\"Delete\" onClick={onDelete}>\xe2\x9c\x95</button>")
assert src.count(old) == 1, f'Step 4 anchor not found'
src = src.replace(old, new)
print('4 emoji button in icon row: done')

# ── 5. NodeShape call site: add onEmojiDragStart + onRemoveEmoji ──
old = (b"                onShowNotePopup={id => setNotePopupId(prev => prev === id ? null : id)}\r\n"
       b"                onMouseEnter={() => showToolbar(n.id)}\r\n"
       b"                onMouseLeave={hideToolbar}")
new = (b"                onShowNotePopup={id => setNotePopupId(prev => prev === id ? null : id)}\r\n"
       b"                onEmojiDragStart={handleEmojiDragStart}\r\n"
       b"                onRemoveEmoji={handleRemoveEmoji}\r\n"
       b"                onMouseEnter={() => showToolbar(n.id)}\r\n"
       b"                onMouseLeave={hideToolbar}")
assert src.count(old) == 1, f'Step 5 anchor not found'
src = src.replace(old, new)
print('5 NodeShape call site: done')

# ── 6. NodeToolbar call site: add onAddEmoji + onRemoveEmojiById ──
old = (b"              onSetColorCycle={spd => setNodeViewProp(hn.id, 'nodeColorCycle', spd)}\r\n"
       b"              onMouseEnter={() => showToolbar(hn.id)}")
new = (b"              onSetColorCycle={spd => setNodeViewProp(hn.id, 'nodeColorCycle', spd)}\r\n"
       b"              onAddEmoji={em => { const cur = (views.find(v => v.id === activeViewId)?.nodeProps?.[hn.id]?.nodeEmojis) || []; setNodeViewProp(hn.id, 'nodeEmojis', [...cur, { id: crypto.randomUUID(), emoji: em, angle: -Math.PI / 4 }]) }}\r\n"
       b"              onRemoveEmojiById={eid => handleRemoveEmoji(hn.id, eid)}\r\n"
       b"              onMouseEnter={() => showToolbar(hn.id)}")
assert src.count(old) == 1, f'Step 6 anchor not found'
src = src.replace(old, new)
print('6 NodeToolbar call site: done')

# ── 7. Add handleEmojiDragStart + handleRemoveEmoji after handleRelease ──
old = b'  const handleReleaseAll = useCallback(() => {'
new = (b"  const handleEmojiDragStart = useCallback((e, nodeId, emojiId) => {\r\n"
       b"    e.stopPropagation(); e.preventDefault()\r\n"
       b"    const node = simNodesRef.current.find(n => n.id === nodeId)\r\n"
       b"    if (!node) return\r\n"
       b"    const onMove = me => {\r\n"
       b"      const [sx, sy] = clientToSim(me.clientX, me.clientY)\r\n"
       b"      const angle = Math.atan2(sy - (node.y || 0), sx - (node.x || 0))\r\n"
       b"      const { views: vs, activeViewId: av } = useGraphStore.getState()\r\n"
       b"      const vp = vs.find(v => v.id === av)?.nodeProps?.[nodeId] || {}\r\n"
       b"      setNodeViewProp(nodeId, 'nodeEmojis', (vp.nodeEmojis || []).map(em => em.id === emojiId ? { ...em, angle } : em))\r\n"
       b"    }\r\n"
       b"    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }\r\n"
       b"    document.addEventListener('mousemove', onMove)\r\n"
       b"    document.addEventListener('mouseup', onUp)\r\n"
       b"  }, [clientToSim, setNodeViewProp])\r\n"
       b"\r\n"
       b"  const handleRemoveEmoji = useCallback((nodeId, emojiId) => {\r\n"
       b"    const { views: vs, activeViewId: av } = useGraphStore.getState()\r\n"
       b"    const vp = vs.find(v => v.id === av)?.nodeProps?.[nodeId] || {}\r\n"
       b"    setNodeViewProp(nodeId, 'nodeEmojis', (vp.nodeEmojis || []).filter(em => em.id !== emojiId))\r\n"
       b"  }, [setNodeViewProp])\r\n"
       b"\r\n"
       b"  const handleReleaseAll = useCallback(() => {")
assert src.count(old) == 1, f'Step 7 anchor not found'
src = src.replace(old, new)
print('7 handleEmojiDragStart + handleRemoveEmoji: done')

# ── 8. Emoji badge rendering after </AnimatedG> ──
old = b"</AnimatedG>\r\n\r\n      {/* Edit input"
new = (b"</AnimatedG>\r\n\r\n"
       b"      {/* Emoji badges \xe2\x80\x94 outside AnimatedG so they stay fixed while node wiggles */}\r\n"
       b"      {(viewProps.nodeEmojis || []).map(em => {\r\n"
       b"        const ex = Math.cos(em.angle) * halfW\r\n"
       b"        const ey = Math.sin(em.angle) * halfH\r\n"
       b"        return (\r\n"
       b"          <g key={em.id} transform={`translate(${ex.toFixed(1)},${ey.toFixed(1)})`}>\r\n"
       b"            <circle r={13} fill=\"#16162a\" fillOpacity={0.82} stroke={isSelected ? '#5b6af0' : 'rgba(255,255,255,0.12)'} strokeWidth={1} />\r\n"
       b"            <text textAnchor=\"middle\" dominantBaseline=\"central\" fontSize={15} style={{ userSelect:'none', pointerEvents:'none' }}>{em.emoji}</text>\r\n"
       b"            {(isSelected || isHovered) && (\r\n"
       b"              <circle r={13} fill=\"transparent\"\r\n"
       b"                onMouseDown={e => { e.stopPropagation(); onEmojiDragStart?.(e, node.id, em.id) }}\r\n"
       b"                style={{ cursor: 'grab' }} />\r\n"
       b"            )}\r\n"
       b"            {isSelected && (\r\n"
       b"              <g transform=\"translate(9,-9)\" onClick={e => { e.stopPropagation(); onRemoveEmoji?.(node.id, em.id) }} style={{ cursor:'pointer' }}>\r\n"
       b"                <circle r={5.5} fill=\"#f87171\" />\r\n"
       b"                <text textAnchor=\"middle\" dominantBaseline=\"central\" fontSize={8} fill=\"#fff\" style={{ userSelect:'none', pointerEvents:'none' }}>\xc3\x97</text>\r\n"
       b"              </g>\r\n"
       b"            )}\r\n"
       b"          </g>\r\n"
       b"        )\r\n"
       b"      })}\r\n\r\n"
       b"      {/* Edit input")
assert src.count(old) == 1, f'Step 8 anchor not found'
src = src.replace(old, new)
print('8 emoji badge rendering: done')

with open(r'F:\code\pim\src\pages\Graph.jsx', 'wb') as f:
    f.write(src)
print('Written.')
