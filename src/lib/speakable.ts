/**
 * Turn written text into words a voice can say (HQ SPEC 4.4.5, trimmed).
 *
 * The model is told to write for the ear, and mostly does, but markdown and
 * shorthand leak. A synthesiser reads "$2.4M" as "dollar two point four em"
 * and a URL as "aitch tee tee pee", so this cleans up after it. Pure, so it is
 * covered by test/speakable.test.mjs (transpiled on the fly).
 */

const LEXICON: Array<[RegExp, string]> = [
  // Eli says his name EE-lye, like the prophet; read plain, voices say ELL-ee.
  [/\bEli\b/g, 'Ee-lye'],
  [/\bCUs\b/g, 'credit unions'],
  [/\bCU\b/g, 'credit union'],
  [/\bNCUA\b/g, 'N.C.U.A.'],
  [/\bACH\b/g, 'A.C.H.'],
  [/\bCUSO\b/g, 'cue-so'],
  [/\bLOI\b/g, 'L.O.I.'],
  [/\bSOC ?2\b/gi, 'sock two'],
  [/\bEOD\b/g, 'end of day'],
  [/\bw\/o\b/gi, 'without'],
  [/\bw\//gi, 'with '],
]

const SCALE: Record<string, string> = { k: 'thousand', K: 'thousand', m: 'million', M: 'million', b: 'billion', B: 'billion' }

export function speakable(input: string): string {
  let t = String(input)
  t = t
    .replace(/^\s*Sources?:.*$/gim, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/[^\s]*[^\s.,;:!?)\]]/g, 'the link on screen')
    .replace(/[*_`#>]+/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
  // $2.4M -> 2.4 million dollars; $350k -> 350 thousand dollars; $1,200 -> 1,200 dollars
  t = t.replace(/\$\s?(\d[\d,]*(?:\.\d+)?)\s?([kKmMbB])\b/g, (_, n, s) => `${n} ${SCALE[s]} dollars`)
  t = t.replace(/\$\s?(\d[\d,]*(?:\.\d+)?)/g, '$1 dollars')
  // 3-5 -> 3 to 5 (number ranges only, not dates or ids)
  t = t.replace(/(?<![-/\d])\b(\d{1,3})\s?[-–]\s?(\d{1,3})\b(?![-/])/g, '$1 to $2')
  t = t.replace(/~\s?(\d)/g, 'about $1')
  t = t.replace(/(\d)\s?%/g, '$1 percent')
  t = t.replace(/\s&\s/g, ' and ')
  for (const [re, word] of LEXICON) t = t.replace(re, word)
  return t.replace(/\s+/g, ' ').trim()
}
