// CodeMirror language + completions for the strategy DSL.
// Ported from the stratego repo (src/editor/language.ts + completions.ts).
import { StreamLanguage } from '@codemirror/language'

export const dslLanguage = StreamLanguage.define({
  token(stream) {
    if (stream.sol()) {
      if (stream.match(/^\s*#.*/)) return 'comment'
      if (stream.match(/^title:/)) return 'keyword'
      if (stream.match(/^(task|decision|note)\b(?!.*->)/)) return 'keyword'
      if (stream.match(/^(start|end)\s*$/)) return 'keyword'
      if (stream.match(/^(start|end)\b(?!.*->)/)) return 'keyword'
    }
    if (stream.match(/^-\[[^\]]*\]->/)) return 'operator'
    if (stream.match(/^->/)) return 'operator'
    if (stream.match(/^needs\b/)) return 'keyword'
    stream.next()
    return null
  },
})

const KEYWORDS = [
  { label: 'task ', displayLabel: 'task', type: 'keyword', info: 'Declare a task: task Name: description' },
  { label: 'decision ', displayLabel: 'decision', type: 'keyword', info: 'Declare a decision, then indent its branches' },
  { label: 'start', type: 'keyword', info: 'The starting point' },
  { label: 'end', type: 'keyword', info: 'A terminator' },
  { label: 'note ', displayLabel: 'note', type: 'keyword', info: 'Free-floating annotation' },
  { label: 'title: ', displayLabel: 'title:', type: 'keyword', info: 'Strategy title' },
]

const BRANCH_SNIPPETS = [
  { label: 'yes -> ', displayLabel: 'yes ->', type: 'text', info: 'Positive branch' },
  { label: 'no -> ', displayLabel: 'no ->', type: 'text', info: 'Negative branch' },
  { label: 'otherwise -> ', displayLabel: 'otherwise ->', type: 'text', info: 'Fallback branch' },
]

/** getNames: () => string[] — latest node labels for name completion. */
export function makeDslCompletions(getNames) {
  return function dslCompletions(context) {
    const line = context.state.doc.lineAt(context.pos)
    const before = context.state.sliceDoc(line.from, context.pos)
    const nameOptions = getNames().map(name => ({ label: name, type: 'variable', boost: 1 }))

    // After the last arrow / needs / list separator: complete existing node names.
    const afterSep = before.match(/^.*(->|\bneeds\b|,)\s*(.*)$/i)
    if (afterSep) {
      const fragment = afterSep[2]
      if (!fragment && !context.explicit) return null
      return {
        from: context.pos - fragment.length,
        options: [...nameOptions, { label: 'end', type: 'keyword', boost: -1 }],
        validFor: /^[^,>-]*$/,
      }
    }

    const indent = before.match(/^\s*/)[0]
    const fragment = before.slice(indent.length)
    if (!fragment && !context.explicit) return null

    // Indented line: branch labels for the decision above.
    if (indent.length > 0) {
      return { from: line.from + indent.length, options: BRANCH_SNIPPETS, validFor: /^[\w ]*$/ }
    }

    // Line start: keywords plus known node names (typing a name starts a chain).
    return { from: line.from, options: [...KEYWORDS, ...nameOptions], validFor: /^[\w ]*$/ }
  }
}
