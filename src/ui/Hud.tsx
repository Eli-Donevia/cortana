import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useStore, accentFor, type Phase, type DataPath } from '../store'
import { Suggestions } from './Suggestions'
import { Blades } from './Blades'
import { Effects } from './Effects'
import { toggleWakeWord } from '../lib/wakeSwitch'
import { WorkspaceSwitcher } from './WorkspaceSwitcher'
import { AgentsPanel } from './AgentsPanel'

const statusText: Record<Phase, string> = {
  offline: 'Offline',
  boot: 'Starting',
  dormant: 'Standby',
  waking: 'Online',
  listening: 'Listening',
  thinking: 'Thinking',
  tooling: 'Reading',
  speaking: 'Speaking',
}

const WAKE_HINT: Record<string, string> = {
  porcupine: 'Say “Jarvis”',
  'on-device': 'Say “Cortana”',
  cloud: 'Say “Cortana”',
  'push-to-talk': 'Press Space to talk',
  'pack-downloading': 'Press Space to talk · “Cortana” after the speech pack loads',
  'wake-off': 'Wake word off · press Space to talk',
}

/** Chicago time, the way HQ shows it. */
function useClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 15000)
    return () => clearInterval(id)
  }, [])
  const time = now.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Chicago',
  })
  const day = now.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'America/Chicago',
  })
  return { time, day }
}

function Sources({ path }: { path: DataPath | null }) {
  if (!path) return <div className="rail-item dim">Checking…</div>
  if (path.active === 'none') {
    return (
      <>
        <div className="rail-item rail-warn">
          <span className="tick tick-warn" />
          No data source
        </div>
        <div className="rail-note">Press D for the reason</div>
      </>
    )
  }
  // The active source is pink; fallbacks that are available are violet.
  const hq =
    path.active === 'hq-db' ? 'live' : path.hqDb === 'unavailable' ? 'off' : 'ready'
  const conn = path.active === 'connectors' ? 'live' : 'ready'
  const local = path.active === 'local-mcp' ? 'live' : 'ready'
  return (
    <>
      <div className={`rail-item ${hq === 'live' ? 'rail-lead' : hq === 'off' ? 'dim' : ''}`}>
        <span className={`tick tick-${hq}`} />
        HQ database <span className="rail-tag">{hq}</span>
      </div>
      {path.connectors.slice(0, 7).map((c) => (
        <div key={c} className={`rail-item ${conn === 'live' ? 'rail-lead' : ''}`}>
          <span className={`tick tick-${conn}`} />
          {c.replace(/^claude\.ai\s+/i, '')}
        </div>
      ))}
      {path.localMcp.slice(0, 4).map((c) => (
        <div key={c} className={`rail-item ${local === 'live' ? 'rail-lead' : ''}`}>
          <span className={`tick tick-${local}`} />
          {c} <span className="rail-tag">local</span>
        </div>
      ))}
      <div className="rail-foot">Read-only</div>
    </>
  )
}

export function Hud({ onTalk }: { onTalk: () => void }) {
  const phase = useStore((s) => s.phase)
  const caption = useStore((s) => s.caption)
  const turns = useStore((s) => s.turns)
  const activeTool = useStore((s) => s.activeTool)
  const error = useStore((s) => s.error)
  const level = useStore((s) => s.level)
  const voice = useStore((s) => s.voice)
  const voiceNote = useStore((s) => s.voiceNote)
  const bootNote = useStore((s) => s.bootNote)
  const dataPath = useStore((s) => s.dataPath)
  const wake = useStore((s) => s.wake)
  const ui = useStore((s) => s.ui)
  const { time, day } = useClock()

  // accentFor folds Jarvis's overrides in over the phase colour, so one
  // variable on the root carries a theme change into every rule.
  const colour = accentFor(phase, ui)

  useEffect(() => {
    const root = document.documentElement
    if (ui.background) root.style.setProperty('--bg', ui.background)
    else root.style.removeProperty('--bg')
  }, [ui.background])

  const busy = phase === 'thinking' || phase === 'tooling' || phase === 'speaking'
  const live = phase !== 'offline' && phase !== 'boot'

  return (
    <div className={`hud hud-${phase}`} style={{ ['--accent' as string]: colour }}>
      <header className="hud-top">
        {ui.chrome.brand && (
          <div className="brand">
            <span className="orb-dot orb-dot-brand" aria-hidden="true" />
            <span className="brand-name">CORTANA</span>
            <span className="brand-rule" />
            <WorkspaceSwitcher />
          </div>
        )}

        <div className="top-right">
          <div className="status" role="status">
            <span className="dot" />
            <span className="status-text">
              {phase === 'boot' && bootNote ? bootNote : statusText[phase]}
            </span>
          </div>
          <div className="clock">
            <span className="clock-time">{time}</span>
            <span className="clock-day">{day} · CT</span>
          </div>
        </div>
      </header>

      {ui.chrome.systems && live && (
        <aside className="rail rail-left">
          <div className="rail-title">Sources</div>
          <Sources path={dataPath} />
        </aside>
      )}

      {live && (
        <aside className="rail rail-right">
          <div className="rail-title">Signal</div>
          <div className="meter">
            <div className="meter-fill" style={{ height: `${Math.round(level * 100)}%` }} />
          </div>
          <div className="rail-item mono">{(level * 100).toFixed(0).padStart(3, '0')}</div>
        </aside>
      )}

      {/* The reactor is the talk button. A real button, so it is reachable by
          keyboard and announced by VoiceOver, sized to the ring. */}
      {live && (
        <button
          className={`talk-hit${busy ? ' talk-busy' : ''}`}
          onClick={onTalk}
          aria-label={busy ? 'Interrupt Cortana' : 'Talk to Cortana'}
          title={busy ? 'Interrupt (Space)' : 'Talk (Space)'}
        />
      )}

      <AnimatePresence>
        {activeTool && ui.chrome.toolBadge && (
          <motion.div
            className="tool-badge"
            initial={{ opacity: 0, x: '-50%', y: -6 }}
            animate={{ opacity: 1, x: '-50%', y: 0 }}
            exit={{ opacity: 0, x: '-50%', y: -6 }}
            transition={{ duration: 0.25 }}
          >
            <span className="tool-kicker">
              <span className="spinner" />
              Reading
            </span>
            <span className="tool-name">{activeTool}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {ui.chrome.transcript && (
        <div className="log">
          <AnimatePresence initial={false}>
            {turns.slice(-3).map((t) => (
              <motion.div
                key={t.id}
                className={`log-line log-${t.role}`}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3 }}
              >
                <span className="log-who">{t.role === 'user' ? 'Eli' : 'Cortana'}</span>
                <span className="log-text">{t.text}</span>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}

      <AnimatePresence>
        {caption && (
          <motion.div
            className="caption"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            {caption}
          </motion.div>
        )}
      </AnimatePresence>

      <Blades />
      <AgentsPanel />

      {ui.chrome.suggestions && <Suggestions wake={wake} />}

      {error && live && <div className="error" role="alert">{error}</div>}

      {live && (
        <footer className="hud-bottom">
          <span className="hint">
            <b>{WAKE_HINT[wake] ?? 'Press Space to talk'}</b>
            <span className="sep">·</span>
            <kbd>Space</kbd> talk or interrupt
            <span className="sep">·</span>
            <kbd>Esc</kbd> stand by
            <span className="sep">·</span>
            <kbd>D</kbd> diagnostics
            <span className="sep">·</span>
            <button type="button" className="wake-toggle" onClick={() => toggleWakeWord()} title="Turn listening for her name on or off">
              <kbd>W</kbd> wake word {wake === 'wake-off' ? 'off' : 'on'}
            </button>
            {voice && (
              <>
                <span className="sep">·</span>
                <span className="hint-voice">{voice.replace(/\(.*?\)/g, '').trim()}</span>
              </>
            )}
            {voiceNote && (
              <>
                <span className="sep">·</span>
                <span className="hint-voice-note" title="V changes the voice. Press D for details.">
                  {voiceNote}
                </span>
              </>
            )}
          </span>
        </footer>
      )}

      <Effects />
    </div>
  )
}
