// index.html: never a blank white window, and no inline script for the CSP to allow.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')

test('the page is dark and says something before the scripts run', () => {
  assert.match(html, /<style>[^<]*background:\s*#0a0b0d/)
  const root = /<div id="root">([\s\S]*?)<\/div>\s*<script/.exec(html)
  assert.ok(root && /Starting Cortana/.test(root[1]), 'fallback text inside #root')
})

test('no inline scripts and no unsafe script sources in the shipped CSP', () => {
  for (const m of html.matchAll(/<script\b([^>]*)>/g)) assert.match(m[1], /\bsrc=/)
  const csp = /script-src([^;]*);/.exec(html)[1]
  assert.doesNotMatch(csp, /'unsafe-inline'|'unsafe-eval'/)
})
