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
 * Pane focus handoff: this daemon also serves as the pane's keyboard usher.
 * A user-gesture open (Ctrl+Alt+M or the Mistral button) routes the window's
 * keyboard INTO the frame instantly — the page's cross-origin Window focus —
 * but the caret still needs Le Chat's composer element, which only this
 * daemon's evaluate can reach across the origin. The app page arms a
 * `data-lechat-focus` request on the panel; a 300ms poll reads and clears it
 * atomically and then focuses the [data-composer-editor] contenteditable
 * inside the Le Chat frame, retrying while the first document loads. The
 * injected PANE_KEYS_SNIPPET echoes Escape/Ctrl+Alt+M typed INSIDE Le Chat
 * back to the app page (key events never cross the origin alone), so the
 * toggle works from both sides and closing the pane returns the keyboard to
 * the harness composer.
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
 * "couldn't resume your sign-in". Left native, the 303's cookies store into
 * the top-level first-party jar — and because the engine attaches no
 * third-party cookies inside the embedded frame, the pane (a separate
 * storage partition) would never see them again. The LAUNDERER
 * (Browser.launder, a 3s cadence) therefore copies the frame host's session
 * cookies from the first-party jar into the pane's partition with
 * Network.setCookie under the very partition key Chromium already uses for
 * the pane's own cross-site cookies ({topLevelSite: <app top-site>,
 * hasCrossSiteAncestor: true}), mirrors sign-out by deleting what it copied,
 * and reloads the open pane only when the signed-in state actually flips —
 * rotations never bounce a live chat. This is what makes a top-level sign-in
 * (the pane header's ↗ window) show up in the pane; in-pane sign-in is
 * never attempted.
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

/** Forward pane-side key presses to the harness page. A key event inside the
 * cross-origin Le Chat frame never reaches the app's window keydown, so
 * Escape / Ctrl+Alt+M echo back through postMessage ('dsh-lechat-dismiss')
 * and the app panel treats that as the close toggle — Ctrl+Alt+M and Escape
 * keep working while typing inside Le Chat, not just from the harness page.
 * Escape is suppressed only when no dialog is open (Le Chat keeps its own
 * Escape behavior for modals). Runs ONLY in embedded documents — refilled
 * heads and frame-session addScriptToEvaluateOnNewDocument — never in the
 * top-level sign-in window, whose Escape stays entirely Le Chat's own; the
 * webview page ignores postMessages not from chat/v2.auth.mistral.ai. The
 * __dshPaneKeys guard keeps the two injection paths from doubling up. */
const PANE_KEYS_SNIPPET = `(function(){try{if(window.__dshPaneKeys)return;window.__dshPaneKeys=1;document.addEventListener('keydown',function(e){var d=e.target&&e.target.closest?e.target.closest('[role="dialog"],[aria-modal="true"],dialog[open]'):null;if(e.ctrlKey&&e.altKey&&!e.shiftKey&&!e.metaKey&&(e.key==='m'||e.key==='M')){e.preventDefault();e.stopPropagation();try{window.parent.postMessage('dsh-lechat-dismiss','*')}catch(x){}}else if(e.key==='Escape'&&!d&&!e.ctrlKey&&!e.altKey&&!e.shiftKey&&!e.metaKey){e.preventDefault();e.stopPropagation();try{window.parent.postMessage('dsh-lechat-dismiss','*')}catch(x){}}},true);}catch(x){}})();`

/** What every refilled Le Chat document head carries, and what every Le Chat
 * frame session injects into each new document: the service-worker neutering
 * plus the pane key echo. */
const REFILL_SCRIPT = SW_OFF_SNIPPET + PANE_KEYS_SNIPPET

/** Mailbox the app panel arms on a user-gesture open (see
 * apps/web/public/lechat-in-app.js): read AND cleared in the same evaluate,
 * because a poll that reads the flag in one call could race a clear in the
 * next. 'open' is the pane; 'want' asks for the composer-focus task. */
const PANE_STATE_EXPRESSION = `(function(){var p=document.querySelector('.dsh-lechat-panel');if(!p)return{open:0,want:0};var w=p.hasAttribute('data-lechat-focus')?1:0;p.removeAttribute('data-lechat-focus');return{open:p.classList.contains('open')?1:0,want:w}})()`

/** Focus the Le Chat composer inside the pane. The page's cross-origin
 * frame focus only routes keys INTO the frame; the caret needs the
 * composer element itself, and only this daemon's evaluate can reach across
 * the origin. Selectors are Le Chat's composer markup: the ProseMirror
 * contenteditable under [data-composer-editor]. Focused elements keep focus
 * across pane toggles, so re-typing after a reopen is often already instant
 * — this is for the cold path: a freshly loading or never-focused composer. */
const COMPOSER_FOCUS_EXPRESSION = `(function(){var el=document.querySelector('[data-composer-editor] [contenteditable="true"]')||document.querySelector('.ProseMirror[contenteditable="true"]');if(!el)return 0;try{el.focus()}catch(x){}return document.activeElement===el?1:0})()`

/** How long a focus request keeps retrying: the frame may still be loading,
 * or the Le Chat composer may not exist yet (first load of the pane). */
const COMPOSER_FOCUS_SECONDS = 20

/** Plain open check for the focus task's retry loop: bail out when the pane
 * closed meanwhile, so a slow first load never drags the keyboard into a
 * hidden pane. Keeps apart from the state mailbox, which must not be asked
 * for anything else while it clears its flag. */
const PANE_OPEN_EXPRESSION = `(function(){var p=document.querySelector('.dsh-lechat-panel');return p&&p.classList.contains('open')?1:0})()`

/** How often the launderer syncs the profile's top-level Le Chat sign-in
 * into the pane's storage partition (see Browser.launder). */
const LAUNDER_INTERVAL_MS = 3000

/** How long a stuck launder run is allowed to block later ones before the
 * busy flag is force-reset (see Browser.launder). */
const LAUNDER_STUCK_MS = 60000

/** Anti-bot plumbing, not identity: never copied across partitions. */
const NEVER_LAUNDER = new Set(['__cf_bm', '__cflb'])

/** Whether a cookie belongs to the frame host's family. */
const launderHost = (domain) => new RegExp(`(^|\\.)${frameHost.replace(/\./g, '\\.')}$`, 'i').test(domain)

/** The cookie jar's idea of "signed in": an Ory session cookie. Used both on
 * the top jar (source) and the partition (destination) to detect the
 * sign-in / sign-out transitions that warrant reloading the open pane. */
const orySessionIn = (cookies) => cookies.some(c => c.name.startsWith('ory_session'))

/** The pane's storage partition, derived from --app-origin the same way
 * Chromium renders it in cookie partition keys (scheme + host, no port:
 * observed live as "http://127.0.0.1" for http://127.0.0.1:3080). */
function appTopSite() {
  const u = new URL(appOrigin)
  return `${u.protocol}//${u.hostname}`
}

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
    /** An appOrigin page session, used to reach the page-scoped
     * ServiceWorker domain (browser-level Storage/ServiceWorker commands are
     * not exposed by this build; unregister takes scopeURL there). */
    this.appOriginSession = undefined
    /** Flat sessions as seen while attached: sessionId → target info. The
     * pane-focus watcher needs to find the Le Chat frame session later, not
     * only at attach time. */
    this.sessions = new Map()
    this.watchBusy = false
    this.focusTaskRunning = false
    this.launderBusy = false
    this.launderStartedAt = 0
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
    if (type === 'page' && frameUrl(url)) {
      // A TOP-LEVEL Le Chat window (the pane header's Sign-in button opens
      // one): its app registers sw.js freely — nothing refills its responses,
      // so the pane's in-document neutering never runs there — and the
      // resulting registration reroutes ALL chat.mistral.ai document loads,
      // including the embedded pane's, where refills cannot reach. Guard the
      // page itself the same way (no refills needed: X-Frame-Options is
      // irrelevant at top level), and unregister below.
      const ack = await this.call('Page.addScriptToEvaluateOnNewDocument', { source: SW_OFF_SNIPPET }, sessionId)
      if (ack.error !== undefined) log(`Page.addScriptToEvaluateOnNewDocument rejected (${ack.error.message})`)
      const fetch = await this.call('Fetch.enable', {
        patterns: [{ urlPattern: swPattern, requestStage: 'Request' }],
      }, sessionId)
      if (fetch.error !== undefined) log(`Fetch.enable rejected on page ${targetInfo.targetId}: ${fetch.error.message}`)
      else log(`service worker guard on top-level page (${url.split('?')[0]})`)
      this.unregisterChatSW(sessionId)
      this.release(sessionId, type)
      return
    }
    if (type === 'service_worker' && frameUrl(url)) {
      // A registration persisted before this daemon existed (or re-armed by
      // a stale page): bypass the worker's fetch handler while it lives and
      // unregister it via the appOrigin page session — this build only
      // accepts unregister on PAGE sessions, with scopeURL.
      await this.call('ServiceWorker.setBypassFetchHandler', { encodedScriptUrl: url })
      await this.call('ServiceWorker.setCacheDisabled', { cacheDisabled: true })
      log(`service worker bypassed (${url.split('?')[0]}); unregistering`)
      this.unregisterChatSW(this.appOriginSession)
      this.release(sessionId, type)
      return
    }
    const mine = (type === 'page' && url.startsWith(appOrigin))
      || (type === 'iframe' && frameUrl(url))
    if (mine && type === 'page') this.appOriginSession = sessionId
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
        // installs, and arms the pane key echo. Must land before the frame
        // is released below, so the document about to load already carries
        // the guard.
        const ack = await this.call('Page.addScriptToEvaluateOnNewDocument', { source: REFILL_SCRIPT }, sessionId)
        if (ack.error !== undefined) log(`Page.addScriptToEvaluateOnNewDocument rejected (${ack.error.message})`)
      }
    }
    this.release(sessionId, type)
  }

  /** Unregister Le Chat's service worker through a PAGE session — this build
   * exposes ServiceWorker.unregister only there, with the scopeURL param.
   * Used opportunistically; harmless when the registration is missing. */
  async unregisterChatSW(sessionId) {
    if (sessionId === undefined) return
    const enable = await this.call('ServiceWorker.enable', {}, sessionId)
    if (enable.error !== undefined) return
    const ack = await this.call('ServiceWorker.unregister', { scopeURL: `https://chat.${frameHost}/` }, sessionId)
    if (ack.error !== undefined) {
      log(`unregister rejected: ${ack.error.message}`)
    } else {
      log(`service worker registration unregistered`)
    }
  }

  /** Let a child that was auto-attached with waitForDebuggerOnStart run. */
  release(sessionId, type) {
    this.call('Runtime.runIfWaitingForDebugger', {}, sessionId).then(ack => {
      if (ack.error !== undefined && !/wasn't waiting|not waiting/i.test(ack.error.message)) {
        log(`runIfWaitingForDebugger rejected on ${type}: ${ack.error.message}`)
      }
    })
  }

  /** One poll of the app page's pane state (PANE_STATE_EXPRESSION reads and
   * clears the request in one atomic evaluate). A user-gesture pane-open
   * arms the request; run the composer-focus task, one at a time. */
  async paneWatch() {
    if (this.watchBusy || this.appOriginSession === undefined) return
    this.watchBusy = true
    try {
      const ack = await this.call('Runtime.evaluate', {
        expression: PANE_STATE_EXPRESSION,
        returnByValue: true,
      }, this.appOriginSession)
      if (ack.error === undefined && ack.result !== undefined) {
        const state = ack.result.value
        if (state !== undefined && state.open === 1 && state.want === 1 && !this.focusTaskRunning) {
          this.focusTaskRunning = true
          // Catch the pane just as it opens: if a top-level sign-in arrived
          // since the last launder tick, sync it in right now so this very
          // document load can already pick it up.
          this.launder().catch(error => log(`launderer failed (${error.message})`))
          this.focusComposer()
            .catch(error => log(`composer focus task failed (${error.message})`))
            .finally(() => { this.focusTaskRunning = false })
        }
      }
    } finally {
      this.watchBusy = false
    }
  }

  /** The session of the Le Chat chat frame inside the pane: the chat host's
   * frame wins over transient frames of the same host (auth pages embedded
   * by Le Chat's own sign-in flow); anything on the frame host is the
   * fallback. */
  frameSession() {
    let fallback
    for (const [sessionId, info] of this.sessions) {
      if (info.type !== 'iframe' || !frameUrl(info.url)) continue
      if (info.url.startsWith('https://chat.')) return sessionId
      if (fallback === undefined) fallback = sessionId
    }
    return fallback
  }

  /** The launderer this daemon's header describes. The engine attaches no
   * third-party cookies inside the embedded frame, so the profile's
   * first-party Le Chat session (signed in via the pane header's top-level
   * window) never reaches the pane's storage partition — the pane never
   * sees the session. This copies the frame host's session cookies from
   * the top-level jar into the pane's partition (CHIPS-style, via
   * setCookie with the partition Chromium already uses for the pane's own
   * third-party cookies), mirrors sign-out by deleting what it copied, and
   * reloads the open pane only when the signed-in state actually flips, so
   * cookie rotations never bounce a live chat. */
  async launder() {
    if (this.appOriginSession === undefined) return
    if (this.launderBusy) {
      // A call that never answered must not wedge the launderer forever:
      // cookie calls ride the same pending-map as the refills, but nothing
      // else would ever log or clear the stall — launder again anyway.
      if (Date.now() - this.launderStartedAt > LAUNDER_STUCK_MS) {
        log(`launderer: stuck over ${LAUNDER_STUCK_MS / 1000}s; resetting`)
        this.launderBusy = false
      } else {
        return
      }
    }
    this.launderBusy = true
    this.launderStartedAt = Date.now()
    try {
      const ack = await this.call('Network.getCookies', {
        urls: [`https://chat.${frameHost}/`, `https://${frameHost}/`, `https://auth.${frameHost}/`, `https://v2.auth.${frameHost}/`],
      }, this.appOriginSession)
      if (ack.error !== undefined || ack.result === undefined) return
      const all = ack.result.cookies ?? []
      const topSite = appTopSite()
      const source = all.filter(c => c.partitionKey === undefined && launderHost(c.domain) && !NEVER_LAUNDER.has(c.name))
      const partition = all.filter(c => c.partitionKey !== undefined && c.partitionKey.topLevelSite === topSite
        && launderHost(c.domain) && !NEVER_LAUNDER.has(c.name))
      const keyOf = c => `${c.domain}|${c.name}|${c.path}`
      const wanted = new Map(source.map(c => [keyOf(c), c]))
      const have = new Map(partition.map(c => [keyOf(c), c]))
      const writes = []
      const deletes = []
      for (const [key, c] of wanted) {
        const existing = have.get(key)
        if (existing !== undefined && existing.value === c.value) continue
        writes.push(c)
      }
      for (const [key, c] of have) {
        if (!wanted.has(key)) deletes.push(c)
      }
      if (writes.length === 0 && deletes.length === 0) return
      const partitionKey = { topLevelSite: topSite, hasCrossSiteAncestor: true }
      for (const c of writes) {
        const params = {
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          secure: true,
          httpOnly: c.httpOnly,
          sameSite: 'None',
          partitionKey,
        }
        if (typeof c.expires === 'number' && c.expires > 0) params.expires = c.expires
        const setAck = await this.call('Network.setCookie', params, this.appOriginSession)
        if (setAck.result === undefined || setAck.result.success !== true) {
          log(`launderer: setCookie rejected on ${c.domain} ${c.name}: ${setAck.error !== undefined ? setAck.error.message : 'success=false'}`)
        }
      }
      for (const c of deletes) {
        await this.call('Network.deleteCookies', { name: c.name, domain: c.domain, path: c.path, partitionKey }, this.appOriginSession)
      }
      const signedInFlipped = orySessionIn(source) !== orySessionIn(partition)
      if (signedInFlipped) {
        const pane = this.frameSession()
        const direction = orySessionIn(source) ? 'sign-in' : 'sign-out'
        if (pane !== undefined) {
          log(`launderer: pane partition synced (${writes.length} write(s), ${deletes.length} delete(s)); ${direction} — reloading the pane`)
          await this.call('Page.reload', {}, pane)
        } else {
          log(`launderer: pane partition synced (${writes.length} write(s), ${deletes.length} delete(s)); ${direction}`)
        }
      }
    } finally {
      this.launderBusy = false
    }
  }

  /** Focus Le Chat's composer inside the pane, retrying until a composer
   * element exists and holds the caret: a first-ever open is still loading
   * its document, so the frame may briefly have nothing focusable. Bails out
   * the moment the pane closes again, so the keyboard is never dragged into
   * a hidden pane. */
  async focusComposer() {
    const deadline = Date.now() + COMPOSER_FOCUS_SECONDS * 1000
    while (Date.now() < deadline && this.ws.readyState === WebSocket.OPEN) {
      const openAck = await this.call('Runtime.evaluate', {
        expression: PANE_OPEN_EXPRESSION,
        returnByValue: true,
      }, this.appOriginSession)
      if (openAck.error === undefined && openAck.result !== undefined && openAck.result.value !== 1) {
        log('pane closed before the composer appeared; focus request dropped')
        return
      }
      const sessionId = this.frameSession()
      if (sessionId !== undefined) {
        const ack = await this.call('Runtime.evaluate', {
          expression: COMPOSER_FOCUS_EXPRESSION,
          returnByValue: true,
        }, sessionId)
        if (ack.error === undefined && ack.result !== undefined && ack.result.value === 1) {
          log('pane opened: Le Chat composer focused')
          return
        }
      }
      await new Promise(resolve => setTimeout(resolve, 300))
    }
    log('composer focus: no Le Chat composer appeared; keyboard stays as the frame left it')
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
      this.sessions.set(sessionId, { type: targetInfo.type, url: targetInfo.url })
      await this.maybeEnableFetch(targetInfo, sessionId)
      return
    }
    if (msg.method === 'Target.detachedFromTarget') {
      this.sessions.delete(msg.params.sessionId)
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
          const injected = html.replace(/<head[^>]*>/i, m => `${m}<script>${REFILL_SCRIPT}</script>`)
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
// 300ms pane-state polling beside the browser-gone check: the focus handoff
// should land before the first typed character, except on a cold first load
// where retrying inside the task covers the loading frame. The launderer
// rides a slower cadence on the same loop.
let launderAt = 0
for (;;) {
  await new Promise(resolve => setTimeout(resolve, 300))
  if (browser.ws.readyState === WebSocket.CLOSED) {
    log('browser gone; reconnecting')
    process.exit(0)
  }
  browser.paneWatch().catch(error => log(`pane watch failed (${error.message})`))
  if (Date.now() >= launderAt) {
    launderAt = Date.now() + LAUNDER_INTERVAL_MS
    browser.launder().catch(error => log(`launderer failed (${error.message})`))
  }
}
