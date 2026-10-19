import { useEffect, useRef, useState } from 'react'
import { switchWorkspace, watchWorkspaces, type Workspace } from '../lib/bridge'

/**
 * The workspace switcher, top left beside the name. One workspace per company;
 * picking one starts a fresh conversation that only sees that company's
 * sources. "Switch to <name>" by voice does the same.
 */
export function WorkspaceSwitcher() {
  const [state, setState] = useState<{ active: string; list: Workspace[] }>({ active: '', list: [] })
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => watchWorkspaces(setState), [])
  useEffect(() => {
    if (!open) return
    const close = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', esc)
    }
  }, [open])

  const active = state.list.find((w) => w.id === state.active)
  if (!active) return null

  return (
    <div className="ws" ref={root}>
      <button
        type="button"
        className="ws-current"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title="Workspace: which company Cortana is working in"
      >
        <span className="ws-dot" style={{ background: active.accent }} />
        {active.name}
        <span className="ws-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <ul className="ws-menu" role="listbox" aria-label="Workspaces">
          {state.list.map((w) => (
            <li key={w.id}>
              <button
                type="button"
                role="option"
                aria-selected={w.id === state.active}
                className="ws-item"
                onClick={() => {
                  setOpen(false)
                  if (w.id !== state.active) switchWorkspace(w.id)
                }}
              >
                <span className="ws-dot" style={{ background: w.accent }} />
                {w.name}
              </button>
            </li>
          ))}
          <li className="ws-hint">Say “add a workspace called …” to add one.</li>
        </ul>
      )}
    </div>
  )
}
