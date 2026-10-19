import DOMPurify from 'dompurify'

/**
 * Clean the markup Jarvis composes for a card before it reaches the DOM.
 *
 * Donevia Jarvis shows text only. Upstream let cards carry images, video and
 * embeds, fetched through the bridge; all of that is gone, so a card can never
 * load anything remote, read a file off disk, or run script. What is left is
 * a small set of text tags, a short list of layout classes, and one style
 * property (--v, the fill of a bar).
 */

const ALLOWED_CLASSES = new Set([
  'hud-rows', 'hud-row', 'hud-idx', 'hud-main', 'hud-label', 'hud-sub',
  'hud-tag', 'hud-metric', 'hud-unit', 'hud-note', 'hud-grid', 'hud-bar',
  'hud-dim', 'hud-hot', 'hud-warn', 'hud-ok',
])

function narrowClasses(root: Element) {
  root.querySelectorAll('[class]').forEach((el) => {
    const kept = (el.getAttribute('class') ?? '')
      .split(/\s+/)
      .filter((c) => ALLOWED_CLASSES.has(c))
    if (kept.length) el.setAttribute('class', kept.join(' '))
    else el.removeAttribute('class')
  })
}

export function sanitisePanelHtml(html: string): string {
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'div', 'span', 'p', 'ul', 'ol', 'li', 'b', 'strong', 'em', 'i', 'br',
      'small', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'code',
    ],
    ALLOWED_ATTR: ['class', 'style'],
    // No URI attributes are allowed at all, so nothing can point anywhere.
    ALLOWED_URI_REGEXP: /^$/,
  })
  const doc = new DOMParser().parseFromString(clean, 'text/html')
  doc.body.querySelectorAll('[style]').forEach((el) => {
    const v = /--v:\s*([\d.]+)/.exec(el.getAttribute('style') ?? '')
    if (v) el.setAttribute('style', `--v:${Math.min(1, Math.max(0, Number(v[1])))}`)
    else el.removeAttribute('style')
  })
  narrowClasses(doc.body)
  return doc.body.innerHTML
}
