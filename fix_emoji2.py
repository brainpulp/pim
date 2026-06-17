with open(r'F:\code\pim\src\pages\Graph.jsx', 'rb') as f:
    src = f.read()

EM = b'\xc3\xa2"\xe2\x82\xac'
old_anchor = b'      {/* ' + EM + EM + b' Radiate panel ' + EM + EM + b' */}'
print('anchor found:', src.count(old_anchor))

QUICK_EMOJIS = (
    b"['\xe2\xad\x90','\xf0\x9f\x94\xa5','\xe2\x9c\x85','\xe2\x9d\x8c','\xe2\x9a\xa0\xef\xb8\x8f',"
    b"'\xf0\x9f\x92\xa1','\xf0\x9f\x8e\xaf','\xf0\x9f\x93\x8c','\xf0\x9f\x9a\x80','\xe2\x9d\xa4\xef\xb8\x8f',"
    b"'\xf0\x9f\x91\x8d','\xf0\x9f\x92\xac','\xf0\x9f\x8f\xb7\xef\xb8\x8f','\xe2\x9a\xa1',"
    b"'\xf0\x9f\x8c\x9f','\xf0\x9f\x92\x8e','\xf0\x9f\x94\xb4','\xf0\x9f\x9f\xa1','\xf0\x9f\x9f\xa2','\xf0\x9f\x94\xb5']"
)

new_anchor = (
    b"      {/* " + EM + EM + b" Emoji panel " + EM + EM + b" */}\r\n"
    b"      {panel === 'emoji' && (() => {\r\n"
    b"        const QUICK = " + QUICK_EMOJIS + b"\r\n"
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
    b"      {/* " + EM + EM + b" Radiate panel " + EM + EM + b" */}"
)

assert src.count(old_anchor) == 1
src = src.replace(old_anchor, new_anchor)
print('9 emoji panel: done')

with open(r'F:\code\pim\src\pages\Graph.jsx', 'wb') as f:
    f.write(src)
print('Written.')
