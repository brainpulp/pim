import { Suspense, useRef, useEffect, useState, useMemo, Component } from 'react'
import { Canvas, useLoader, useThree, useFrame } from '@react-three/fiber'
import { OrbitControls, Environment, useGLTF } from '@react-three/drei'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import * as THREE from 'three'

function fitScene(object) {
  const box = new THREE.Box3().setFromObject(object)
  const center = box.getCenter(new THREE.Vector3())
  const size = box.getSize(new THREE.Vector3())
  const maxDim = Math.max(size.x, size.y, size.z) || 1
  object.position.sub(center)
  object.scale.setScalar(2 / maxDim)
  return object
}

function ModelGLB({ url }) {
  const { scene } = useGLTF(url)
  const fitted = useMemo(() => fitScene(scene.clone()), [scene])
  return <primitive object={fitted} />
}

function ModelOBJ({ url }) {
  const obj = useLoader(OBJLoader, url)
  const fitted = useMemo(() => fitScene(obj.clone()), [obj])
  return <primitive object={fitted} />
}

// Capture canvas to JPEG once after first frame with model visible
function ThumbnailCapture({ onCapture }) {
  const { gl } = useThree()
  const done = useRef(false)
  useFrame(() => {
    if (done.current) return
    done.current = true
    setTimeout(() => {
      try { onCapture(gl.domElement.toDataURL('image/jpeg', 0.7)) } catch (_) {}
    }, 300)
  })
  return null
}

// Restores camera on mount; saves position+target on orbit end
function CameraController({ camState, onCamEnd }) {
  const { camera } = useThree()
  const ref = useRef()

  useEffect(() => {
    if (!ref.current || !camState?.pos) return
    camera.position.set(...camState.pos)
    ref.current.target.set(...(camState.target || [0, 0, 0]))
    ref.current.update()
  }, []) // eslint-disable-line

  return (
    <OrbitControls
      ref={ref}
      enablePan={true}
      minDistance={0.5}
      maxDistance={20}
      mouseButtons={{ LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN }}
      touches={{ ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN }}
      onEnd={() => {
        if (!ref.current) return
        onCamEnd?.({
          pos: camera.position.toArray(),
          target: ref.current.target.toArray(),
        })
      }}
    />
  )
}

class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { err: null } }
  static getDerivedStateFromError(e) { return { err: e } }
  render() {
    if (this.state.err) return (
      <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', width:'100%', height:'100%', color:'#f87171', fontSize:'0.72rem', textAlign:'center', padding:12, gap:6 }}>
        <span>Failed to load model</span>
        <span style={{ color:'#445' }}>{String(this.state.err.message).slice(0, 80)}</span>
      </div>
    )
    return this.props.children
  }
}

// Blob URL that lives until replaced or unmounted — avoids async loader race with revocation
function useStagedBlobUrl(modelData, modelType) {
  const [url, setUrl] = useState(null)
  const prevUrl = useRef(null)

  useEffect(() => {
    if (!modelData || !modelType) {
      if (prevUrl.current) { URL.revokeObjectURL(prevUrl.current); prevUrl.current = null }
      setUrl(null)
      return
    }
    const mime = modelType === 'glb' ? 'model/gltf-binary' : 'text/plain'
    try {
      const bin = atob(modelData)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const next = URL.createObjectURL(new Blob([bytes], { type: mime }))
      // Don't revoke previous yet — loader may still be reading it.
      // Schedule revocation after a safe delay.
      const old = prevUrl.current
      if (old) setTimeout(() => URL.revokeObjectURL(old), 5000)
      prevUrl.current = next
      setUrl(next)
    } catch (e) { console.error('blob url:', e) }
  }, [modelData, modelType])

  // Revoke on unmount
  useEffect(() => () => { if (prevUrl.current) URL.revokeObjectURL(prevUrl.current) }, [])

  return url
}

export default function Node3DViewer({ modelData, modelType, camState, onCamEnd, onThumbnailCapture, onImport }) {
  const fileInputRef = useRef()
  const blobUrl = useStagedBlobUrl(modelData, modelType)

  const handleFile = e => {
    const file = e.target.files?.[0]
    if (file) onImport(file)
    e.target.value = ''
  }

  if (!modelData) {
    return (
      <div style={{ width:'100%', height:'100%', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:12 }}>
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#2d3a6a" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
          <polyline points="3.27 6.96 12 12.01 20.73 6.96"/>
          <line x1="12" y1="22.08" x2="12" y2="12"/>
        </svg>
        <span style={{ fontSize:'0.72rem', color:'#556' }}>No model loaded</span>
        <button onClick={() => fileInputRef.current?.click()}
          style={{ padding:'5px 14px', background:'#12182e', border:'1px solid #2d3a6a', borderRadius:6, fontSize:'0.72rem', color:'#88b4e8', cursor:'pointer' }}>
          Import 3D file
        </button>
        <span style={{ fontSize:'0.62rem', color:'#334' }}>GLB · OBJ</span>
        <input ref={fileInputRef} type="file" accept=".glb,.obj" style={{ display:'none' }} onChange={handleFile} />
      </div>
    )
  }

  if (!blobUrl) {
    return <div style={{ width:'100%', height:'100%', display:'flex', alignItems:'center', justifyContent:'center', color:'#334', fontSize:'0.75rem' }}>Loading…</div>
  }

  return (
    <ErrorBoundary key={blobUrl}>
      <div style={{ position:'relative', width:'100%', height:'100%' }}>
        <Canvas
          camera={{ position: [0, 1.2, 3.5], fov: 45 }}
          dpr={[1, 2]}
          gl={{ antialias: true, alpha: true, preserveDrawingBuffer: true }}
          style={{ background: 'transparent' }}
        >
          <ambientLight intensity={0.7} />
          <directionalLight position={[5, 10, 5]} intensity={1.2} />
          <directionalLight position={[-5, -3, -5]} intensity={0.3} />
          <Suspense fallback={null}>
            {modelType === 'glb' && <ModelGLB url={blobUrl} />}
            {modelType === 'obj' && <ModelOBJ url={blobUrl} />}
            <Environment preset="studio" />
            {onThumbnailCapture && <ThumbnailCapture onCapture={onThumbnailCapture} />}
          </Suspense>
          <CameraController camState={camState} onCamEnd={onCamEnd} />
        </Canvas>
        <button onClick={() => fileInputRef.current?.click()} title="Replace model"
          style={{ position:'absolute', bottom:6, right:6, padding:'3px 8px', background:'rgba(10,10,30,0.7)', border:'1px solid #2d3a6a', borderRadius:5, fontSize:'0.65rem', color:'#5b6af0', cursor:'pointer' }}>
          ↑ replace
        </button>
        <input ref={fileInputRef} type="file" accept=".glb,.obj" style={{ display:'none' }} onChange={handleFile} />
      </div>
    </ErrorBoundary>
  )
}
