import { useEffect, useState } from 'react'
import { useStore } from '../store'

/**
 * The "why can't he hear me / why can't I hear him" panel.
 *
 * Both halves of the voice loop fail silently by nature. Speech recognition
 * that ignores you and speech synthesis that produces no sound look identical
 * from the outside — nothing throws, nothing logs, the interface carries on as
 * though it were working. Every bug in this loop has therefore cost a round
 * trip of guesswork, and that is the actual problem this fixes: it is not a
 * developer toy, it is the instrument that turns "it doesn't work" into a
 * specific, answerable fact.
 *
 * Press D to show it. It polls rather than subscribing, because the two
 * diagnostic records are plain mutable objects written from outside React —
 * that is deliberate, since the whole point is to observe the loop without
 * changing its timing.
 */

type VoiceDiag = {
  engine: string
  wake: string
  onDevice: string
  alwaysOn: boolean
  running: boolean
  sessions: number
  heard: string
  heardAt: number
  lastError: string
  wakes: number
  wakeOff?: boolean
  rejected?: string[]
  mode: string
  dropped: string
  accepted: number
  restarts: number
  idleMs: number
}

type TtsDiag = {
  engine: string
  spoken: number
  started: number
  failures: number
  lastError: string
  nativeBroken: boolean
  rescued: number
  voice: string
  lastText: string
}

type KokoroDiag = {
  state: string
  device: string
  dtype: string
  voice: string
  progress: number
  loadMs: number
  rtf: number
  generated: number
  lastError: string
}

const ago = (t: number) => (t ? `${((Date.now() - t) / 1000).toFixed(1)}s ago` : '—')

function Row({ k, v, bad }: { k: string; v: string; bad?: boolean }) {
  return (
    <div className="diag-row">
      <span className="diag-k">{k}</span>
      <span className={bad ? 'diag-v diag-bad' : 'diag-v'}>{v}</span>
    </div>
  )
}

export function Diagnostics() {
  const [open, setOpen] = useState(false)
  const [, tick] = useState(0)
  const phase = useStore((s) => s.phase)
  const path = useStore((s) => s.dataPath)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === 'd' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!open) return
    const id = setInterval(() => tick((n) => n + 1), 250)
    return () => clearInterval(id)
  }, [open])

  if (!open) return null

  const w = window as unknown as Record<string, unknown>
  const v = (w.__voice ?? {}) as Partial<VoiceDiag>
  const t = (w.__tts ?? {}) as Partial<TtsDiag>
  const k = (w.__kokoro ?? {}) as Partial<KokoroDiag>

  // The two verdicts worth stating outright, rather than making you infer them
  // from the numbers underneath.
  const earsOk = Boolean(v.running) && (v.accepted ?? 0) > 0
  const mouthOk = (t.started ?? 0) > 0 || (t.rescued ?? 0) > 0

  return (
    <div className="diag" aria-live="polite">
      <div className="diag-head">DIAGNOSTICS · D to close</div>

      <div className="diag-verdict">
        <span className={earsOk ? 'diag-ok' : 'diag-bad'}>
          {earsOk ? '● hearing you' : '● not hearing you'}
        </span>
        <span className={mouthOk ? 'diag-ok' : 'diag-bad'}>
          {mouthOk ? '● speaking' : '● no sound produced'}
        </span>
      </div>

      <div className="diag-sec">DATA PATH</div>
      <Row k="active" v={path ? path.active : 'not reported yet'} bad={!path || path.active === 'none'} />
      <Row k="HQ database" v={path ? `${path.hqDb}${path.hqTool ? ` (${path.hqTool})` : ''}` : '—'} bad={path?.hqDb === 'unavailable'} />
      <Row k="connectors" v={path?.connectors.length ? path.connectors.join(', ') : '—'} />
      <Row k="local MCP" v={path?.localMcp.length ? path.localMcp.join(', ') : '—'} />
      <Row k="account" v={path?.account?.email ?? '—'} />
      {path?.notes.map((n) => <Row key={n} k="note" v={n} bad />)}

      <div className="diag-sec">WAKE</div>
      <Row k="wake word" v={v.wake ?? '—'} />
      <Row k="speech engine" v={v.engine ?? '—'} bad={v.engine === 'none'} />
      <Row k="on-device pack" v={v.onDevice ?? '—'} />
      <Row k="always on" v={v.alwaysOn ? 'yes' : 'no (only during a conversation)'} />

      <div className="diag-sec">LISTENING</div>
      <Row k="recogniser" v={v.running ? 'running' : 'STOPPED'} bad={!v.running} />
      <Row k="sessions" v={String(v.sessions ?? 0)} />
      <Row
        k="silent for"
        v={`${((v.idleMs ?? 0) / 1000).toFixed(1)}s`}
        bad={(v.idleMs ?? 0) > 15000}
      />
      <Row k="forced restarts" v={String(v.restarts ?? 0)} bad={(v.restarts ?? 0) > 0} />
      <Row k="mode" v={`${v.mode ?? '—'} (phase ${phase})`} />
      <Row k="accepted" v={String(v.accepted ?? 0)} bad={(v.accepted ?? 0) === 0} />
      <Row k="wakes" v={String(v.wakes ?? 0)} />
      <Row k="wake word" v={v.wakeOff ? 'off (W to turn on)' : 'on'} bad={Boolean(v.wakeOff)} />
      <Row k="refused wakes" v={v.rejected?.length ? v.rejected.join(' | ') : '—'} />
      <Row k="last heard" v={v.heard ? `"${v.heard}" ${ago(v.heardAt ?? 0)}` : '— nothing yet'} bad={!v.heard} />
      <Row k="last drop" v={v.dropped || '—'} bad={Boolean(v.dropped)} />
      <Row k="error" v={v.lastError || '—'} bad={Boolean(v.lastError)} />

      <div className="diag-sec">SPEAKING · press T to test</div>
      <Row k="engine" v={String(t.engine ?? 'system')} />
      <Row k="voice" v={String(t.voice || '—')} />
      <Row k="handed to OS" v={String(t.spoken ?? 0)} />
      <Row k="actually spoke" v={String(t.started ?? 0)} bad={(t.started ?? 0) === 0} />
      <Row k="failures" v={String(t.failures ?? 0)} bad={(t.failures ?? 0) > 0} />
      <Row k="Kokoro rescues" v={String(t.rescued ?? 0)} />
      <Row k="error" v={t.lastError || '—'} bad={Boolean(t.lastError)} />

      <div className="diag-sec">KOKORO</div>
      <Row k="state" v={`${k.state ?? 'idle'}${k.state === 'loading' ? ` ${Math.round((k.progress ?? 0) * 100)}%` : ''}`} bad={k.state === 'failed' || k.state === 'slow'} />
      <Row k="device" v={k.device ? `${k.device} / ${k.dtype}` : '—'} />
      <Row k="voice" v={k.voice || '—'} />
      <Row k="load time" v={k.loadMs ? `${(k.loadMs / 1000).toFixed(1)}s` : '—'} />
      <Row k="speed" v={k.rtf ? `${k.rtf}x real time` : '—'} bad={(k.rtf ?? 0) > 1.4} />
      <Row k="sentences" v={String(k.generated ?? 0)} />
      <Row k="error" v={k.lastError || '—'} bad={Boolean(k.lastError)} />
    </div>
  )
}
