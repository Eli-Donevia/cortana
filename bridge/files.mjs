import { lstat, mkdir, readdir, realpath, rename } from 'node:fs/promises'
import { existsSync, mkdirSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

/**
 * Cortana's hands in one folder on the Mac (default ~/Documents/Donevia,
 * JARVIS_FILES_DIR to change it).
 *
 *   files_list    what is in a folder: names, kinds, sizes, dates. Never contents.
 *   files_move    move or rename one file or folder. Never over an existing one.
 *   files_mkdir   make a folder.
 *   files_trash   "delete": move it into the Trash (Cortana) folder at the top of
 *                 the sandbox, which Eli empties himself. Nothing is ever deleted.
 *
 * Every path is resolved inside the sandbox, through real paths, so "..",
 * absolute paths and symlinks cannot point outside it, and symlinks themselves
 * are never moved. Move, mkdir and trash only run after Eli's spoken yes: the
 * policy gate sends them through bridge/confirm.mjs like any other action.
 * Nothing here reads, uploads or runs a file.
 */

export const TRASH = 'Trash (Cortana)'

/** Make the sandbox folder if it is missing; returns its real path. */
export function ensureRoot(root) {
  if (!existsSync(root)) mkdirSync(root, { recursive: true })
  return root
}

/**
 * Resolve a path Eli or the model gave, relative to the sandbox. Throws with a
 * sentence she can say if it would leave the sandbox.
 * `mustExist` false allows the last segment (a move target, a new folder) to be new.
 */
export async function inside(root, given, { mustExist = true } = {}) {
  const realRoot = await realpath(root)
  const raw = String(given ?? '').trim()
  if (raw.includes('\0')) throw new Error('That path is not valid.')
  if (isAbsolute(raw) || raw.startsWith('~')) throw new Error('Give paths inside the Donevia folder, not from the top of the Mac.')
  const target = resolve(realRoot, raw || '.')
  const within = (p) => p === realRoot || p.startsWith(realRoot + sep)
  if (!within(target)) throw new Error('That is outside the Donevia folder.')
  // The parent must exist and really be inside (no symlinked folders on the way).
  const parent = target === realRoot ? realRoot : await realpath(dirname(target)).catch(() => null)
  if (!parent || !within(parent)) throw new Error('That folder does not exist inside the Donevia folder.')
  const full = target === realRoot ? realRoot : join(parent, basename(target))
  const st = await lstat(full).catch(() => null)
  if (st?.isSymbolicLink()) throw new Error('That is a shortcut to somewhere else, so I leave it alone.')
  if (mustExist && !st) throw new Error(`There is no "${raw}" in the Donevia folder.`)
  return { full, rel: relative(realRoot, full) || '.', exists: Boolean(st), isDir: Boolean(st?.isDirectory()) }
}

export async function listFolder(root, path = '.') {
  const at = await inside(root, path)
  if (!at.isDir) throw new Error(`"${at.rel}" is a file, not a folder.`)
  const names = (await readdir(at.full)).filter((n) => !n.startsWith('.')).sort((a, b) => a.localeCompare(b))
  const rows = []
  for (const n of names.slice(0, 200)) {
    const st = await lstat(join(at.full, n)).catch(() => null)
    if (!st) continue
    const kind = st.isSymbolicLink() ? 'shortcut' : st.isDirectory() ? 'folder' : 'file'
    rows.push({ name: n, kind, size: kind === 'file' ? st.size : undefined, modified: st.mtime.toISOString().slice(0, 10) })
  }
  return { folder: at.rel, items: rows, more: Math.max(0, names.length - 200) }
}

export async function moveItem(root, from, to) {
  const a = await inside(root, from)
  if (a.full === (await realpath(root))) throw new Error('I cannot move the Donevia folder itself.')
  let b = await inside(root, to, { mustExist: false })
  // Moving into an existing folder keeps the name.
  if (b.exists && b.isDir) b = await inside(root, join(b.rel, basename(a.full)), { mustExist: false })
  if (b.exists) throw new Error(`"${b.rel}" already exists, so I did not overwrite it.`)
  if (b.full.startsWith(a.full + sep)) throw new Error('A folder cannot go inside itself.')
  await rename(a.full, b.full)
  return { from: a.rel, to: b.rel }
}

export async function makeFolder(root, path) {
  const b = await inside(root, path, { mustExist: false })
  if (b.exists) throw new Error(`"${b.rel}" already exists.`)
  await mkdir(b.full)
  return { made: b.rel }
}

export async function trashItem(root, path) {
  const a = await inside(root, path)
  if (a.rel === '.' || a.rel === TRASH || a.rel.startsWith(TRASH + sep)) throw new Error('That is already in the trash folder, or is the trash folder.')
  const real = await realpath(root)
  await mkdir(join(real, TRASH), { recursive: true })
  let name = basename(a.full)
  if (existsSync(join(real, TRASH, name))) name = `${Date.now()} ${name}`
  await rename(a.full, join(real, TRASH, name))
  return { trashed: a.rel, into: join(TRASH, name) }
}

const say = (text) => ({ content: [{ type: 'text', text }] })
const fail = (err) => ({ content: [{ type: 'text', text: String(err?.message ?? err) }], isError: true })

/** The in-process MCP server. Its write tools are gated by the policy before they run. */
export function filesServer(root) {
  ensureRoot(root)
  const where = `the Donevia folder (${root.replace(/^\/Users\/[^/]+/, '~')})`
  return createSdkMcpServer({
    name: 'jarvis_files',
    version: '1.0.0',
    instructions: `Files in ${where} only. Paths are relative to that folder. You can list, move, rename, make folders and move things to "${TRASH}". You can never read, open, upload or truly delete a file.`,
    tools: [
      tool(
        'files_list',
        `List a folder inside ${where}: names, kinds, sizes and dates, never contents. path is relative ("." for the top).`,
        { path: z.string().optional() },
        async (a) => {
          try {
            return say(JSON.stringify(await listFolder(root, a.path ?? '.')))
          } catch (e) {
            return fail(e)
          }
        },
      ),
      tool(
        'files_move',
        `Move or rename one file or folder inside ${where}. "to" may be a new name or an existing folder. Never overwrites. Needs Eli's spoken yes.`,
        { from: z.string(), to: z.string() },
        async (a) => {
          try {
            const r = await moveItem(root, a.from, a.to)
            return say(`Moved ${r.from} to ${r.to}.`)
          } catch (e) {
            return fail(e)
          }
        },
      ),
      tool(
        'files_mkdir',
        `Make a new folder inside ${where}. Needs Eli's spoken yes.`,
        { path: z.string() },
        async (a) => {
          try {
            return say(`Made the folder ${(await makeFolder(root, a.path)).made}.`)
          } catch (e) {
            return fail(e)
          }
        },
      ),
      tool(
        'files_trash',
        `"Delete" a file or folder inside ${where}: it is moved to "${TRASH}" for Eli to empty himself. Needs Eli's spoken yes.`,
        { path: z.string() },
        async (a) => {
          try {
            const r = await trashItem(root, a.path)
            return say(`Moved ${r.trashed} to ${TRASH}. Eli empties that folder himself.`)
          } catch (e) {
            return fail(e)
          }
        },
      ),
    ],
  })
}
