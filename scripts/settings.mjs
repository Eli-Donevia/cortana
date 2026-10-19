#!/usr/bin/env node
/**
 * npm run settings: open Jarvis's settings in TextEdit.
 *
 * Creates "Jarvis settings.txt" in the donevia-jarvis folder from
 * .env.example the first time (every line commented out, so nothing changes
 * until you remove a "#"), then opens it. A .txt file opens in TextEdit as
 * plain text, and Finder shows it (unlike .env.local). Restart Jarvis after
 * saving.
 *
 * The voice no longer needs this: press V in Jarvis to try the Kokoro voices
 * live (the choice is remembered). JARVIS_KOKORO_VOICE sets the starting one.
 */
import { copyFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { platform } from 'node:os'
import { SETTINGS_FILES, KOKORO_VOICES } from '../bridge/env.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const file = join(ROOT, SETTINGS_FILES[0])

if (!existsSync(file)) {
  copyFileSync(join(ROOT, '.env.example'), file)
  console.log(`\n  Made "${SETTINGS_FILES[0]}" in the donevia-jarvis folder.`)
}
console.log('  To change a setting, delete the "#" at the start of its line and edit the value.')
console.log('  Save, then quit Jarvis and start it again.\n')
console.log('  Voice: press V in Jarvis to hear the next Kokoro voice, live; it is remembered.')
console.log('  Shift+V steps the Mac voice used while Kokoro loads. To set the starting voice here:')
console.log(`  JARVIS_KOKORO_VOICE= one of ${KOKORO_VOICES.join(', ')}\n`)
if (platform() === 'darwin') spawnSync('open', ['-e', file], { stdio: 'inherit' })
else console.log(`  Open ${file} in a text editor.\n`)
