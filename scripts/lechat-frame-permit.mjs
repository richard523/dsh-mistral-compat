#!/usr/bin/env bun
/**
 * lechat-frame-permit.mjs — let the DeepSeek Harness PWA window embed
 * chat.mistral.ai (Le Chat) in an iframe.
 *
 * Le Chat serves X-Frame-Options: DENY (and a CSP with frame-ancestors) on
 * its documents, so the Chromium engine refuses to render them inside the
 * harness page. This daemon attaches to the window's browser-level DevTools
 * endpoint (--remote-debugging-port, loopback only), auto-attaches flat
 * sessions to every page and out-of-process frame (Target.setAutoAttach +
 * flatten, the only routing that reliably delivers requestPaused across
 * frame-hosting render processes), and REFILLS chat.mistral.ai and
 * v2.auth.mistral.ai DOCUMENT responses with their own bytes and the same
 * headers minus the frame-blocking set plus an explicit `frame-ancestors *`.
 *
 * The ENGINE does all the networking — cookies, the Cloudflare challenge, the
 * TLS fingerprint stay native, because Cloudflare binds its clearance cookie
 * to the client fingerprint and a proxying fetch never passes. Streaming
 * bodies are read through Fetch.takeResponseBodyAsStream + IO.read
 * (getResponseBody returns empty for streamed HTML); redirect hops carry no
 * body. auth.mistral.ai itself stays UNintercepted: it only ever answers
 * with redirects (X-Frame-Options is never consulted on a 3xx), and an
 * intercepted hop would replay WITHOUT its original Set-Cookie (the pause's
 * responseHeaders never expose them in this build — set-cookie application
 * happens through Chromium's own path), silently destroying Ory's flow
 * cookies. Subresource, XHR and SSE requests pass through untouched, in the
 * real origin; nothing is logged or stored.
 *
 * Service worker suppression: once chat.mistral.ai's sw.js registers,
 * Chromium routes the origin's document loads through the worker, where
 * response-stage requestPaused never fires and the refill (and the pane's
 * frame) silently die. The registration script fetch never crosses frame
 * sessions either (it is issued by the browser context), so the daemon
 * BLOCKS sw.js at request stage — navigator.serviceWorker.register() then
 * simply fails, Le Chat runs its online shell (it is a server-rendered PWA;
 * the worker only fronts an offline cache), and every document load stays
 * interceptable — with a belt-and-braces injection of the same neutering
 * into each refilled <head> and the launcher purging any persisted
 * registration before the browser starts.
 *
 * Usage:
 *   bun scripts/lechat-frame-permit.mjs [--cdp-port 3128]
 *        [--app-origin http://127.0.0.1:3080] [--frame-host mistral.ai]
 */
const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback
}
const cdpPort = Number(opt('cdp-port', '3128'))
const appOrigin = opt('app-origin', 'http://127.0.0.1:3080')
const frameHost = opt('frame-host', 'mistral.ai')

/** Response headers that must never reach the engine for framed documents. */
const STRIP = new Set(['x-frame-options', 'content-security-policy', 'content-security-policy-report-only', 'cross-origin-embedder-policy', 'content-encoding', 'content-length'])

/**
 * Response-stage patterns for hosts whose DOCUMENTS must be refilled: the
 * app shell and the v2 auth host (its CSP carries a frame-ancestors beyond
 * the snippet the refill log prints). auth.mistral.ai only ever answers with
 * redirects — XFO on a 3xx is never consulted — and MUST NOT be intercepted:
 * Chromium applies set-cookie through its own path while a
 * Fetch.fulfillRequest replay only carries the headers the pause exposed
 * (set-cookie is not among them). A refilled auth hop would silently drop
 * Ory's __Host-ory_kratos_browser flow cookies and the v2 login page SSRs
 * "couldn't resume your sign-in". Left native, the 303's cookies flow into
 * the launderer, which re-stores them for the third-party pane; XHRs and
 * form POSTs stay native underneath either pattern, so their session cookies
 * launder as well.
 */
const sitePattern = `https://chat.${frameHost}/*`
const authSitePattern = `https://v2.auth.${frameHost}/*`

/** CDP Fetch pattern for the PWA service worker script (blocked at request
 * stage so registration never completes; see header comment). */
const swPattern = `https://*.${frameHost}/sw.js*`

/** Whether a target URL is an OOPIF of the frame host worth intercepting. */
const frameUrl = (url) => new RegExp(`^https://([a-z0-9-]+\\.)*${frameHost.replace(/\./g, '\\.')}/`).test(url)

/** Whether a request URL is Le Chat's service worker script. */
const swUrl = (url) => url === `https://chat.${frameHost}/sw.js` || new RegExp(`^https://([a-z0-9-]+\\.)*${frameHost.replace(/\./g, '\\.')}/sw\\.js[?#]?`).test(url)

/** Inline script injected into every refilled Le Chat document (see
 * stripDocument): the sw.js registration fetch is issued by the browser
 * context, so it is invisible to frame-session Fetch interception, and
 * Page.addScriptToEvaluateOnNewDocument must not be relied on either. The
 * document body flows through this daemon anyway — injecting into the
 * refilled HTML guarantees the neutering runs before any app bootstrap.
 * register() rejecting is handled by Next.js PWA bootstrap silently; the
 * worker never installs, so document loads stay on the network stack where
 * the refill can keep reaching them. */
const SW_OFF_SNIPPET = `(function(){try{window.__dshSwOff=true;if(!('serviceWorker' in navigator))return;Object.defineProperty(navigator.serviceWorker,'register',{value:function(){return Promise.reject(new TypeError('service workers disabled'))},configurable:false,writable:false});}catch(e){}})();`

/** Relax set-cookie for the cross-site pane. The frame is a third-party
 * context (embedded from the harness origin), so three things must be forced
 * or Chromium drops the cookie and Ory's login flow dies with "couldn't
 * resume your sign-in": SameSite=None (Strict/Lax and the implicit-Lax
 * default never fire on cross-site requests), Secure (required with None),
 * and Partitioned (CHIPS — the user's third-party-cookie preference blocks
 * plain cross-site cookies with reason UserPreferences, while partitioned
 * ones store fine under the harness top-site). The pane always lives under
 * the same top-level site, so the partition never changes mid-flow. */
function relaxSetCookie(value) {
  let out = value.replace(/;\s*SameSite=[^;]*/ig, '').replace(/[;\s]*$/, '')
  out += `; SameSite=None`
  if (!/;\s*Secure/i.test(out)) out += '; Secure'
  if (!/;\s*Partitioned/i.test(out)) out += '; Partitioned'
  return out
}

let nextId = 1
const pending = new Map()
/** Flat sessions (sessionId) that had Fetch.enable accepted. */
const intercepting = new Set()

const log = line => console.log(`[lechat-frame-permit] ${line}`)

async function httpGetJson(path) {
  try {
    const res = await fetch(`http://127.0.0.1:${cdpPort}${path}`)
    return res.ok ? await res.json() : undefined
  } catch {
    return undefined
  }
}

class Browser {
  constructor(ws) {
    this.ws = ws
    ws.onmessage = ev => { void this.onMessage(ev.data) }
  }

  send(method, params = {}, sessionId) {
    const id = nextId++
    const msg = { id, method, params }
    if (sessionId !== undefined) msg.sessionId = sessionId
    this.ws.send(JSON.stringify(msg))
    return id
  }

  call(method, params = {}, sessionId) {
    return new Promise(resolve => {
      const id = this.send(method, params, sessionId)
      pending.set(id, resolve)
    })
  }

  async maybeEnableFetch(targetInfo, sessionId) {
    const { type, url } = targetInfo
    // Chain auto-attach on every session: pages emit their OOPIFs only when
    // the page session itself also runs Target.setAutoAttach. Children are
    // started WAITING for the debugger, so a brand-new frame cannot race its
    // first response past the Fetch.enable below ("v2.auth.mistral.ai
    // refused to connect" was exactly that race: a cross-origin navigation
    // swaps in a fresh OOPIF, and when its document answered before the
    // interception patterns were armed, the engine honored the original
    // X-Frame-Options and blocked the frame). Every attached child is
    // released with Runtime.runIfWaitingForDebugger at the end — after the
    // guards are in place.
    const holder = (type === 'page') || (type === 'iframe')
    if (holder) {
      await this.call('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId)
    }
    if (type === 'service_worker' && frameUrl(url)) {
      // A registration persisted before this daemon existed: keep the worker
      // itself fetch-bypassed while it lives (the launcher purges the
      // registration at the next window start; Chromium exposes no
      // unregister over DevTools in this build).
      await this.call('ServiceWorker.setBypassFetchHandler', { encodedScriptUrl: url })
      await this.call('ServiceWorker.setCacheDisabled', { cacheDisabled: true })
      log(`service worker fetch bypassed (${url.split('?')[0]})`)
      this.release(sessionId, type)
      return
    }
    const mine = (type === 'page' && url.startsWith(appOrigin))
      || (type === 'iframe' && frameUrl(url))
    if (mine && type !== 'service_worker' && !intercepting.has(sessionId)) {
      const ack = await this.call('Fetch.enable', {
        patterns: [
          { urlPattern: swPattern, requestStage: 'Request' },
          { urlPattern: sitePattern, requestStage: 'Response' },
          { urlPattern: authSitePattern, requestStage: 'Response' },
        ],
      }, sessionId)
      if (ack.error !== undefined) {
        log(`Fetch.enable rejected on ${type} ${targetInfo.targetId}: ${ack.error.message}`)
      } else {
        intercepting.add(sessionId)
        log(`intercepting on ${type} ${targetInfo.targetId} (${url.split('?')[0]})`)
      }
      if (type === 'iframe') {
        // Runs in every NEW document of the frame, before its scripts:
        // neuters navigator.serviceWorker.register so no worker ever
        // installs. Must land before the frame is released below, so the
        // document about to load already carries the guard.
        const ack = await this.call('Page.addScriptToEvaluateOnNewDocument', { source: SW_OFF_SNIPPET }, sessionId)
        if (ack.error !== undefined) log(`Page.addScriptToEvaluateOnNewDocument rejected (${ack.error.message})`)
      }
    }
    this.release(sessionId, type)
  }

  /** Let a child that was auto-attached with waitForDebuggerOnStart run. */
  release(sessionId, type) {
    this.call('Runtime.runIfWaitingForDebugger', {}, sessionId).then(ack => {
      if (ack.error !== undefined && !/wasn't waiting|not waiting/i.test(ack.error.message)) {
        log(`runIfWaitingForDebugger rejected on ${type}: ${ack.error.message}`)
      }
    })
  }

  async onMessage(raw) {
    let msg
    try { msg = JSON.parse(raw) } catch { return }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const resolve = pending.get(msg.id)
      pending.delete(msg.id)
      resolve(msg.result !== undefined ? msg.result : { error: msg.error })
      return
    }
    if (msg.method === 'Target.attachedToTarget') {
      const { targetInfo, sessionId } = msg.params
      await this.maybeEnableFetch(targetInfo, sessionId)
      return
    }
    if (msg.method === 'Target.detachedFromTarget') {
      intercepting.delete(msg.params.sessionId)
      return
    }
    if (msg.method !== 'Fetch.requestPaused' || msg.sessionId === undefined) return
    const event = msg.params
    if (swUrl(event.request.url)) {
      // The PWA service worker must never register: once it controls the
      // origin, document responses stop surfacing requestPaused and the
      // refill (and the pane) die. register() failing is harmless for a
      // server-rendered app.
      this.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }, msg.sessionId)
      log(`blocked service worker script (${event.request.url.split('?')[0]})`)
      return
    }
    if (event.resourceType !== 'Document') {
      this.send('Fetch.continueRequest', { requestId: event.requestId }, msg.sessionId)
      return
    }
    if (event.responseStatusCode === undefined) {
      // Request-stage pauses arrive only for the sw.js pattern; everything
      // else passes straight through.
      this.send('Fetch.continueRequest', { requestId: event.requestId }, msg.sessionId)
      return
    }
    await this.stripDocument(event, msg.sessionId)
  }

  async readStreamedBody(requestId, sessionId) {
    const { stream } = await this.call('Fetch.takeResponseBodyAsStream', { requestId }, sessionId)
    const chunks = []
    try {
      for (;;) {
        const chunk = await this.call('IO.read', { handle: stream }, sessionId)
        if (chunk.data !== undefined && chunk.data !== '') {
          chunks.push(chunk.base64Encoded
            ? chunk.data
            : Buffer.from(chunk.data, 'utf8').toString('base64'))
        }
        if (chunk.eof) break
      }
    } finally {
      this.send('IO.close', { handle: stream }, sessionId)
    }
    return { base64: chunks.join('') }
  }

  async stripDocument(event, sessionId) {
    const code = event.responseStatusCode ?? 200
    const headers = (event.responseHeaders ?? []).map(h => ({ name: h.name, value: h.value }))
    const kept = headers.map(h => ({
      name: h.name,
      value: h.name.toLowerCase() === 'set-cookie' ? relaxSetCookie(h.value) : h.value,
    })).filter(h => !STRIP.has(h.name.toLowerCase()))
    kept.push({ name: 'content-security-policy', value: 'frame-ancestors *' })
    // Refills are always fresh: a cached copy would later replay with the
    // ORIGINAL frame-blocking headers straight from the HTTP cache.
    kept.push({ name: 'cache-control', value: 'no-store, max-age=0' })
    const url = event.request.url.split('?')[0]
    let body = ''
    if (!(code >= 300 && code < 400)) {
      try {
        const drained = await this.readStreamedBody(event.requestId, sessionId)
        body = drained.base64
        // Neuter service worker registration inside the refilled HTML: the
        // registration fetch never crosses frame sessions (browser context),
        // so the document itself is the only reliable injection point.
        const html = Buffer.from(body, 'base64').toString('utf8')
        if (/<head[^>]*>/i.test(html)) {
          const injected = html.replace(/<head[^>]*>/i, m => `${m}<script>${SW_OFF_SNIPPET}</script>`)
          body = Buffer.from(injected, 'utf8').toString('base64')
        }
      } catch (error) {
        log(`stream body failed on ${url}: ${error.message} - continuing unmodified (frame may be blocked)`)
        this.send('Fetch.continueRequest', { requestId: event.requestId }, sessionId)
        return
      }
    }
    const ack = await this.call('Fetch.fulfillRequest', {
      requestId: event.requestId,
      responseCode: code,
      responseHeaders: kept,
      body,
    }, sessionId)
    if (ack.error !== undefined) {
      log(`fulfillRequest rejected on ${url}: ${ack.error.message}`)
      return
    }
    log(`refilled ${url} status=${code} body=${Buffer.from(body, 'base64').length}b`)
  }
}

process.on('uncaughtException', error => { log(`uncaught: ${error.message}`) })
process.on('unhandledRejection', error => { log(`unhandled rejection: ${String(error)}`) })

async function connect() {
  for (;;) {
    const version = await httpGetJson('/json/version')
    if (version !== undefined && version.webSocketDebuggerUrl !== undefined) {
      try {
        const ws = new WebSocket(version.webSocketDebuggerUrl)
        await new Promise((resolve, reject) => {
          ws.onopen = resolve
          ws.onerror = () => reject(new Error('browser ws'))
        })
        const browser = new Browser(ws)
        await browser.call('Target.setDiscoverTargets', { discover: true })
        await browser.call('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
        log(`browser attached: cdp 127.0.0.1:${cdpPort}; pages under ${appOrigin}; frame host ${frameHost}`)
        return browser
      } catch (error) {
        log(`browser attach failed (${error.message}), retrying`)
      }
    }
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
}

const browser = await connect()
for (;;) {
  await new Promise(resolve => setTimeout(resolve, 2000))
  if (browser.ws.readyState === WebSocket.CLOSED) {
    log('browser gone; reconnecting')
    process.exit(0)
  }
}
