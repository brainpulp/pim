import { useMemo } from 'react'
import qrcode from 'qrcode-generator'

// Renders `value` as a crisp black-on-white QR code (SVG). `size` = pixel size of the square.
export default function QRCode({ value, size = 220, margin = 4 }) {
  const { path, count } = useMemo(() => {
    const qr = qrcode(0, 'M')       // type 0 = auto-fit, 'M' error correction
    qr.addData(value || ' ')
    qr.make()
    const n = qr.getModuleCount()
    let d = ''
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) d += `M${c},${r}h1v1h-1z`
      }
    }
    return { path: d, count: n }
  }, [value])

  const total = count + margin * 2
  return (
    <svg width={size} height={size} viewBox={`0 0 ${total} ${total}`}
      style={{ display: 'block', borderRadius: 8, background: '#fff' }} shapeRendering="crispEdges">
      <rect width={total} height={total} fill="#fff" />
      <g transform={`translate(${margin},${margin})`}>
        <path d={path} fill="#0a0a14" />
      </g>
    </svg>
  )
}
