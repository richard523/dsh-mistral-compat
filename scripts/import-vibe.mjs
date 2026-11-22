#!/usr/bin/env bun
/**
 * import-vibe.mjs — import Mistral Vibe CLI chat history into DeepSeek Harness.
 *
 * Reads the Vibe session store (~/.vibe/logs/session) in both on-disk shapes:
 *   - legacy  session_<ts>_<id>/            meta.json + messages.jsonl
 *   - unified unified/<session_id>/          meta.json + chunks/*.json
 * converts every session to the generic ACP chat document format understood by
 * import-acp.mjs, stages the docs, and runs that importer so the chats land in
 * the dsh session store (~/.dsh/sessions) and show up in the web UI history and
 * in ACP session/list of any connected client.
 *
 * After importing, each session is attached to the workspace group whose path
 * matches its working directory (editing ~/.dsh/storages/workspace.json), so
 * chats appear under their project — not in Ungrouped. Paths tombstoned by a
 * workspace deletion are left ungrouped. Run with the dsh web server STOPPED
 * (or restart it afterwards) so the in-memory registry cannot clobber the file.
 *
 * Usage:
 *   bun scripts/import-vibe.mjs [--vibe-home DIR] [--dir WORKDIR]... [--since ISO8601] [--stage DIR] [--with-tools] [--dry-run]
 *
 *   --dir       import only sessions whose working directory equals WORKDIR
 *              (repeatable; default: all projects, grouped by their own cwd)
 *   --since     skip sessions started before this time
 *   --new-only  skip sessions already present in the dsh store: never overwrites a
 *              session that was since resumed/extended inside dsh (safe for repeated runs)
 *   --with-tools  also render tool calls/results as note messages (default: messages only)
 *
 * --new-only LIVE SESSION REFRESH (race safety): a session whose CLI is still
 * running (lock in <vibe-home>/active with a live process id) keeps growing on
 * the Vibe side, but the plain "skip if present" rule would freeze the dsh copy
 * at whatever turn the import caught — mid-turn imports even truncate silently
 * when a chunk file is read mid-write. For live sessions --new-only therefore
 * re-imports the CURRENT state whenever:
 *   - the dsh copy still hashes to the importer's last written snapshot
 *     (~/.dsh/logs/vibe-import.snapshots.json): the hash changes on the first
 *     in-dsh resume (the v4 protected-head swap), so a session that was ever
 *     continued inside dsh is refused forever — clobber protection is
 *     tamper-evident, not assumed;
 *   - and the Vibe chunks grew since that snapshot (no churn when idle);
 *   - and the chunk files are quiescent across the read (mtime+size stable,
 *     4 attempts): a session mid-turn is DEFERRED this run — exit 3, so the
 *   pwa wrapper does not touch its state file and the next window click retries.
 * A store copy imported by an older importer (no snapshot yet) is bootstrapped
 * as un-touched only when file mtimes still equal the projcache's
 * identity.createdAt (the import instant within a small window) — anything
 * later means dsh wrote to it and the session is left alone with a warning.

 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

/** Synchronous ms sleep that works on bun and node alike. */
const sleepMs = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/** Chunk files that failed to parse during a run (visibility, never silent). */
const parseFails = []

/** realpath when the path still exists, else the resolved path (dead cwds import as ungrouped strays). */
const lenientRealpath = p => {
  try { return realpathSync(resolve(p)) } catch { return resolve(p) }
}

const args = process.argv.slice(2)
let vibeHome = join(homedir(), '.vibe/logs/session')
let stage = join('/tmp', `vibe-import-${process.pid}`)
const dirs = []
let since
let withTools = false
let dryRun = false
let newOnly = false
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--vibe-home') vibeHome = resolve(args[++i])
  else if (a === '--dir') dirs.push(lenientRealpath(args[++i]))
  else if (a === '--since') since = Date.parse(args[++i])
  else if (a === '--stage') stage = resolve(args[++i])
  else if (a === '--with-tools') withTools = true
  else if (a === '--new-only') newOnly = true
  else if (a === '--dry-run') dryRun = true
  else { console.error(`unknown arg: ${a}`); process.exit(2) }
}

const textOf = content => {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.filter(c => c?.type === 'text' || typeof c === 'string').map(c => typeof c === 'string' ? c : c.text).join('\n')
  return ''
}

const titleOf = messages => {
  const first = messages.find(m => m.role === 'user')
  const line = (first ? textOf(first.content) : '').split('\n').find(l => l.trim().length > 0) ?? ''
  return line.trim().slice(0, 80)
}

/** Legacy "session_<ts>_<id>/messages.jsonl" -> chat messages. */
function legacyMessages(file, tools) {
  const out = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let m
    try { m = JSON.parse(line) } catch { parseFails.push(basename(file)); continue }
    const text = textOf(m.content)
    if (m.role === 'assistant') {
      let full = text
      if (tools && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        full += (full ? '\n\n' : '') + m.tool_calls.map(tc => {
          const fn = tc.function ?? tc
          return `[tool call: ${fn.name ?? tc.name}]\n${String(fn.arguments ?? tc.arguments ?? '').slice(0, 500)}`
        }).join('\n')
      }
      if (full) out.push({ role: 'assistant', content: full })
    } else if (m.role === 'user') {
      if (text) out.push({ role: 'user', content: text })
    } else if (m.role === 'tool' && tools) {
      if (text) out.push({ role: 'user', content: `[tool result: ${m.name ?? 'tool'}]\n${text.slice(0, 2000)}` })
    }
  }
  return out
}

/** Unified "unified/<id>/chunks" -> chat messages. */
function unifiedMessages(chunkDir, tools) {
  const entries = []
  for (const cf of readdirSync(chunkDir)) {
    if (!cf.endsWith('.json')) continue
    let list
    try { list = JSON.parse(readFileSync(join(chunkDir, cf), 'utf8')) } catch { parseFails.push(cf); continue }
    if (Array.isArray(list)) entries.push(...list)
  }
  entries.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
  const out = []
  for (const e of entries) {
    if (e.type === 'message' && (e.role === 'user' || e.role === 'assistant')) {
      const text = textOf(e.content)
      if (text) out.push({ role: e.role, content: text })
    } else if (tools && e.detail?.kind === 'tool' && e.generationStatus === 'completed') {
      const name = e.detail.toolName ?? e.detail.display?.summary ?? 'tool'
      out.push({ role: 'user', content: `[tool: ${name}]` })
    }
  }
  return out
}

/**
 * Whether the session's CLI still holds its lock (live process). kill(pid,0)
 * alone cannot tell a reused pid from the real CLI, so on Linux the holder's
 * /proc cmdline must also look like the vibe CLI ("vibe-acp" etc). Sessions
 * whose lock holder is gone are NOT live: refresh stops with them, which is
 * the handoff point where the dsh copy becomes the frozen record.
 */
function lockedLive(id) {
  try {
    const lock = JSON.parse(readFileSync(join(vibeHome, 'active', `${id}.lock.json`), 'utf8'))
    const pid = lock.process_id
    if (!Number.isInteger(pid) || pid <= 0) return false
    process.kill(pid, 0) // throws when the process is gone
    const cmdline = readFileSync(join('/proc', String(pid), 'cmdline'), 'utf8')
    return /vibe/i.test(cmdline)
  } catch { /* no lock, dead pid, reused pid, or unreadable /proc: not live */ }
  return false
}

/** Collect every Vibe session as { id, cwd, startTime, live, filesOf, load }. */
function collect() {
  const sessions = new Map() // session_id -> chat source (unified wins over legacy)
  const legacyRoot = vibeHome
  if (existsSync(legacyRoot)) {
    for (const entry of readdirSync(legacyRoot)) {
      const dir = join(legacyRoot, entry)
      if (!entry.startsWith('session_') || !statSync(dir).isDirectory()) continue
      const metaPath = join(dir, 'meta.json')
      const messagesPath = join(dir, 'messages.jsonl')
      if (!existsSync(metaPath) || !existsSync(messagesPath)) continue
      let meta
      try { meta = JSON.parse(readFileSync(metaPath, 'utf8')) } catch { continue }
      const id = meta.session_id
      if (!id || sessions.has(id)) continue
      const cwd = meta.environment?.working_directory
      if (!cwd) continue
      sessions.set(id, { id, cwd, startTime: Date.parse(meta.start_time ?? '') || 0, live: lockedLive(id), filesOf: () => [messagesPath], load: () => legacyMessages(messagesPath, withTools) })
    }
  }
  const unifiedRoot = join(vibeHome, 'unified')
  if (existsSync(unifiedRoot)) {
    for (const entry of readdirSync(unifiedRoot)) {
      const dir = join(unifiedRoot, entry)
      if (!statSync(dir).isDirectory()) continue
      const metaPath = join(dir, 'meta.json')
      const chunkDir = join(dir, 'chunks')
      if (!existsSync(metaPath) || !existsSync(chunkDir)) continue
      let meta
      try { meta = JSON.parse(readFileSync(metaPath, 'utf8')) } catch { continue }
      const id = meta.session_id ?? entry
      const cwd = meta.environment?.working_directory
      if (!cwd) continue
      sessions.set(id, { id, cwd, startTime: Date.parse(meta.start_time ?? '') || 0, live: lockedLive(id), filesOf: () => readdirSync(chunkDir).filter(f => f.endsWith('.json')).map(f => join(chunkDir, f)), load: () => unifiedMessages(chunkDir, withTools) })
    }
  }
  return [...sessions.values()]
}

const all = collect()

// Mirrors slugOf()/projectDir() in import-acp.mjs (and projectKey() in
// session-persistence-jsonl/src/format.ts): the on-disk group directory name.
function slugOf(value) {
  let readable = ''
  let separatorRun = false
  for (const ch of value) {
    if (ch === '/' || ch === '\\' || ch === ':') { if (!separatorRun) readable += '-'; separatorRun = true }
    else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) { readable += ch; separatorRun = false }
    else { readable += '~' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'); separatorRun = false }
  }
  return readable.replace(/^-+/, '') || 'root'
}

const sessionsRoot = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')
const snapshotsFile = join(dirname(sessionsRoot), 'logs', 'vibe-import.snapshots.json')

const sha256Of = file => createHash('sha256').update(readFileSync(file)).digest('hex')

/** dsh-side paths of session s, mirroring import-acp.mjs's projectDir(). */
function storePathsOf(s) {
  const dir = join(sessionsRoot, `--${slugOf(lenientRealpath(s.cwd)).slice(0, 251)}--`, `session-${s.id}`)
  return { dir, log: join(dir, 'session.v4.jsonl.zstd') }
}

function readSnapshots() {
  try { return JSON.parse(readFileSync(snapshotsFile, 'utf8')) } catch { return {} }
}

/**
 * Whether a legacy store copy (no snapshot: written by an older importer) is
 * provably untouched by dsh. import-acp stamps identity.createdAt (the import
 * instant) into the plain-JSON projcache alongside the zstd log, and nothing
 * writes those files until the session is RESUMED inside dsh (first resume
 * swaps the v4 protected head and rewrites the log; a UI title edit rewrites
 * the projcache). Any mtime drift beyond the window means dsh wrote to it.
 */
function legacyUntouched(s, logPath) {
  const projPath = join(dirname(sessionsRoot), 'storages', 'session_projcache', 'sessions', `session-${s.id}.json`)
  if (!existsSync(projPath)) return false
  let createdAt
  try { createdAt = JSON.parse(readFileSync(projPath, 'utf8')).record?.identity?.createdAt } catch { return false }
  if (typeof createdAt !== 'number') return false
  try {
    for (const p of [logPath, projPath]) {
      if (Math.abs(statSync(p).mtimeMs - createdAt) > 2000) return false
    }
    return true
  } catch { return false }
}

/**
 * Load a LIVE session's messages only from a quiescent source. A live CLI
 * session mid-turn keeps rewriting chunks; racing the writes only by luck
 * would freeze a truncated copy into the store, so quiescence is OBSERVED
 * over a time fence, not merely inferred from a read. Returns
 * { messages, readAt } with readAt = the observation instant; the snapshot
 * stamps readAt so any write at or after it forces a refresh on the next
 * run. null when the session never goes quiet (deferred).
 */
function stableLoad(s) {
  const fingerprintOf = () => {
    let fp = ''
    for (const f of s.filesOf().sort()) {
      const st = statSync(f)
      fp += `${st.mtimeMs}:${st.size};`
    }
    return fp
  }
  for (let attempt = 1; attempt <= 4; attempt++) {
    const before = fingerprintOf()
    const readAt = Date.now()
    sleepMs(300) // observation fence: a mid-turn writer moves within 300ms
    if (before !== fingerprintOf()) {
      console.error(`  ${s.id}: writes landed during the observation fence (attempt ${attempt}), re-checking`)
      continue
    }
    const messages = s.load()
    if (before !== fingerprintOf()) {
      console.error(`  ${s.id}: source moved mid-read (attempt ${attempt}), re-checking`)
      continue
    }
    return { messages, readAt }
  }
  return null
}

// Pick: new sessions always; in-store LIVE sessions only as a race-safe
// refresh (clobber guard + content-change gate); everything else stays
// protected/skipped exactly like the old --new-only rule.
const snapshots = readSnapshots()
let fresh = 0
let refreshed = 0
let refused = 0
let liveIdle = 0
let deadInStore = 0
const picked = []
for (const s of all) {
  if (dirs.length !== 0 && !dirs.includes(lenientRealpath(s.cwd))) continue
  if (since !== undefined && s.startTime < since) continue
  if (!newOnly) { picked.push(s); fresh++; continue }
  const log = storePathsOf(s).log
  if (!existsSync(log)) { picked.push(s); fresh++; continue }
  if (!s.live) { deadInStore++; continue }
  const snap = snapshots[s.id]
  if (snap) {
    if (sha256Of(log) !== snap.sha) {
      console.error(`  refusing ${s.id}: the dsh copy changed since the import (resumed/extended inside dsh) — not clobbering`)
      refused++
      continue
    }
  } else if (!legacyUntouched(s, log)) {
    console.error(`  refusing ${s.id}: no import snapshot and the dsh copy is not provably untouched — not clobbering`)
    refused++
    continue
  }
  const lastAt = snap?.at ?? Number.NEGATIVE_INFINITY
  const newestSrc = Math.max(0, ...s.filesOf().map(f => statSync(f).mtimeMs))
  if (newestSrc <= lastAt) { liveIdle++; continue }
  picked.push(s)
  refreshed++
}
console.log(`vibe store: ${all.length} session(s); importing ${picked.length} (fresh ${fresh}, live refresh ${refreshed})` + (newOnly ? `; skipped ${refused + liveIdle + deadInStore} in-store (${refused} touched-in-dsh refused, ${deadInStore} cli-not-running, ${liveIdle} live-but-unchanged)` : ''))

if (dryRun) {
  for (const s of picked) console.log(`  would import ${s.id} (${s.live && existsSync(storePathsOf(s).log) ? 'live refresh' : 'new'})  cwd=${s.cwd}  started=${new Date(s.startTime).toISOString()}`)
  process.exit(0)
}

rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })
const docs = []
const deferred = []
const readAtById = new Map()
for (const s of picked) {
  const stable = s.live ? stableLoad(s) : { messages: s.load(), readAt: Date.now() }
  if (stable === null) {
    deferred.push(s.id)
    console.error(`  deferred ${s.id}: the live CLI session is still writing; the next run picks it up`)
    continue
  }
  const { messages, readAt } = stable
  if (messages.length === 0) continue
  const doc = {
    sessionId: `session-${s.id}`,
    cwd: lenientRealpath(s.cwd),
    title: titleOf(messages) || `vibe ${s.id.slice(0, 8)}`,
    messages,
  }
  writeFileSync(join(stage, `${s.id}.json`), JSON.stringify(doc))
  docs.push(doc)
  readAtById.set(s.id, readAt)
}
if (parseFails.length > 0) {
  console.error(`  NOTE: ${parseFails.length} source parse failure(s) were skipped (mid-write or corrupt): ${[...new Set(parseFails)].join(', ')}`)
}
if (docs.length === 0) {
  console.log('nothing to import' + (deferred.length ? `; deferred ${deferred.length} live session(s) mid-write` : ''))
  process.exit(deferred.length ? 3 : 0)
}

// Hand the staged docs to the generic ACP importer (each doc carries its cwd).
const importer = join(import.meta.dirname, 'import-acp.mjs')
execFileSync(process.execPath, [importer, '--cwd', process.cwd(), stage], { stdio: 'inherit' })

// Attach imported sessions to their project's workspace group on disk, so the
// sidebar shows them under the project instead of Ungrouped. A cwd with no
// workspace record is left alone: the registry's per-boot reconcile creates the
// group. Tombstoned (deleted) paths stay ungrouped.
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const workspaceFile = join(dshHome, 'storages/workspace.json')
if (existsSync(workspaceFile)) {
  const store = JSON.parse(readFileSync(workspaceFile, 'utf8'))
  const global = store.global ?? {}
  const tombstoned = new Set(global.deletedPaths ?? [])
  const byPath = new Map(Object.values(store.tables?.workspaces ?? {}).map(r => [r.path, r]))
  let changed = false
  for (const doc of docs) {
    const record = byPath.get(doc.cwd)
    if (!record || tombstoned.has(record.path)) continue
    if (!record.sessionIds.includes(doc.sessionId)) {
      record.sessionIds.push(doc.sessionId)
      record.updatedAt = new Date().toISOString()
      changed = true
    }
  }
  if (changed) {
    writeFileSync(workspaceFile, JSON.stringify(store, null, 2) + '\n')
    console.log(`attached ${docs.length} session(s) to existing workspace group(s) in ${workspaceFile}`)
  }
} else {
  console.log(`no ${workspaceFile}; imported sessions will be grouped on next boot by the registry reconcile`)
}
// Record what we wrote: the next run proves the dsh copy is still ours via
// the hash (clobber guard) and skips refreshes while the vibe side is idle.
const snapNow = readSnapshots()
const byId = new Map(all.map(s => [s.id, s]))
let snapFailed = 0
for (const doc of docs) {
  const id = doc.sessionId.replace(/^session-/, '')
  try {
    const { log } = storePathsOf(byId.get(id))
    // `at` = the quiescence observation instant: any write at or after it
    // keeps the session eligible for refresh on the next run.
    snapNow[id] = { sha: sha256Of(log), at: readAtById.get(id) ?? Date.now(), n: doc.messages.length }
  } catch (e) {
    snapFailed++
    console.error(`  snapshot failed for ${id}: ${e.message} — next run treats the dsh copy as unknown (refuses to refresh it)`)
  }
}
mkdirSync(dirname(snapshotsFile), { recursive: true })
writeFileSync(snapshotsFile, JSON.stringify(snapNow, null, 2) + '\n')

rmSync(stage, { recursive: true, force: true })
console.log(`done: ${docs.length} vibe session(s) imported (${snapFailed} snapshot failure(s))${deferred.length ? `; ${deferred.length} deferred mid-write (exit 3: wrapper must not touch its state file so the next run retries)` : '. Restart the dsh web UI to see new groups.'}`)
if (deferred.length) process.exit(3)
