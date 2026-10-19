import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useStore } from '../store'

/**
 * Rotating examples, shown only while idle and only until the first exchange.
 * A voice interface has no menus; this is the one hint about what it can do.
 * Phrased the way Eli would say them.
 */
const EXAMPLES = [
  'what needs me today',
  "what's next on my calendar",
  'where is the pipeline',
  'what do I owe people',
  'brief me on my next meeting',
  'show the pipeline on HQ',
  'anything new from NOFFCU',
  'what did we agree with Ascend',
]

const ROTATE_MS = 4200

export function Suggestions({ wake }: { wake: string }) {
  const phase = useStore((s) => s.phase)
  const turns = useStore((s) => s.turns)
  const [i, setI] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setI((n) => (n + 1) % EXAMPLES.length), ROTATE_MS)
    return () => clearInterval(id)
  }, [])

  if (phase !== 'dormant' || turns.length > 0) return null
  const ptt = wake === 'push-to-talk' || wake === 'pack-downloading'
  const lead = ptt ? 'press space, then' : 'try'
  const say = ptt ? EXAMPLES[i] : `Cortana, ${EXAMPLES[i]}`

  return (
    <div className="suggest">
      <span className="suggest-lead">{lead}</span>
      <AnimatePresence mode="wait">
        <motion.span
          key={i}
          className="suggest-text"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.35 }}
        >
          “{say}”
        </motion.span>
      </AnimatePresence>
    </div>
  )
}
