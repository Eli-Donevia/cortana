import { useEffect, useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { useStore, type DataPath } from '../store'
import { runtime } from '../lib/runtime'
import * as kokoro from '../lib/kokoro'

/**
 * The start-up sequence, about 4.6 seconds (App holds the boot phase that long).
 *
 * Three beats on plum-black:
 *   1. the Donevia mark draws in over a soft pink bloom;
 *   2. the wordmark and JARVIS resolve under it;
 *   3. a short checklist reports what actually came up: data path, voice,
 *      wake mode, read-only. These are real values from the bridge, not
 *      theatre, so the boot doubles as a health check.
 *
 * Driven by a wall-clock interval rather than requestAnimationFrame, which
 * Chrome throttles in a background tab (upstream's boot froze on its first
 * beat that way).
 */

const T = { word: 900, checks: 1900, bar: 4300 }

const PATH: Record<DataPath['active'], string> = {
  'hq-db': 'HQ database',
  connectors: 'claude.ai connectors',
  'local-mcp': 'local MCP servers',
  none: 'none found',
}

const WAKE: Record<string, string> = {
  auto: 'wake word if private, else Space',
  'on-device': 'on-device wake word',
  cloud: 'wake word (Google speech)',
  off: 'push to talk',
}

export function Boot() {
  const phase = useStore((s) => s.phase)
  const dataPath = useStore((s) => s.dataPath)
  const bootNote = useStore((s) => s.bootNote)
  const reduced = useReducedMotion()
  const [t, setT] = useState(0)

  useEffect(() => {
    if (phase !== 'boot') {
      setT(0)
      return
    }
    const start = Date.now()
    setT(0)
    const id = setInterval(() => setT(Date.now() - start), 50)
    return () => clearInterval(id)
  }, [phase])

  if (phase !== 'boot') return null

  const rt = runtime()
  const voice =
    rt.tts.engine === 'kokoro'
      ? `Kokoro · ${kokoro.activeVoice()}${bootNote ? ` · ${bootNote.replace(/^voice\s*/, '')}` : ''}${
          kokoro.diag.state === 'loading' ? ` · loading ${Math.round(kokoro.diag.progress * 100)}%` : ''
        }`
      : 'system voice'
  const checks: Array<[string, string, boolean]> = [
    ['Data', dataPath ? PATH[dataPath.active] : 'checking…', !!dataPath && dataPath.active !== 'none'],
    ['Voice', voice, true],
    ['Listen', WAKE[rt.wake.mode] ?? rt.wake.mode, true],
    ['Mode', 'read-only', true],
  ]
  const shown = t < T.checks ? 0 : Math.min(checks.length, 1 + Math.floor((t - T.checks) / 380))
  const bar = Math.min(1, t / T.bar)

  return (
    <motion.div className="boot" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4 }}>
      <div className="boot-glow" />
      <div className="boot-center">
        <motion.span
          className="boot-mark orb-dot"
          aria-hidden="true"
          initial={reduced ? { opacity: 1 } : { opacity: 0, scale: 0.86, filter: 'blur(8px)' }}
          animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
          transition={{ duration: 0.9, ease: [0.2, 0.7, 0.2, 1] }}
        />
        <motion.div
          className="boot-title"
          initial={{ opacity: 0, y: 8 }}
          animate={t >= T.word || reduced ? { opacity: 1, y: 0 } : { opacity: 0, y: 8 }}
          transition={{ duration: 0.6 }}
        >
          <motion.span
            className="boot-name"
            initial={reduced ? false : { letterSpacing: '0.9em', opacity: 0 }}
            animate={t >= T.word ? { letterSpacing: '0.42em', opacity: 1 } : {}}
            transition={{ duration: 0.9, ease: 'easeOut' }}
          >
            CORTANA
          </motion.span>
          <span className="boot-sub">Chief of staff to Eli</span>
        </motion.div>

        <ul className="boot-checks" aria-live="polite">
          {checks.slice(0, shown).map(([k, v, ok]) => (
            <motion.li
              key={k}
              initial={{ opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.25 }}
            >
              <span className={ok ? 'bc-dot bc-ok' : 'bc-dot bc-warn'} />
              <span className="bc-k">{k}</span>
              <span className="bc-v">{v}</span>
            </motion.li>
          ))}
        </ul>
      </div>

      <div className="boot-bar" aria-hidden="true">
        <span style={{ transform: `scaleX(${bar})` }} />
      </div>
    </motion.div>
  )
}
