/**
 * The tool gate for Donevia Jarvis.
 *
 * Deny by default. A voice assistant cannot ask "are you sure", so the bridge
 * has to be the one that is sure. Every tool call the model makes passes
 * through `decideTool(name, input)` twice: once in a PreToolUse hook (which
 * runs first and whose deny wins in every permission mode) and once in
 * canUseTool (the last gate). Both call the same pure function, so the unit
 * tests in test/policy.test.mjs cover exactly what runs.
 *
 * What is allowed, and nothing else:
 *   1. The face itself: mcp__jarvis__display, mcp__jarvis__hq_command (pure,
 *      returns a template), and five mcp__jarvis_ui__ controls.
 *   2. ToolSearch, so deferred tool schemas can load.
 *   3. The Donevia HQ database through ArtifactData (or Artifact read_db /
 *      write_db), and only for the HQ artifact URL:
 *        - reads (get, list, query, profiles) on any collection;
 *        - writes ONLY to commands/{id}: create one new command doc whose
 *          text is one of a closed list of HQ display intents (COMMAND_INTENTS),
 *          or cancel one Jarvis created. Never a batch. Nothing else, ever.
 *   4. Read-only tools on the connectors HQ already reads (Gmail, Calendar,
 *      Granola, Notion, Attio, Drive), from an explicit allowlist.
 *
 * Explicitly refused, with a reason the model can say out loud:
 *   - Bash, Write, Edit, MultiEdit, NotebookEdit and the other local tools.
 *   - WebFetch, WebSearch and anything else that sends data off the machine.
 *   - Any connector tool whose name sends, drafts, creates, updates, deletes,
 *     labels, trashes, forwards, replies or responds.
 *   - Whole servers outside Donevia's scope: Mercury, QuickBooks, Docusign,
 *     Klaviyo, Shopify.
 *
 * Actions, only after Eli's spoken yes (bridge/confirm.mjs): Gmail
 * create_draft (never send: Eli sends drafts himself); Calendar create_event,
 * update_event and respond_to_event; Notion create and update page; HQ
 * set/update on commitments/*, tasks/* and hub/today. Each is refused the
 * first time with a readback, and runs once only after Eli says yes to that
 * exact call. HQ docs Eli set by hand (done_by "manual", source "Added in HQ",
 * a locked hub/today) are never changed, and an HQ doc must be read before it
 * is written so that can be checked. The researcher subagent never acts.
 *
 * Sending, replying, deletes, trash, labels, spam, forwarding, sharing, Attio
 * writes, money and shell stay refused whatever is said. JARVIS_ALLOW_WRITES
 * from upstream is gone and is ignored if set.
 */

import { CONFIRM_WRITES, HQ_CONFIRM, protectedReason } from './confirm.mjs'

export const DEFAULT_HQ_URL = 'https://claude.ai/artifact/9kR9ivs2MuG5joRDSzWuo3'

/** The only collection Jarvis may write to. HQ reads it as the command queue. */
export const COMMAND_COLLECTION = 'commands'

/** Ids Jarvis creates: "jv" plus 8 to 24 lowercase letters or digits. */
export const COMMAND_ID = /^jv[a-z0-9]{8,24}$/

/** Fields a companion command may carry (v7 CONTRACTS: commands/{id}). */
export const COMMAND_FIELDS = new Set(['id', 'text', 'at', 'from', 'to', 'status', 'quiet'])

export const COMMAND_MAX_TEXT = 600

/** A command's "at" must be within this much of the bridge clock. */
export const COMMAND_SKEW_MS = 2 * 60_000

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/

/**
 * The only things Jarvis may ask HQ to do: put a view on screen or change the
 * scene. HQ runs a command's text through its full router, as if Eli had typed
 * it, and that router can also queue agent tasks and fire the cloud agent. So
 * the text is held to this closed, anchored list: no free text ever reaches
 * HQ from Jarvis, and a prompt-injected email cannot turn the one write into
 * "queue a task" or "dispatch now". Each phrase is one HQ v7 already matches
 * (src/brain/intents.js) and only shows or focuses something.
 */
export const COMMAND_INTENTS = [
  'brief me',
  "what's next",
  "what's on today",
  'what do i owe',
  'who owes me',
  "who's waiting",
  'what needs me',
  'what now',
  "how's the pipeline",
  'what did i miss',
  'show pipeline',
  'show build',
  'show backlog',
  'show partners',
  'show events',
  'focus mode',
  'wall mode',
  'ambient',
  'back to work',
]

/** Commands that take an organisation name: "fly to NOFFCU", "where are we with Truity". */
const ORG_INTENTS = [/^fly to (.+)$/, /^where are we with (.+)$/]

/**
 * An org name: one to five words of letters, single spaces, at most 40
 * characters. Hyphens, apostrophes and dots only inside a word ("o'brien",
 * "co-op", "c.u"), "&" only as a word of its own. No digits, so the one write cannot
 * carry a code or an account number out of an email into HQ.
 */
const ORG_WORD = "[a-z]+(?:['.-][a-z]+)*"
const ORG_NAME = new RegExp(`^${ORG_WORD}(?: (?:&|${ORG_WORD})){0,4}$`)
const ORG_MAX = 40

/** Words that never belong in an org name, so "fly to dispatch now" is refused. */
const ORG_STOPWORDS = new Set([
  'task', 'tasks', 'job', 'queue', 'dispatch', 'run', 'send', 'email', 'forward', 'reply',
  'draft', 'delete', 'agent', 'agents', 'atlas', 'closer', 'envoy', 'herald', 'scout', 'forge',
  'and', 'then', 'also', 'please',
])

/** Lowercase, straight apostrophes, single spaces, no trailing punctuation. */
export function normalizeCommand(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?\s]+$/, '')
}

/**
 * The HQ command for this text, normalized, or null if it is not one of the
 * display intents. Used by the gate and by the hq_command helper.
 */
export function commandIntent(text) {
  if (typeof text !== 'string' || text.length > COMMAND_MAX_TEXT) return null
  const t = normalizeCommand(text)
  if (COMMAND_INTENTS.includes(t)) return t
  for (const re of ORG_INTENTS) {
    const m = re.exec(t)
    if (!m) continue
    const org = m[1].trim()
    if (org.length > ORG_MAX || !ORG_NAME.test(org)) return null
    // Split on anything that is not a letter, so "noffcu.dispatch" or
    // "co-run" still shows its stopword.
    if (org.split(/[^a-z]+/).some((w) => ORG_STOPWORDS.has(w))) return null
    return t
  }
  return null
}

/** Spoken list for refusals and tool descriptions. */
export const COMMAND_EXAMPLES = `${COMMAND_INTENTS.map((c) => `"${c}"`).join(', ')}, "fly to <org>", "where are we with <org>"`

/** Upstream's in-process display and interface servers. */
const FACE_TOOLS = new Set([
  'mcp__jarvis__display',
  'mcp__jarvis__hq_command',
  'mcp__jarvis_ui__ui_theme',
  'mcp__jarvis_ui__ui_reactor',
  'mcp__jarvis_ui__ui_effect',
  'mcp__jarvis_ui__ui_screen',
  'mcp__jarvis_ui__ui_reset',
])

const ALLOWED_BUILTINS = new Set(['ToolSearch'])

/** File changes in the sandbox folder; each needs a spoken yes. */
const FILE_WRITES = new Set(['files_move', 'files_mkdir', 'files_trash'])

/**
 * Built-ins that are named here so the refusal says why. Everything not
 * allowed is refused anyway; this list only changes the wording.
 */
export const LOCAL_WRITE_BUILTINS = new Set([
  'Bash', 'BashOutput', 'KillShell', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  'TaskStop', 'TaskOutput', 'Monitor', 'CronCreate', 'CronDelete',
])
export const NETWORK_BUILTINS = new Set(['WebFetch', 'WebSearch', 'SendMessage', 'PushNotification'])

/**
 * Canonical service for an MCP server segment. Covers claude.ai connectors
 * (`mcp__claude_ai_Google_Calendar__list_events`) and servers from
 * ~/.claude.json (`mcp__notion__notion-search`, `mcp__gcal__list_events`).
 */
const SERVICE_ALIASES = {
  gmail: 'gmail',
  googlemail: 'gmail',
  googlecalendar: 'calendar',
  calendar: 'calendar',
  gcal: 'calendar',
  granola: 'granola',
  notion: 'notion',
  attio: 'attio',
  googledrive: 'drive',
  drive: 'drive',
  gdrive: 'drive',
  docusign: 'docusign',
  mercury: 'mercury',
  intuitquickbooks: 'quickbooks',
  quickbooks: 'quickbooks',
  qbo: 'quickbooks',
  klaviyo: 'klaviyo',
  shopify: 'shopify',
  claudedocs: 'claudedocs',
}

/** Services Jarvis may read from, tool by tool. Exact names only. */
export const READ_ALLOW = {
  gmail: ['search_threads', 'get_thread', 'get_message', 'list_labels'],
  calendar: ['list_events', 'search_events', 'get_event', 'list_calendars'],
  granola: [
    'list_meetings', 'get_meetings', 'get_meeting_transcript',
    'query_granola_meetings', 'list_meeting_folders', 'get_account_info',
  ],
  notion: [
    'notion-search', 'notion-fetch', 'notion-query-data-sources',
    'notion-query-meeting-notes', 'notion-get-users', 'notion-get-self',
  ],
  attio: [
    'search-records', 'list-records', 'get-records-by-ids', 'list-objects',
    'list-lists', 'list-records-in-list', 'list-tasks', 'get-note-body',
    'search-meetings', 'semantic-search-notes', 'semantic-search-emails',
    'semantic-search-call-recordings', 'list-attribute-definitions', 'whoami',
  ],
  drive: ['search_files', 'get_file_metadata', 'list_recent_files', 'read_file_content'],
  // Read-only, added when Eli asked for every connector (Oct 16). Writes on
  // these stay off until he approves them one by one. Deliberately left out:
  // card numbers, statements, attachments, payroll, lending, raw GraphQL.
  quickbooks: [
    'company_info', 'profit_loss_quickbooks_account', 'profit_loss_quickbooks_account_text',
    'cash_flow_quickbooks_account', 'cash_flow_quickbooks_account_text',
    'qbo_accounting_get_ap_aging_summary', 'qbo_accounting_get_ar_aging_summary',
    'qbo_accounting_get_ar_aging_summary_text', 'qbo_accounting_get_balance_sheet',
    'qbo_accounting_get_balance_sheet_text', 'qbo_accounting_get_sales_by_customer_summary',
    'qbo_accounting_get_sales_by_customer_summary_text', 'qbo_accounting_get_sales_by_product_summary',
    'qbo_accounting_get_sales_by_product_summary_text', 'qbo_accounting_get_product_service_list',
    'qbo_sales_get_invoices', 'qbo_sales_get_estimates', 'qbo_contact_search_customer',
    'qbo_catalog_search_products',
  ],
  mercury: [
    'getAccounts', 'getAccount', 'getCashflowSummary', 'getCurrentDate', 'listTransactions',
    'getTransaction', 'getTransactionById', 'getTreasury', 'listInvoices', 'getInvoice',
    'listCustomers', 'getCustomer', 'getOrganization', 'listCategories',
  ],
  docusign: [
    'getEnvelopes', 'getEnvelope', 'listRecipients', 'listEnvelopeDocuments', 'getTemplates',
    'getAllAgreements', 'getAgreementDetails', 'getUserInfo',
  ],
  klaviyo: [
    'get_account_details', 'get_campaigns', 'get_campaign', 'get_campaign_report', 'get_flows',
    'get_flow', 'get_flow_report', 'get_lists', 'get_list', 'get_segments', 'get_segment',
    'get_metrics', 'get_metric', 'query_metric_aggregates',
  ],
  shopify: [
    'get-shop-info', 'list-orders', 'get-order', 'search_products', 'get-product', 'list-customers',
    'get-inventory-levels', 'search_collections', 'get-collection',
  ],
  claudedocs: ['read', 'query'],
}

/** Whole servers that are out of scope for the companion. None, now: each service is held to READ_ALLOW. */
export const BLOCKED_SERVICES = new Set([])

/** Every service the companion knows by name (for disallowedTools and detection). */
export const KNOWN_SERVICES = new Set(Object.keys(READ_ALLOW))

/**
 * Word tokens that mark a tool as acting on the world. Matched as whole
 * tokens of the tool name (split on _ - and camelCase), so `list_labels` is a
 * read that names labels and `label_thread` is a write.
 */
const WRITE_TOKENS = new Set([
  'send', 'draft', 'drafts', 'create', 'update', 'delete', 'label', 'unlabel', 'trash',
  'untrash', 'forward', 'reply', 'respond', 'remove', 'edit', 'write', 'move',
  'merge', 'upsert', 'add', 'archive', 'spam', 'share', 'copy', 'upload', 'publish',
  'cancel', 'pause', 'resume', 'trigger', 'start', 'stop', 'set', 'assign', 'tag',
  'subscribe', 'unsubscribe', 'import', 'duplicate', 'restore', 'mark', 'unmark',
  'apply', 'bulk', 'submit', 'save', 'post', 'pay', 'transfer', 'sign', 'invite',
  'suggest', 'run', 'spawn', 'download', 'convert',
])

/** Of those, the ones that make a name a write even after a read verb. */
const HARD_WRITE_TOKENS = new Set([
  'send', 'create', 'update', 'delete', 'trash', 'forward', 'reply', 'respond',
  'remove', 'upsert', 'merge', 'apply', 'mark', 'move', 'share', 'upload', 'publish',
])

const READ_VERBS = new Set(['get', 'list', 'search', 'query', 'fetch', 'read', 'semantic', 'whoami'])

/** `notion-query-data-sources` -> ['notion','query','data','sources']; `getAccount` -> ['get','account']. */
export function tokens(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/** `mcp__claude_ai_Google_Calendar__list_events` -> { server: 'claude_ai_Google_Calendar', tool: 'list_events' } */
export function splitMcp(name) {
  if (typeof name !== 'string' || !name.startsWith('mcp__')) return null
  const parts = name.split('__')
  if (parts.length < 3) return null
  return { server: parts[1], tool: parts.slice(2).join('__') }
}

/** Server segment -> canonical service, or null for anything unknown. */
export function serviceOf(server) {
  const key = String(server)
    .replace(/^claude[._ ]?ai[._ ]?/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
  return SERVICE_ALIASES[key] ?? null
}

/** Is this connector tool name a write, judged by its words alone? */
export function looksLikeWrite(tool) {
  const words = tokens(tool)
  // Notion prefixes every tool with its own name; skip it so the verb is read.
  const verbAt = words[0] === 'notion' ? 1 : 0
  const startsWithRead = READ_VERBS.has(words[verbAt])
  for (const w of words) {
    if (HARD_WRITE_TOKENS.has(w)) return w
    if (!startsWithRead && WRITE_TOKENS.has(w)) return w
  }
  return null
}

/** The artifact id in a claude.ai artifact link, or null. */
export function artifactId(url) {
  const m = /^https:\/\/claude\.ai\/(?:code\/)?artifact\/([A-Za-z0-9_-]+)\/?(?:[?#].*)?$/.exec(
    String(url ?? '').trim(),
  )
  return m ? m[1] : null
}

const allow = (reason = 'allowed') => ({ allow: true, reason })
const deny = (reason) => ({ allow: false, reason })

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** True if any value at any depth is the {"__delete__": true} field remover. */
function hasDeleteMarker(value) {
  if (Array.isArray(value)) return value.some(hasDeleteMarker)
  if (!isPlainObject(value)) return false
  if (value.__delete__ === true) return true
  return Object.values(value).some(hasDeleteMarker)
}

/**
 * One write to commands/{id}: a set (create) or an update (cancel only).
 * `w` holds collection, doc_id, data, file_path, if_version.
 * `opts.now` is the clock (tests); `opts.issued`, when given, maps each id
 * hq_command handed out in this session to the exact text it issued with it.
 * Nothing else may be written, and a create must carry that same text.
 */
export function checkCommandWrite(op, w, opts = {}) {
  if (w.collection !== COMMAND_COLLECTION) {
    return deny(`Jarvis may only write to ${COMMAND_COLLECTION}/; "${w.collection ?? '(none)'}" is read-only.`)
  }
  if (typeof w.doc_id !== 'string' || !COMMAND_ID.test(w.doc_id)) {
    return deny('Command ids must look like "jv" plus 8 to 24 lowercase letters or digits. Use the hq_command tool to get one.')
  }
  if (opts.issued && !opts.issued.has(w.doc_id)) {
    return deny('That command id was not issued in this conversation. Use the hq_command tool to get one.')
  }
  if (w.file_path !== undefined) return deny('Commands must be written inline, not from a file.')
  if (!isPlainObject(w.data)) return deny('A command write needs a data object.')
  if (hasDeleteMarker(w.data)) return deny('Removing fields from a command is not allowed.')
  const d = w.data

  if (op === 'set') {
    if (w.if_version !== undefined) {
      return deny('Commands are create-only: a set must not carry if_version (it would overwrite an existing command).')
    }
    for (const k of Object.keys(d)) {
      if (!COMMAND_FIELDS.has(k)) return deny(`Command field "${k}" is not part of the commands/{id} shape.`)
    }
    if (d.id !== w.doc_id) return deny('A command\'s data.id must equal its doc_id.')
    if (d.from !== 'companion') return deny('Commands from Jarvis must say from: "companion".')
    if (d.status !== 'new') return deny('A new command must have status "new".')
    if (typeof d.text !== 'string' || !d.text.trim()) return deny('A command needs non-empty text.')
    if (d.text.length > COMMAND_MAX_TEXT) return deny(`Command text is limited to ${COMMAND_MAX_TEXT} characters.`)
    if (!commandIntent(d.text)) {
      return deny(`HQ commands from Jarvis are limited to display commands: ${COMMAND_EXAMPLES}.`)
    }
    if (typeof d.at !== 'string' || !ISO_TIME.test(d.at)) return deny('A command needs "at" as an ISO timestamp.')
    const now = opts.now ?? Date.now()
    if (Math.abs(Date.parse(d.at) - now) > COMMAND_SKEW_MS) {
      return deny('A command\'s "at" must be the current time. Use the hq_command tool to get one.')
    }
    if (opts.issued instanceof Map && d.text !== opts.issued.get(w.doc_id)) {
      return deny('A command\'s text must be exactly what hq_command issued with its id.')
    }
    // HQ addresses peers with "to"; Jarvis always writes to the room, so the
    // field carries nothing (and cannot carry free text into HQ).
    if (d.to !== undefined && d.to !== null) return deny('"to" must be left out (or null) on commands from Jarvis.')
    if (d.quiet !== undefined && typeof d.quiet !== 'boolean') return deny('"quiet" must be true or false.')
    return allow('create commands/' + w.doc_id)
  }

  if (op === 'update') {
    // The only change Jarvis may make to a command is to cancel it. Setting
    // status back to "new" would re-run an old one; changing text would turn
    // a display command into something else.
    const keys = Object.keys(d)
    if (keys.length !== 1 || keys[0] !== 'status' || d.status !== 'cancelled') {
      return deny('Jarvis may only cancel a command (data: {"status": "cancelled"}).')
    }
    return allow('cancel commands/' + w.doc_id)
  }

  return deny(`"${op}" is not allowed on the HQ database.`)
}

/** The HQ database. `input` is the ArtifactData input (or Artifact's, remapped). */
/**
 * A change to an HQ doc Cortana may edit after a yes: commitments/*, tasks/*,
 * hub/today. The doc must have been read in this conversation, so a doc Eli
 * set by hand can be recognised and left alone.
 */
function checkHqWrite(name, op, w, opts) {
  const docs = HQ_CONFIRM[w.collection]
  if (typeof w.doc_id !== 'string' || !w.doc_id) return deny('An HQ write needs a doc_id.')
  if (docs && !docs.includes(w.doc_id)) return deny(`In ${w.collection} only ${docs.join(', ')} can be changed.`)
  if (w.file_path !== undefined) return deny('HQ writes must be inline, not from a file.')
  if (!isPlainObject(w.data)) return deny('An HQ write needs a data object.')
  if (hasDeleteMarker(w.data)) return deny('Removing fields from HQ documents is not allowed.')
  if (opts.fromAgent) return deny('Only Cortana herself takes actions, after Eli confirms; the researcher only reads.')
  if (!opts.confirm) return deny('Changing HQ needs Eli to confirm out loud, and that is not available here.')
  const seen = opts.confirm.readOf(w.collection, w.doc_id)
  if (seen == null) {
    return deny(`Read ${w.collection}/${w.doc_id} with a get first, so I can check it is not one Eli set by hand.`)
  }
  const why = protectedReason(w.collection, seen)
  if (why) return deny(why)
  return opts.confirm.check(name, { ...w, action: op }, opts.stage)
}

export function checkDb(input, opts = {}, name = 'ArtifactData') {
  const { hqUrl = DEFAULT_HQ_URL } = opts
  if (!isPlainObject(input)) return deny('Missing tool input.')
  const want = artifactId(hqUrl)
  const got = artifactId(input.url)
  if (!want || got !== want) {
    return deny('Jarvis only reads the Donevia HQ artifact; other artifacts are off limits.')
  }

  const action = input.action
  if (action === 'get' || action === 'list' || action === 'query') {
    if (input.out_dir !== undefined) return deny('Reads must return inline; out_dir would write files to disk.')
    if (input.as_level !== undefined) return deny('as_level is not used by Jarvis.')
    if (typeof input.collection !== 'string' || !input.collection) return deny('A read needs a collection.')
    return allow(`read ${input.collection}`)
  }
  if (action === 'profiles') return allow('read profiles')

  if (action === 'set' || action === 'update') {
    if (input.as_level !== undefined) return deny('as_level is not used by Jarvis.')
    if (Object.hasOwn(HQ_CONFIRM, input.collection)) return checkHqWrite(name, action, input, opts)
    return checkCommandWrite(action, input, opts)
  }

  if (action === 'batch') {
    // One command at a time. A batch could fill HQ's 20-command window and
    // push the phone's commands out of it.
    return deny('Batches are not allowed; write one command at a time with hq_command.')
  }

  if (action === 'delete') return deny('Deleting from the HQ database is not allowed.')
  if (action === 'str_replace') return deny('Editing HQ documents in place is not allowed; Jarvis writes only new commands.')
  return deny(`Database action "${action ?? '(none)'}" is not allowed.`)
}

/**
 * The single decision. Returns { allow, reason }. `opts.hqUrl` overrides the
 * HQ link (env DONEVIA_HQ_URL); `opts.issued` and `opts.now` are described at
 * checkCommandWrite.
 */
export function decideTool(name, input, opts = {}) {
  if (typeof name !== 'string' || !name) return deny('Unnamed tool.')

  if (FACE_TOOLS.has(name)) return allow('display')
  if (ALLOWED_BUILTINS.has(name)) return allow('tool search')

  // Agent only to hand a question to the researcher (bridge/probe.mjs), in the
  // foreground. Its tool calls come back through this same gate.
  if (name === 'Agent') {
    if (!isPlainObject(input) || input.subagent_type !== 'researcher') {
      return deny('The only agent is "researcher".')
    }
    if (input.run_in_background) return deny('The researcher runs in the foreground only.')
    return allow('researcher')
  }

  if ((name === 'ArtifactData' || name === 'Artifact') && opts.workspace && !opts.workspace.hqUrl && !opts.acrossAll) {
    return deny(`The ${opts.workspace.name} workspace has no HQ.`)
  }
  if (name === 'ArtifactData') return checkDb(input, opts, name)
  if (name === 'Artifact') {
    // Some builds expose the database as Artifact with action read_db/write_db
    // and the operation in db_op. Anything else on Artifact (publish, delete,
    // pin...) is refused.
    const a = isPlainObject(input) ? input.action : undefined
    if ((a === 'read_db' || a === 'write_db') && typeof input.db_op === 'string') {
      if (a === 'read_db' && !['get', 'list', 'query', 'profiles'].includes(input.db_op)) {
        return deny('read_db only reads.')
      }
      return checkDb({ ...input, action: input.db_op }, opts, name)
    }
    return deny('Publishing or changing artifacts is not allowed; Jarvis only reads HQ and writes commands.')
  }
  if (name === 'ArtifactComments' || name === 'ArtifactCheck') {
    return deny('Artifact comments are off limits to Jarvis.')
  }

  if (LOCAL_WRITE_BUILTINS.has(name)) return deny(`${name} is disabled: Jarvis never runs commands or changes files.`)
  if (NETWORK_BUILTINS.has(name)) return deny(`${name} is disabled: Jarvis answers from HQ and your connectors only.`)

  const mcp = splitMcp(name)
  if (mcp) {
    // Files in the one sandbox folder (bridge/files.mjs): listing is free,
    // every change waits for Eli's spoken yes.
    if (mcp.server === 'jarvis_files') {
      if (mcp.tool === 'files_list') return allow('list files')
      if (!FILE_WRITES.has(mcp.tool)) return deny(`${mcp.tool} is not one of the file tools.`)
      if (opts.fromAgent) return deny('Only Cortana herself takes actions, after Eli confirms; the researcher only reads.')
      if (!opts.confirm) return deny(`${mcp.tool} needs Eli to confirm out loud, and that is not available here.`)
      return opts.confirm.check(name, input, opts.stage)
    }
    // What Eli is looking at (bridge/context.mjs): read-only, Cortana only.
    if (mcp.server === 'jarvis_context') {
      if (opts.fromAgent) return deny('Only Cortana looks at the screen.')
      return mcp.tool === 'screen_context' ? allow('screen context') : deny(`${mcp.tool} is not a screen tool.`)
    }
    // Memory (bridge/memory.mjs): Cortana's own notes. Never the researcher or an agent.
    if (mcp.server === 'jarvis_memory') {
      if (opts.fromAgent) return deny('Only Cortana keeps notes.')
      if (['memory_save', 'memory_search', 'memory_forget'].includes(mcp.tool)) return allow('memory')
      return deny(`${mcp.tool} is not a memory tool.`)
    }
    if (mcp.server === 'jarvis' || mcp.server === 'jarvis_ui') {
      return deny(`${mcp.tool} is not one of Jarvis's display tools.`)
    }
    const service = serviceOf(mcp.server)
    if (!service) return deny(`The ${mcp.server} server is not one Jarvis is allowed to use.`)
    if (BLOCKED_SERVICES.has(service)) return deny(`${service} is out of scope for Jarvis.`)
    // Workspaces: only the active company's own sources, unless Eli said
    // "across all companies" for this question (bridge/workspaces.mjs).
    const ws = opts.workspace
    if (ws && !opts.acrossAll && !ws.services.includes(service)) {
      return deny(`${service} is not part of the ${ws.name} workspace. Switch workspace, or say "across all companies".`)
    }
    if ((CONFIRM_WRITES[service] ?? []).includes(mcp.tool)) {
      if (opts.fromAgent) return deny('Only Cortana herself takes actions, after Eli confirms; the researcher only reads.')
      // Standing permissions (bridge/standing.mjs): the two calendar basics Eli
      // allowed without a spoken yes, checked against the event as read.
      const st = opts.standing?.(name, input)
      if (st?.ok) return { allow: true, reason: `standing: ${st.summary}`, standing: st }
      if (!opts.confirm) return deny(`${mcp.tool} needs Eli to confirm out loud, and that is not available here.`)
      return opts.confirm.check(name, input, opts.stage)
    }
    const verb = looksLikeWrite(mcp.tool)
    if (verb) return deny(`${mcp.tool} would ${verb === 'draft' ? 'create a draft' : verb} in ${service}; connectors are read-only.`)
    if ((READ_ALLOW[service] ?? []).includes(mcp.tool)) return allow(`read ${service}`)
    return deny(`${mcp.tool} is not on the read-only list for ${service}.`)
  }

  return deny(`${name} is not available to Jarvis.`)
}

/** The spoken-safe refusal text handed back to the model. */
export function denyMessage(reason) {
  // A confirmation readback or an agent's queued proposal is an instruction in
  // itself; wrapping it in "you are read-only" told the model the opposite.
  if (/needs Eli's spoken yes|^Queued for Eli/.test(String(reason))) return String(reason)
  return (
    `Blocked by Cortana's safety rules: ${reason} ` +
    'Tell Eli in one short sentence that this one is his to do, and offer the closest thing you can do instead.'
  )
}

/**
 * Built-in tools to hide from the model entirely. "Artifact" is deliberately
 * absent: a rule naming Artifact also matches ArtifactData.
 */
export const DISALLOWED_BUILTINS = [
  'Bash', 'BashOutput', 'KillShell', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  'Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'Skill',
  'TodoWrite', 'TaskStop', 'TaskOutput', 'CronCreate', 'CronDelete', 'CronList',
  'SendMessage', 'PushNotification', 'Monitor', 'ArtifactComments', 'ArtifactCheck',
  'ListMcpResourcesTool', 'ReadMcpResourceTool', 'EnterWorktree', 'ExitWorktree',
  'NotebookRead', 'ExitPlanMode',
]

/** Connector servers to hide from the model entirely, as disallowedTools rules. */
export const DISALLOWED_CONNECTORS = [
  'Claude_Code_Remote', 'github',
].map((s) => `mcp__claude_ai_${s}`)

/**
 * The PreToolUse hook. Runs before permission rules and its deny always
 * wins. Allowed calls return no decision so canUseTool still sees them.
 */
export function makePreToolUseHook(opts = {}, log = () => {}) {
  return async (input) => {
    const name = input?.tool_name
    const verdict = decideTool(name, input?.tool_input, { ...opts, stage: 'hook', fromAgent: Boolean(input?.agent_id) })
    log(name, verdict, 'hook')
    if (verdict.allow) return { continue: true }
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: denyMessage(verdict.reason),
      },
    }
  }
}
