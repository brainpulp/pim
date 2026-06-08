import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  createColumnHelper,
} from '@tanstack/react-table'
import { useMemo } from 'react'

const columnHelper = createColumnHelper()

const SAMPLE_DATA = [
  { id: 1, title: 'Sample node', type: 'note', created_at: '2026-06-08' },
  { id: 2, title: 'Another item', type: 'link', created_at: '2026-06-08' },
]

const columns = [
  columnHelper.accessor('title', { header: 'Title' }),
  columnHelper.accessor('type', { header: 'Type' }),
  columnHelper.accessor('created_at', { header: 'Created' }),
]

export default function Table() {
  const data = useMemo(() => SAMPLE_DATA, [])

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
  })

  return (
    <div style={styles.wrap}>
      <h2 style={styles.heading}>Items</h2>
      <table style={styles.table}>
        <thead>
          {table.getHeaderGroups().map(hg => (
            <tr key={hg.id}>
              {hg.headers.map(h => (
                <th key={h.id} style={styles.th}>
                  {flexRender(h.column.columnDef.header, h.getContext())}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map(row => (
            <tr key={row.id} style={styles.tr}>
              {row.getVisibleCells().map(cell => (
                <td key={cell.id} style={styles.td}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const styles = {
  wrap: { padding: '2rem', background: '#0f0f0f', minHeight: '100vh', color: '#fff' },
  heading: { marginBottom: '1.5rem', fontSize: '1.4rem', fontWeight: 600 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' },
  th: { textAlign: 'left', padding: '0.6rem 1rem', borderBottom: '1px solid #2a2a2a', color: '#888', fontWeight: 500 },
  tr: { borderBottom: '1px solid #1e1e1e' },
  td: { padding: '0.6rem 1rem', color: '#ddd' },
}
