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
 *   --with-tools  also render tool calls/results as note messages (default: messages only)
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

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
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--vibe-home') vibeHome = resolve(args[++i])
  else if (a === '--dir') dirs.push(lenientRealpath(args[++i]))
  else if (a === '--since') since = Date.parse(args[++i])
  else if (a === '--stage') stage = resolve(args[++i])
  else if (a === '--with-tools') withTools = true
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
    try { m = JSON.parse(line) } catch { continue }
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
    try { list = JSON.parse(readFileSync(join(chunkDir, cf), 'utf8')) } catch { continue }
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

/** Collect every Vibe session as { id, cwd, startTime, messages }. */
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
      sessions.set(id, { id, cwd, startTime: Date.parse(meta.start_time ?? '') || 0, load: () => legacyMessages(messagesPath, withTools) })
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
      sessions.set(id, { id, cwd, startTime: Date.parse(meta.start_time ?? '') || 0, load: () => unifiedMessages(chunkDir, withTools) })
    }
  }
  return [...sessions.values()]
}

const all = collect()
const picked = all.filter(s =>
  (dirs.length === 0 || dirs.includes(lenientRealpath(s.cwd)))
  && (since === undefined || s.startTime >= since))
console.log(`vibe store: ${all.length} session(s); importing ${picked.length}`)

if (dryRun) {
  for (const s of picked) console.log(`  would import ${s.id}  cwd=${s.cwd}  started=${new Date(s.startTime).toISOString()}`)
  process.exit(0)
}

rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })
const docs = []
for (const s of picked) {
  const messages = s.load()
  if (messages.length === 0) continue
  const doc = {
    sessionId: `session-${s.id}`,
    cwd: lenientRealpath(s.cwd),
    title: titleOf(messages) || `vibe ${s.id.slice(0, 8)}`,
    messages,
  }
  writeFileSync(join(stage, `${s.id}.json`), JSON.stringify(doc))
  docs.push(doc)
}
if (docs.length === 0) { console.log('nothing to import'); process.exit(0) }

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
rmSync(stage, { recursive: true, force: true })
console.log(`done: ${docs.length} vibe session(s) imported. Restart the dsh web UI to see new groups.`)
