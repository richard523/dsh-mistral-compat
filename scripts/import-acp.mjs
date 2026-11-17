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
 * Usage: bun scripts/import-acp.mjs [--cwd DIR] <file-or-dir>...
 */
import { mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { zstdCompressSync } from 'node:zlib'

const home = process.env.DSH_HOME ?? `${process.env.HOME}/.dsh`
const storeRoot = join(home, 'sessions')

function projectDir(cwd) {
  // mirrors projectKey() in session-persistence-jsonl/src/format.ts
  let readable = ''
  let separatorRun = false
  for (const ch of resolve(cwd)) {
    if (ch === '/' || ch === '\\' || ch === ':') { if (!separatorRun) readable += '-'; separatorRun = true }
    else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) { readable += ch; separatorRun = false }
    else { readable += '~' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'); separatorRun = false }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return join(storeRoot, `--${slug.slice(0, 251)}--`)
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
      return [{ id: doc.sessionId ?? doc.id, cwd: doc.cwd, title: doc.title, messages: doc.messages }]
    }
    if (doc.role && doc.content !== undefined) return [{ messages: [doc] }]
    throw new Error(`${fileLabel}: no messages array found`)
  }
  // JSONL: one message per line
  const messages = trimmed.split('\n').filter(Boolean).map(line => JSON.parse(line))
  return [{ messages }]
}

function writeSession(chat, fallbackCwd) {
  // dsh stores sessions under the REALPATH of cwd; mirror that so the header
  // identity check (generationLogPath) matches the on-disk location.
  const cwd = realpathSync(resolve(chat.cwd ?? fallbackCwd))
  const id = chat.id?.startsWith('session-') ? chat.id : `session-${randomUUID()}`
  const dir = join(projectDir(cwd), id)
  mkdirSync(dir, { recursive: true })
  const now = Date.now()
  const lines = [JSON.stringify({
    type: 'session', version: 4, id, createdAt: now, cwd: resolve(cwd), isSeeded: false, delegationDepth: 0,
  })]
  let seq = 0
  let turn = 1
  for (const m of chat.messages) {
    const role = m.role === 'assistant' ? 'assistant' : 'user'
    const text = toText(m.content)
    if (!text) continue
    const data = role === 'user'
      ? { content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user', id: randomUUID() }
      : { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: m.provider ?? 'imported', model: m.model ?? 'imported' }, id: randomUUID() } }
    lines.push(JSON.stringify({ type: `${role}/message`, seq: seq++, time: now + seq, data, surfaceOp: 'append' }))
    if (role === 'assistant') turn++
  }
  if (chat.title) {
    lines.push(JSON.stringify({ type: 'session/title', seq: seq++, time: now + seq, data: { title: chat.title, source: { kind: 'imported' } } }))
  }
  // The v4 reader expects ONE ZSTD FRAME PER LINE (header frame first); node's
  // zstdCompressSync produces exactly that, unlike the zstd CLI (one frame).
  const zsted = join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(zsted, Buffer.concat(lines.map(l => zstdCompressSync(Buffer.from(l + '\n', 'utf8')))))
  return { id, cwd: resolve(cwd), messages: seq }
}

function* walk(p) {
  const st = statSync(p)
  if (st.isDirectory()) for (const e of readdirSync(p)) yield* walk(join(p, e))
  else if (/\.jsonl?$/.test(p)) yield p
}

const args = process.argv.slice(2)
let cwd = process.cwd()
const inputs = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--cwd') { cwd = args[++i] } else inputs.push(args[i])
}
if (inputs.length === 0) { console.error('usage: bun scripts/import-acp.mjs [--cwd DIR] <file-or-dir>...'); process.exit(2) }

let count = 0
for (const input of inputs) {
  for (const file of walk(input)) {
    for (const chat of parseChat(readFileSync(file, 'utf8'), file)) {
      const r = writeSession(chat, cwd)
      console.log(`imported ${r.id} (${r.messages} messages) from ${basename(file)} -> cwd ${r.cwd}`)
      count++
    }
  }
}
console.log(`done: ${count} session(s) imported into ${storeRoot}`)
