# Strategy tab — handoff notes

**Status: code complete and building; DB migration APPLIED. Remaining: manual test, lint, PR.**
Branch: `claude/strategy-tab`. Written by a Claude session working from the
`brainpulp/stratego` repo; this doc lets a session inside pim pick it up.

## What this feature is

A third view tab ("strategy", next to graph and table). The user types a plan
in a small structured language in a left-hand editor and a flowchart renders
live on the right — tasks as boxes, decisions as diamonds with labeled yes/no
branches, dependencies as dashed orange arrows. A "Gaps" panel below the
editor lists holes in the plan (decisions missing a "no" branch, dead ends,
unreachable steps). The strategy is saved per project.

It is a port of `brainpulp/stratego` (see that repo's PR #1 for the original
TypeScript implementation, tests, and README documenting the DSL grammar).
The port is plain JS to match pim conventions, and dark-themed to match pim.

## The DSL (one line = one statement)

```
title: Launch v1
start
Start -> Build MVP
task Build MVP: Core flows only
decision Beta feedback positive?     # branches follow, indented:
  yes -> Public launch
  no -> Iterate on feedback
Public launch needs Marketing site, App store approval
Public launch -> end
```

Chains auto-create unknown names as tasks. Names may contain spaces;
references are case-insensitive. `# comment` lines ignored.

## Files added / changed on this branch

| File | What it is |
|---|---|
| `src/strategy/parser.js` | DSL → `{ strategy: {nodes, edges}, diagnostics, names }`. Line-based, two passes. Diagnostics carry char offsets for the editor's lint gutter. |
| `src/strategy/lints.js` | `lintStrategy(strategy)` → gap findings for the Gaps panel. |
| `src/strategy/layout.js` | `layoutStrategy(strategy)` → `{nodeId: {x,y}}` via @dagrejs/dagre, top-to-bottom. |
| `src/strategy/editorLang.js` | CodeMirror StreamLanguage highlighting + `makeDslCompletions(getNames)` autocomplete (keywords at line start, node names after `->`/`needs`/`,`, yes/no snippets when indented). |
| `src/strategy/StrategyNodes.jsx` | React Flow custom nodes: task box, decision diamond, start/end pills, note. |
| `src/strategy/strategy.css` | Dark-theme styles (`strat-*` class prefix). |
| `src/pages/Strategy.jsx` | The page: CodeMirror editor (150ms debounced reparse) + React Flow canvas + Gaps panel. Dragged nodes get "pinned" and keep their position across reparses; Re-layout clears pins. Autosaves 1.2s after last edit via `saveStrategy`. |
| `src/lib/db.js` | Added `loadStrategy(id)` / `saveStrategy(id, {text, positions, pinned})` reading/writing a `strategy` jsonb column on `pim_projects`. |
| `src/App.jsx` | Added `Strategy` import, `'strategy'` in the nav tab array, and the `view === 'strategy'` render branch (wrapped in AppErrorBoundary, receives `projectId`). |
| `package.json` | New deps: `@xyflow/react`, `@dagrejs/dagre`, `codemirror`, `@codemirror/{autocomplete,lint,language,state,view}`. |

Architecture note: **the text is the source of truth**. The graph is derived
by the parser on every edit; only drag positions/pins live outside the text.

## ⚠️ REMAINING WORK (in order)

1. ~~Supabase migration~~ **DONE** — `strategy jsonb` column added to
   `public.pim_projects` on project `ikztpvxfgmhmrcwolwgx` (migration
   `add_strategy_column_to_pim_projects`). Note: pim's CLAUDE.md still names
   the old shared project `fnzdkqrkranedtgysqcf`, but SESSIONS.md records the
   migration to the dedicated `ikztpvxfgmhmrcwolwgx` project — CLAUDE.md's
   Stack section is stale and could be updated. RLS: existing pim_projects
   policies cover the new column automatically; no policy changes needed.
2. **Manual test**: `npm run dev`, open a project, click the "strategy" tab.
   Type, check flowchart updates, drag a node, switch tabs and back, reload —
   text and dragged positions should persist per project.
3. **Check the save indicator** (top of editor pane: Saved/Saving…/Unsaved/
   Save failed) behaves during edits.
4. `npm run lint` (not yet run — eslint may flag the two
   `eslint-disable-next-line react-hooks/exhaustive-deps` uses in
   Strategy.jsx; they are intentional).
5. Commit, push, PR to `main` per repo convention.

## Known limitations / later ideas

- No AI mode. The original stratego repo has an AI chat mode (Claude edits
  the DSL via tool use with a server-side parse/repair loop) implemented as a
  Netlify function — pim is GitHub Pages, so porting it would need a Supabase
  Edge Function holding an `ANTHROPIC_API_KEY` secret. The protocol to copy is
  in `stratego/netlify/functions/lib/chatLogic.ts`.
- Edge labels can overlap when two labeled edges converge; an ELK layout swap
  or label offsets would fix it.
- `npm run build` passes (verified). Bundle grew past Vite's 500 kB chunk
  warning — consider lazy-loading the Strategy page via `React.lazy` if it
  matters.
