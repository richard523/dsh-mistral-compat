#!/usr/bin/env bun
/**
 * import-acp.mjs — general ACP chat importer for DeepSeek Harness.
 *
 * Imports chat transcripts from ANY ACP client (or plain {messages:[...]} JSON)
 * into the dsh session store (~/.dsh/sessions), so they show up in the web UI
 * history AND in ACP session/list of any connected client.
 *
 * Accepted inputs (files or directories, .json / .jsonl):
 *   - {"messages":[{"role":"user|assistant","content":"..."|[{type:"text",text:"..."}]}]}
 *   - ACP session dump: {"sessionId"?, "cwd"?, "title"?, "messages":[...]}
 *   - JSONL with one {"role","content"} message per line
 *   - an array of the above objects
 *
 * Usage: bun scripts/import-acp.mjs [--cwd DIR] [--host HOST] <file-or-dir>...
 *
 * --host tags imported sessions with the host the chat ran on (e.g. an SSH
 * box), so a home shared across machines keeps them in a separate
 * --<host>@<project>-- directory and ACP session/list shows _meta.host.
 * A chat document may also carry its own "host" field; --host is the fallback.
 */
import { mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { zstdCompressSync } from 'node:zlib'

const home = process.env.DSH_HOME ?? `${process.env.HOME}/.dsh`
const storeRoot = join(home, 'sessions')

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

function projectDir(cwd, remoteHost) {
  // mirrors projectKey(cwd, remoteHost) in session-persistence-jsonl/src/format.ts
  const slug = slugOf(resolve(cwd))
  if (remoteHost === undefined) return join(storeRoot, `--${slug.slice(0, 251)}--`)
  return join(storeRoot, `--${(slugOf(remoteHost) + '@' + slug).slice(0, 251)}--`)
}

function toText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.filter(c => c?.type === 'text' || typeof c === 'string').map(c => typeof c === 'string' ? c : c.text).join('\n')
  return String(content ?? '')
}

function parseChat(text, fileLabel) {
  const trimmed = text.trim()
  if (!trimmed) return []
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const doc = JSON.parse(trimmed)
    if (Array.isArray(doc)) return doc.flatMap(d => parseChat(JSON.stringify(d), fileLabel))
    if (Array.isArray(doc.messages)) {
      return [{ id: doc.sessionId ?? doc.id, cwd: doc.cwd, title: doc.title, host: doc.host, messages: doc.messages }]
    }
    if (doc.role && doc.content !== undefined) return [{ messages: [doc] }]
    throw new Error(`${fileLabel}: no messages array found`)
  }
  // JSONL: one message per line
  const messages = trimmed.split('\n').filter(Boolean).map(line => JSON.parse(line))
  return [{ messages }]
}

function writeSession(chat, fallbackCwd, fallbackHost) {
  // dsh stores sessions under the REALPATH of cwd; mirror that so the header
  // identity check (generationLogPath) matches the on-disk location. A cwd
  // that no longer exists falls back to the resolved spelling (the session
  // then reads back as a missing-directory stray).
  let cwd
  try { cwd = realpathSync(resolve(chat.cwd ?? fallbackCwd)) } catch { cwd = resolve(chat.cwd ?? fallbackCwd) }
  const remoteHost = chat.host ?? fallbackHost
  const id = chat.id?.startsWith('session-') ? chat.id : `session-${randomUUID()}`
  const dir = join(projectDir(cwd, remoteHost), id)
  mkdirSync(dir, { recursive: true })
  const now = Date.now()
  const lines = [JSON.stringify({
    type: 'session', version: 4, id, createdAt: now, cwd: resolve(cwd), isSeeded: false, delegationDepth: 0,
    ...(remoteHost === undefined ? {} : { remoteHost }),
  })]
  let seq = 0
  let turn = 0
  let openTurn = false
  const push = (type, data) => lines.push(JSON.stringify({ type, seq: seq++, time: now + seq, data, ...(type.endsWith('/message') ? { surfaceOp: 'append' } : {}) }))
  const closeTurn = () => {
    if (!openTurn) return
    push('turn/end', { turn, reason: { kind: 'completed' } })
    openTurn = false
  }
  /**
   * The v4 surface invariant: the FIRST surface message of the log must be an
   * (empty) `system/message` protected head — a resumed dsh Agent replaces it
   * with the real system prompt. An imported log without it loads for reading,
   * but the first in-dsh resume then appends its system prompt AFTER the
   * imported surface and permanently fails every later load with
   * `system/message requires a protected first surface head`.
   */
  let headPlaced = false
  let turnSteps = 0
  const openTurnAt = () => {
    turn += 1
    turnSteps = 0
    push('turn/start', { turn })
    openTurn = true
  }
  const head = () => (headPlaced ? [] : (headPlaced = true, [
    ['system/message', { turn, step: 1, message: { role: 'system', content: [], source: { kind: 'system-prompt' }, id: randomUUID() } }],
  ]))
  for (const m of chat.messages) {
    const role = m.role === 'assistant' ? 'assistant' : 'user'
    const text = toText(m.content)
    if (!text) continue
    // The v4 lifecycle requires turn/step framing around assistant messages
    // for the stored log to read back; each user message opens a fresh turn.
    if (role === 'user') {
      closeTurn()
      openTurnAt()
      const first = !headPlaced
      if (first) { push('step/start', { turn, step: ++turnSteps }) }
      for (const [type, data] of head()) push(type, data)
      push('user/message', { content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user', id: randomUUID() })
      if (first) push('step/end', { turn, step: turnSteps })
    } else {
      if (!openTurn) openTurnAt()
      push('step/start', { turn, step: ++turnSteps })
      for (const [type, data] of head()) push(type, data)
      push('assistant/message', { turn, step: turnSteps, stream: [], message: { role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: m.provider ?? 'imported', model: m.model ?? 'imported' }, id: randomUUID() } })
      push('step/end', { turn, step: turnSteps })
      closeTurn()
    }
  }
  // A trailing user message leaves its turn open; close it so the log is quiescent.
  closeTurn()
  let titleSeq
  if (chat.title) {
    titleSeq = seq
    lines.push(JSON.stringify({ type: 'session/title', seq: seq++, time: now + seq, data: { title: chat.title, messageSeqs: [], source: { kind: 'user' } } }))
  }
  // The v4 reader expects ONE ZSTD FRAME PER LINE (header frame first); node's
  // zstdCompressSync produces exactly that, unlike the zstd CLI (one frame).
  const zsted = join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(zsted, Buffer.concat(lines.map(l => zstdCompressSync(Buffer.from(l + '\n', 'utf8')))))
  // Seed the persisted projection cache so the cold session list shows the
  // title without opening the session. Layout mirrors the shipped backends:
  // one per-record document per session under storages/session_projcache.
  // `version: 7` mirrors projectionCacheDomainSpec; the title row's `ver: 1`
  // mirrors the title projection's stateVersion. Identity must match the
  // header written above (createdAt/cwd/isSeeded/formatVersion 4).
  if (chat.title) {
    const projcacheDir = join(home, 'storages/session_projcache/sessions')
    mkdirSync(projcacheDir, { recursive: true })
    const document = {
      version: 7,
      record: {
        identity: {
          formatVersion: 4,
          createdAt: now,
          cwd: resolve(cwd),
          isSeeded: false,
          inheritedEventCount: 0,
        },
        rows: { title: { ver: 1, seq: titleSeq, val: chat.title } },
      },
    }
    writeFileSync(join(projcacheDir, `${id}.json`), JSON.stringify(document, null, 2) + '\n')
  }
  return { id, cwd: resolve(cwd), remoteHost, messages: seq }
}

function* walk(p) {
  const st = statSync(p)
  if (st.isDirectory()) for (const e of readdirSync(p)) yield* walk(join(p, e))
  else if (/\.jsonl?$/.test(p)) yield p
}

const args = process.argv.slice(2)
let cwd = process.cwd()
let host
let inputs = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--cwd') { cwd = args[++i] } else if (args[i] === '--host') { host = args[++i] } else inputs.push(args[i])
}
if (inputs.length === 0) { console.error('usage: bun scripts/import-acp.mjs [--cwd DIR] [--host HOST] <file-or-dir>...'); process.exit(2) }

let count = 0
for (const input of inputs) {
  for (const file of walk(input)) {
    for (const chat of parseChat(readFileSync(file, 'utf8'), file)) {
      const r = writeSession(chat, cwd, host)
      console.log(`imported ${r.id} (${r.messages} messages) from ${basename(file)} -> cwd ${r.cwd}${r.remoteHost === undefined ? '' : ` @ ${r.remoteHost}`}`)
      count++
    }
  }
}
console.log(`done: ${count} session(s) imported into ${storeRoot}`)
