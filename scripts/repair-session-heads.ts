#!/usr/bin/env bun
/**
 * repair-session-heads.ts — repair stored session logs poisoned by an appended
 * `system/message` with no protected first surface head.
 *
 * The v4 surface invariant: the first surface message of a stored log must bean
 * (empty) `system/message` protected head. Logs written by import-acp.mjs before
 * the protected-head fix start their surface with `user/message`; when such a
 * session is later resumed inside dsh, the runtime appends its real system
 * prompt AFTER the imported surface nodes, and from then on every load of that
 * stored log fails with
 *   `SessionFormatError: system/message requires a protected first surface head`
 * (web UI: "Failed to load history: stored session … is corrupt").
 *
 * This script walks the dsh session store (~/.dsh/sessions), decodes every
 * session.v4.jsonl.zstd through the harness's own scanner, and for each log the
 * scanner rejects with that specific error inserts the missing head the same
 * way deepseek-chat-import seeds one: a `step/start`, an empty `system/message`
 * (system-prompt source) before the first surface message, and a matching
 * `step/end` before the enclosing turn's close; all later seq numbers and seq
 * references shift by the inserted events. A repaired log must pass the same
 * scanner before it replaces the stored file. The original file is kept beside
 * it as `session.v4.jsonl.zstd.bak-<timestamp>`.
 *
 * Usage:
 *   bun scripts/repair-session-heads.ts [--dry-run] [--home DIR]
 *
 *   --dry-run  report what would be repaired, write nothing
 *   --home     dsh home (default ~/.dsh)
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { scanLog } from '../packages/session/session-persistence-jsonl/src/format.ts'

const args = process.argv.slice(2)
let dryRun = false
let home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dry-run') dryRun = true
  else if (args[i] === '--home') home = args[++i]
  else { console.error(`unknown arg: ${args[i]}`); process.exit(2) }
}

const HEAD_ERROR = 'system/message requires a protected first surface head'
const SURFACE_MESSAGE_TYPES = new Set(['user/message', 'assistant/message', 'developer/message', 'system/message'])

interface StoredRecord {
  type?: unknown
  seq?: unknown
  time?: unknown
  data?: unknown
  surfaceOp?: unknown
  [key: string]: unknown
}

const shift = (value: number, at: number) => (value >= at ? value + 1 : value)

const headerOf = (records: Record<string, unknown>[]): Record<string, unknown> => records[0] as Record<string, unknown>

function shiftSeqRefs(node: unknown, at: number, by: number, depth = 0): unknown {
  if (depth > 24) return node
  if (Array.isArray(node)) return node.map(entry => shiftSeqRefs(entry, at, by, depth + 1))
  if (node === null || typeof node !== 'object') return node
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (typeof value === 'number') {
      out[key] = ['startSeq', 'endSeq', 'headerSeq', 'startEventSeq', 'endEventSeq'].includes(key)
        ? (value >= at ? value + by : value)
        : value
    } else if ((key === 'sourceEventSeqs' || key === 'messageSeqs') && Array.isArray(value)) {
      out[key] = value.map(entry => (typeof entry === 'number' && entry >= at ? entry + by : entry))
    } else {
      out[key] = shiftSeqRefs(value, at, by, depth + 1)
    }
  }
  return out
}

/** Insert the protected head; returns renumbered records, or null when the log has no repairable surface. */
function buildRepair(lines: string[]): Record<string, unknown>[] | null {
  const header = JSON.parse(lines[0] as string) as Record<string, unknown>
  const events = lines.slice(1).map(line => JSON.parse(line) as Record<string, unknown>)
  const firstSurface = events.findIndex(event => SURFACE_MESSAGE_TYPES.has(String(event.type)))
  if (firstSurface === -1) return null
  let stepEndAfter = events.length - 1
  for (let i = firstSurface; i < events.length; i++) {
    const event = events[i]
    if (event.type === 'turn/end' || event.type === 'turn/start') { stepEndAfter = i - 1; break }
  }
  let turn = 1
  for (let i = firstSurface; i >= 0; i--) {
    const data = events[i]?.data as { turn?: unknown } | undefined
    if (events[i]?.type === 'turn/start' && typeof data?.turn === 'number') { turn = data.turn; break }
  }
  const time = Number(events[firstSurface]?.time ?? (header.createdAt as number))
  const headMessage = { role: 'system', content: [], source: { kind: 'system-prompt' }, id: randomUUID() }
  const inserted = [
    { type: 'step/start', data: { turn, step: 1 }, time },
    { type: 'system/message', data: { turn, step: 1, message: headMessage }, time, surfaceOp: 'append' },
  ]
  const rebuilt: Record<string, unknown>[] = []
  for (let i = 0; i < events.length; i++) {
    if (i === firstSurface) rebuilt.push(...inserted)
    rebuilt.push(events[i] as Record<string, unknown>)
    if (i === stepEndAfter) rebuilt.push({ type: 'step/end', data: { turn, step: 1 }, time })
  }
  const insertedCount = rebuilt.length - events.length
  const at = firstSurface
  const shiftN = (value: number) => (value >= at ? value + insertedCount : value)
  for (const [index, record] of rebuilt.entries()) {
    record.seq = index
    if (record.surfaceOp !== undefined && typeof record.surfaceOp === 'object') {
      record.surfaceOp = shiftSeqRefs(record.surfaceOp, at, insertedCount)
    }
    if (record.data !== undefined) record.data = shiftSeqRefs(record.data, at, insertedCount)
  }
  return [header, ...rebuilt]
}

function frames(lines: string[]): Buffer {
  return Buffer.concat(lines.map(line => zstdCompressSync(Buffer.from(`${line}\n`, 'utf8'))))
}

/**
 * Re-seed a repaired session's projection cache the way import-acp.mjs does:
 * a title-only row carrying the shifted title-event seq over the unchanged
 * identity. The runtime recomputes every other projection row from the log.
 */
function reseedProjectionCache(sessionId: string, header: Record<string, unknown>, repaired: Record<string, unknown>[], homeDir: string): void {
  const cachePath = join(homeDir, 'storages/session_projcache/sessions', `${sessionId}.json`)
  const titleEvent = repaired.find(
    record => record.type === 'session/title' && typeof record.seq === 'number',
  ) as { seq: number; data?: { title?: unknown } } | undefined
  try {
    if (titleEvent === undefined || typeof titleEvent.data?.title !== 'string') {
      rmSync(cachePath, { force: true })
      return
    }
    mkdirSync(dirname(cachePath), { recursive: true })
    const seed = {
      version: 7,
      record: {
        identity: {
          formatVersion: 4,
          createdAt: header.createdAt,
          cwd: header.cwd,
          isSeeded: header.isSeeded,
          inheritedEventCount: 0,
        },
        rows: { title: { ver: 1, seq: titleEvent.seq, val: titleEvent.data.title } },
      },
    }
    writeFileSync(cachePath, JSON.stringify(seed, null, 2) + '\n')
  } catch {
    // A stale cache row at worst hides the title until the session is opened; never block the repair.
  }
}

const sessionsRoot = join(home, 'sessions')
let checked = 0
let repaired = 0
const skipped: string[] = []
for (const group of readdirSync(sessionsRoot)) {
  const groupDir = join(sessionsRoot, group)
  if (!statSync(groupDir).isDirectory()) continue
  for (const entry of readdirSync(groupDir)) {
    const entryDir = join(groupDir, entry)
    let file: string
    try { file = join(entryDir, 'session.v4.jsonl.zstd') } catch { continue }
    if (!statSync(entryDir).isDirectory() || !statSync(file).isFile()) continue
    let plaintext: Buffer
    try { plaintext = execFileSync('zstdcat', [file], { maxBuffer: 256 * 1024 * 1024 }) } catch {
      skipped.push(file)
      continue
    }
    checked += 1
    let failure: unknown
    try { scanLog(plaintext) } catch (error) { failure = error }
    if (failure === undefined) continue
    const message = failure instanceof Error ? failure.message : String(failure)
    if (!message.includes(HEAD_ERROR)) {
      skipped.push(`${file}: ${message.slice(0, 120)}`)
      continue
    }
    const lines = plaintext.toString('utf8').split('\n').filter(line => line.length > 0)
    const rebuilt = buildRepair(lines)
    if (rebuilt === null) { skipped.push(`${file}: no surface messages`); continue }
    const outLines = rebuilt.map(record => JSON.stringify(record))
    try { scanLog(Buffer.from(outLines.join('\n') + '\n', 'utf8')) } catch (error) {
      skipped.push(`${file}: repaired text still rejected: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    if (dryRun) { console.log(`would repair ${file}`); repaired++; continue }
    const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
    copyFileSync(file, backup)
    writeFileSync(file, frames(outLines))
    reseedProjectionCache(String(headerOf(rebuilt).id ?? entryDir), headerOf(rebuilt), rebuilt, home)
    repaired++
    console.log(`repaired ${file} (backup: ${backup.split('/').pop()})`)
  }
}
console.log(`checked ${checked} logs, repaired ${repaired}${dryRun ? ' (dry run)' : ''}`)
if (skipped.length > 0) {
  console.log('skipped:')
  for (const line of skipped) console.log(`  ${line}`)
}
