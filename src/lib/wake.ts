/**
 * The wake-word rules, pure (no imports) so test/wake.test.mjs can load them.
 *
 * Only her name, whole word: "Cortana", "Hey Cortana", or the "Kortana"
 * spelling. The looser near-misses that used to be accepted (and Chrome being
 * told to listen out for the name) are what made every small noise wake her.
 */
export const WAKE = /\b(?:(?:hey|hi|ok|okay)[\s,]+)?(?:cortana|kortana)\b(?!'s)/i

/** Below this recogniser confidence (where Chrome reports one), a wake is noise. */
export const WAKE_MIN_CONFIDENCE = 0.6

/**
 * Is this final transcript a real wake? Pure, so test/wake.test.mjs covers it.
 * Returns '' to accept, or why it was rejected.
 */
export function wakeVerdict(text: string, confidence: number, opts: { enabled: boolean; speaking: boolean }): string {
  if (!opts.enabled) return 'wake word is off'
  if (!WAKE.test(text)) return 'not her name'
  if (opts.speaking) return 'she was speaking (echo)'
  if (confidence > 0 && confidence < WAKE_MIN_CONFIDENCE) return `low confidence ${confidence.toFixed(2)}`
  return ''
}


/** "Stop listening for your name" and friends: false = turn off, true = on, null = neither. */
export function wakeCommand(said: string): boolean | null {
  const t = said.toLowerCase()
  if (/\b(?:stop|quit) listening for (?:your|her|my) name\b|\bturn (?:off|of) (?:the |your )?wake ?word\b|\bwake ?word off\b/.test(t)) return false
  if (/\b(?:start|resume) listening for (?:your|her) name\b|\bturn on (?:the |your )?wake ?word\b|\bwake ?word on\b/.test(t)) return true
  return null
}
