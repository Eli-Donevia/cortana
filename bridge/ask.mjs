/**
 * What may be sent to Claude Code as a question.
 *
 * Claude Code reads some user messages as instructions to itself, not to the
 * model, and runs them without a tool call, so the policy gate never sees
 * them:
 *   - "/config ...", "/heapdump", "/model" and every other slash command. These
 *     can change ~/.claude/settings.json or write a heap snapshot (with tokens
 *     in it) to the Desktop.
 *   - "!" at the start, which is shell mode in the interactive CLI.
 *   - "@path" mentions, which attach a local file's contents to the message.
 *
 * Spoken questions never start with "/" or "!", so those are refused outright.
 * Every "@" that is not inside an email address becomes a fullwidth "\uFF20",
 * so the model still reads it as an at sign but there is no ASCII "@" left for
 * Claude Code to start a file mention from, however its parser finds them.
 * (Claude Code does the same to text it inserts itself.) Email addresses keep
 * their "@": Claude Code only starts a mention at the start of a word or after
 * "\u3002", "\u3001", "\uFF1F" or "\uFF01", never after a letter or digit.
 * test/mentions.test.mjs runs Claude Code's own mention rules over the result
 * and re-reads them from the bundled binary; re-check them when
 * @anthropic-ai/claude-agent-sdk is upgraded.
 */

export const MAX_ASK = 4000

/** Whitespace, including the Unicode spaces a transcript or paste can carry. */
const LEAD = /^[\s\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]*/

const FULLWIDTH_AT = '\uff20'

/**
 * @returns {{ ok: true, text: string } | { ok: false, reason: string, say: string }}
 */
export function checkAsk(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'not text', say: '' }
  const text = raw.slice(0, MAX_ASK)
  const body = text.replace(LEAD, '')
  if (!body) return { ok: false, reason: 'empty', say: '' }
  const first = body[0]
  if (first === '/' || first === '\uff0f' || first === '!' || first === '\uff01') {
    return {
      ok: false,
      reason: `refused a ${first === '!' || first === '\uff01' ? 'shell' : 'slash'} command`,
      say: "I don't take commands like that, Eli. Just ask.",
    }
  }
  // Any "@" not preceded by an email-local character -> fullwidth at sign.
  // Email addresses ("eli@127group.io") keep their @.
  const safe = body.replace(/(?<![A-Za-z0-9._%+-])@/g, FULLWIDTH_AT)
  return { ok: true, text: safe }
}
