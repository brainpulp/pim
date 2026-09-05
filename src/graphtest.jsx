import React from 'react'
import { createRoot } from 'react-dom/client'
import Graph from './pages/Graph'
import './index.css'

// Standalone harness: render the real Graph with a seeded store (via the sharedData path, which
// bypasses Supabase entirely) so the canvas, right-click menu, and table creation can be driven headlessly.
const viewId = 'v1'
const nodes = [
  { id: 'a', label: 'Alpha', notes: '' },
  { id: 'b', label: 'Beta', notes: '' },
  { id: 'c', label: 'Gamma', notes: '' },
]
const edges = [{ id: 'e1', source: 'a', target: 'b' }, { id: 'e2', source: 'a', target: 'c' }]
const views = [{
  id: viewId, name: 'Main', drillRoot: null, bgColor: '#0c0c1a', images: [], slides: [],
  slideshows: [{ id: 'ss', name: 'Default', slides: [] }], activeSlideshowId: 'ss',
  nodeProps: { a: { fx: 0, fy: 0 }, b: { fx: 130, fy: 70 }, c: { fx: -130, fy: 70 } },
}]
import useGraphStore from './lib/graphStore'
window.__store = useGraphStore   // exposed for headless tests only (harness is not in the production build)
const sharedData = { nodes, edges, views, active_view_id: viewId, property_defs: [] }

createRoot(document.getElementById('root')).render(
  <Graph projectId="test-project" projectName="Test" sharedData={sharedData} readOnly={false} />
)
