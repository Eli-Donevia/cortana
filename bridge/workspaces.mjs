import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DEFAULT_HQ_URL } from './policy.mjs'

/**
 * Workspaces: one per company, so Cortana never mixes them.
 *
 * Each workspace names the sources that belong to it. Cortana only reads (and,
 * after a spoken yes, acts on) those; the policy gate refuses the rest unless
 * Eli says "across all companies" for that question. Each workspace gets its
 * own conversation (switching starts a fresh one) and its own files folder.
 *
 * The list lives in ~/Documents/Cortana/workspaces.json (JARVIS_WORKSPACES_FILE
 * to move it), outside the app folder so an update never overwrites it. It is
 * plain JSON Eli can edit; "add a workspace called X" adds one by voice.
 *
 *   id          short lowercase name, used in the file and the UI
 *   name        what Eli calls it
 *   accent      a soft tint for the switcher and the orb rim
 *   about       a few lines on the company, read by Cortana
 *   hqUrl       a Claude artifact HQ for this company, or null
 *   services    connector services that belong here: gmail, calendar, notion,
 *               granola, attio, drive, quickbooks, mercury, docusign, klaviyo,
 *               shopify, claudedocs
 *   gmailQuery  a Gmail search that keeps mail to this company ("" for all)
 *   calendars   calendar ids that belong here ([] for all)
 *   notionTeams Notion teamspaces that belong here ([] for all)
 *   filesDir    the one folder Cortana may tidy for this company
 */

export const SERVICES = ['gmail', 'calendar', 'notion', 'granola', 'attio', 'drive', 'quickbooks', 'mercury', 'docusign', 'klaviyo', 'shopify', 'claudedocs']

const docs = (name) => join(homedir(), 'Documents', name)

export const DEFAULT_FILE = join(homedir(), 'Documents', 'Cortana', 'workspaces.json')

export function seedWorkspaces() {
  return {
    active: 'donevia',
    workspaces: [
      {
        id: 'donevia',
        name: 'Donevia',
        accent: '#d9b8f2',
        about:
          'An AI lending and deposit layer for credit unions, based in Des Moines, Iowa. Its customers and ' +
          'pipeline are credit unions; its partners include core and digital-banking providers. Eli runs sales, ' +
          'product and the company. Donevia HQ is his command center: a page on his wall and phone, backed by a ' +
          'database you can read.',
        hqUrl: DEFAULT_HQ_URL,
        services: ['gmail', 'calendar', 'granola', 'notion', 'attio', 'drive', 'quickbooks', 'mercury', 'docusign', 'claudedocs'],
        gmailQuery: '',
        calendars: ['eli@donevia.io'],
        notionTeams: ['DONEVIA', 'DONEVIA - SWE'],
        filesDir: docs('Donevia'),
      },
      {
        id: 'uncertified',
        name: 'Uncertified',
        accent: '#b9d4f2',
        about: "Eli's company at uncertified.co. Its store runs on Shopify.",
        hqUrl: null,
        services: ['shopify', 'klaviyo', 'gmail', 'drive', 'notion'],
        gmailQuery: 'uncertified.co',
        calendars: [],
        notionTeams: ['UNCERTIFIED HQ'],
        filesDir: docs('Uncertified'),
      },
      {
        id: '127-group',
        name: '127 Group',
        accent: '#c8f0dc',
        about: 'Placeholder. Tell Cortana what 127 Group does, or edit this line in workspaces.json.',
        hqUrl: null,
        services: ['gmail', 'drive', 'notion'],
        gmailQuery: '127group.io',
        calendars: [],
        notionTeams: [],
        filesDir: docs('127 Group'),
      },
    ],
  }
}

const slug = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)

/** Clean one workspace from the file; anything unknown or malformed is dropped. */
export function normalizeWorkspace(w) {
  if (!w || typeof w !== 'object') return null
  const name = String(w.name ?? '').trim().slice(0, 60)
  const id = slug(w.id || name)
  if (!name || !id) return null
  const list = (v) => (Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean).slice(0, 50) : [])
  return {
    id,
    name,
    accent: /^#[0-9a-f]{6}$/i.test(String(w.accent ?? '')) ? w.accent : '#d9b8f2',
    about: String(w.about ?? '').slice(0, 2000),
    hqUrl: typeof w.hqUrl === 'string' && /^https:\/\/claude\.ai\//.test(w.hqUrl) ? w.hqUrl : null,
    services: list(w.services).map((s) => s.toLowerCase()).filter((s) => SERVICES.includes(s)),
    gmailQuery: String(w.gmailQuery ?? '').slice(0, 200),
    calendars: list(w.calendars),
    notionTeams: list(w.notionTeams),
    filesDir: typeof w.filesDir === 'string' && w.filesDir.startsWith('/') ? w.filesDir : docs(name.replace(/[/\\:]/g, ' ')),
  }
}

export function normalizeAll(data) {
  const seen = new Set()
  const workspaces = (Array.isArray(data?.workspaces) ? data.workspaces : [])
    .map(normalizeWorkspace)
    .filter((w) => w && !seen.has(w.id) && seen.add(w.id))
  if (!workspaces.length) return seedWorkspaces()
  const active = workspaces.some((w) => w.id === data.active) ? data.active : workspaces[0].id
  return { active, workspaces }
}

/** Read the file, writing the seed first if there is none. A broken file falls back to the seed without overwriting it. */
export function loadWorkspaces(file = DEFAULT_FILE) {
  try {
    if (!existsSync(file)) {
      const seed = seedWorkspaces()
      saveWorkspaces(seed, file)
      return seed
    }
    return normalizeAll(JSON.parse(readFileSync(file, 'utf8')))
  } catch (err) {
    console.warn(`[jarvis] ${file} could not be read (${err.message}); using the built-in workspaces.`)
    return seedWorkspaces()
  }
}

export function saveWorkspaces(data, file = DEFAULT_FILE) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
}

/** The workspace Eli means by a spoken name: exact, then prefix, then "contains". */
export function findWorkspace(list, spoken) {
  const want = slug(spoken).replace(/-/g, '')
  if (!want) return null
  const key = (w) => [slug(w.id).replace(/-/g, ''), slug(w.name).replace(/-/g, '')]
  return (
    list.find((w) => key(w).includes(want)) ??
    list.find((w) => key(w).some((k) => k.startsWith(want) || want.startsWith(k))) ??
    list.find((w) => key(w).some((k) => k.includes(want))) ??
    null
  )
}

/**
 * Workspace commands the bridge answers itself, never the model:
 * "switch to Uncertified", "which workspace am I in", "list my workspaces",
 * "add a workspace called Acme".
 */
export function workspaceCommand(text) {
  const t = String(text ?? '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/^(?:hey |ok |okay )?(?:cortana|kortana)[ ,.]*/, '')
    .replace(/[.!?]+$/, '')
    .trim()
  let m = /^(?:please )?(?:add|create|make|set up|new)(?: a)?(?: new)? workspace(?: called| named| for)? (.{1,60})$/.exec(t)
  if (m) return { type: 'add', name: m[1].replace(/^(?:called|named) /, '').trim() }
  if (/^(?:which|what) (?:workspace|company)(?: am i in| are we in| is this)?$|^where am i$/.test(t)) return { type: 'which' }
  if (/^(?:list|show|what are)(?: me)?(?: all)? (?:my |the )?workspaces$/.test(t)) return { type: 'list' }
  m = /^(?:please )?(?:switch|change|go|move)(?: over)?(?: to| into)(?: the)? (.{1,60}?)(?: workspace)?$/.exec(t)
  if (m) return { type: 'switch', name: m[1].trim() }
  m = /^(?:open|use)(?: the)? (.{1,60}?) workspace$/.exec(t)
  if (m) return { type: 'switch', name: m[1].trim() }
  return null
}

/** "Across all companies" opens every workspace's sources for that one question. */
export const acrossAll = (text) => /\bacross (?:all|every|both)(?: of)?(?: my)? (?:companies|workspaces|businesses)\b/i.test(String(text ?? ''))

export function addWorkspace(data, name) {
  const w = normalizeWorkspace({ name, services: ['gmail', 'drive', 'notion'], about: `Placeholder. Tell Cortana what ${name} does, or edit workspaces.json.` })
  if (!w) return { data, added: null, why: 'That name did not work.' }
  if (data.workspaces.some((x) => x.id === w.id)) return { data, added: null, why: `There is already a ${w.name} workspace.` }
  return { data: { ...data, workspaces: [...data.workspaces, w] }, added: w, why: '' }
}
