/**
 * lechat-in-app.js — Mistral Le Chat embedded as a switchable pane in the
 * DeepSeek Harness window.
 *
 * A small framework-free overlay beside the SPA root: a Mistral-mark button
 * docked bottom-left toggles a sliding right-side pane that hosts
 * chat.mistral.ai in a sandboxed iframe. The iframe is created lazily and kept
 * alive across toggles, so the Le Chat session (and login) persists for the
 * life of the window. Layered on this being a LOCAL page: chat.mistral.ai
 * serves X-Frame-Options: SAMEORIGIN and CSP frame-ancestors, so rendering
 * inside this window relies on scripts/lechat-frame-permit.mjs — started by
 * the PWA launcher alongside the window — stripping exactly those headers from
 * document responses through the window's DevTools port. Without the
 * interceptor (e.g. plain `dsh web` in a desktop app build without the
 * launch wiring), the pane still opens but the frame shows a blocked page.
 *
 * Toggle: the button, or Ctrl+Alt+M; Escape closes. Both also work from
 * INSIDE the pane: a key listener injected into Le Chat's documents echoes
 * Escape/Ctrl+Alt+M back here through postMessage (a cross-origin frame never
 * reaches the window keydown), and the app translates that the same way.
 *
 * Focus handoff both ways, so nobody ever clicks between chat surfaces:
 * a user-gesture open routes the keyboard into the Le Chat frame instantly
 * and marks the panel so the permit daemon focuses Le Chat's actual composer
 * (the caret needs a CDP evaluate inside the cross-origin frame); closing the
 * pane — from either side — puts the keyboard back on the harness composer
 * (`div[data-composer-input]`, the same raw focus the app itself uses).
 * The boot-time restore of an open pane never grabs focus.
 *
 * State: open/closed in localStorage; session persists between toggles.
 */
;(function () {
  'use strict'

  var OPEN_KEY = 'dsh-lechat-pane-open'
  var URL = 'https://chat.mistral.ai/'
  // Origins the pane accepts a dismissal echo from: the embedded chat and its
  // auth pages carry the daemon-injected key listener.
  var ECHO_ORIGINS = ['https://chat.mistral.ai', 'https://v2.auth.mistral.ai']
  var started = false
  var panel, frame, btn

  /** The Mistral brand mark (mistral.ai/favicon.svg). */
  var MARK = '<svg viewBox="0 0 183 183" fill="none" xmlns="http://www.w3.org/2000/svg">'
    + '<rect x="33" y="33" width="24" height="23" fill="#FFAF01"/>'
    + '<rect x="33" y="56" width="47" height="24" fill="#FF8204"/>'
    + '<rect x="33" y="80" width="118" height="23" fill="#FA500F"/>'
    + '<rect x="127" y="103" width="24" height="24" fill="#E10500"/>'
    + '<rect x="80" y="103" width="24" height="24" fill="#E10500"/>'
    + '<rect x="33" y="103" width="24" height="24" fill="#E10500"/>'
    + '<rect x="104" y="127" width="70" height="23" fill="#C4001D"/>'
    + '<rect x="10" y="127" width="70" height="23" fill="#C4001D"/>'
    + '<rect x="104" y="56" width="47" height="24" fill="#FF8204"/>'
    + '<rect x="127" y="33" width="24" height="23" fill="#FFAF01"/>'
    + '</svg>'

  var CSS = [
    '.dsh-lechat-btn{position:fixed;left:14px;bottom:14px;width:44px;height:44px;border-radius:50%;',
    'border:1px solid rgba(128,128,128,.35);background:#fff;display:flex;align-items:center;justify-content:center;',
    'cursor:pointer;z-index:2147483000;box-shadow:0 2px 10px rgba(0,0,0,.28);transition:transform .15s ease,box-shadow .15s ease;',
    'box-sizing:border-box;padding:9px;-webkit-user-select:none;user-select:none}',
    '.dsh-lechat-btn:hover{transform:translateY(-2px);box-shadow:0 6px 16px rgba(0,0,0,.34)}',
    '.dsh-lechat-btn svg{width:100%;height:100%;display:block}',
    '.dsh-lechat-btn.active{box-shadow:0 0 0 2px #FA500F,0 2px 10px rgba(0,0,0,.35)}',
    '.dsh-lechat-panel{position:fixed;top:0;right:0;bottom:0;width:min(48vw,820px);display:flex;flex-direction:column;',
    'background:#fff;z-index:2147482999;border-radius:12px 0 0 12px;overflow:hidden;',
    'box-shadow:-10px 0 38px rgba(0,0,0,.42);transform:translateX(103%);transition:transform .22s ease;',
    'border-left:1px solid rgba(128,128,128,.3)}',
    '.dsh-lechat-panel.open{transform:translateX(0)}',
    '.dsh-lechat-head{display:flex;align-items:center;gap:8px;height:38px;padding:0 10px;',
    'border-bottom:1px solid rgba(128,128,128,.25);-webkit-user-select:none;user-select:none}',
    '.dsh-lechat-dot{width:10px;height:10px;border-radius:3px;background:linear-gradient(135deg,#FFAF01,#FA500F 55%,#C4001D)}',
    '.dsh-lechat-title{font:600 12.5px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;flex:1;',
    'color:inherit;letter-spacing:.02em;text-transform:uppercase;opacity:.82}',
    '.dsh-lechat-x{border:0;background:transparent;cursor:pointer;font:400 15px/1 system-ui,sans-serif;',
    'width:24px;height:24px;border-radius:6px;color:inherit;opacity:.65}',
    '.dsh-lechat-x:hover{opacity:1;background:rgba(128,128,128,.18)}',
    '.dsh-lechat-frame{flex:1;width:100%;border:0;background:#fff}',
    '@media(prefers-color-scheme:dark){',
    '.dsh-lechat-btn{background:#1b1b1f;border-color:rgba(160,160,170,.3)}',
    '.dsh-lechat-panel{background:#1b1b1f}.dsh-lechat-frame{background:#1b1b1f;color:#eee}',
    '.dsh-lechat-title,.dsh-lechat-x{color:#eee}}',
  ].join('')

  function ensureDom() {
    if (started) return
    started = true
    var style = document.createElement('style')
    style.textContent = CSS
    document.head.appendChild(style)

    btn = document.createElement('button')
    btn.className = 'dsh-lechat-btn'
    btn.type = 'button'
    btn.title = 'Mistral Le Chat (Ctrl+Alt+M)'
    btn.setAttribute('aria-label', 'Toggle Le Chat pane')
    btn.innerHTML = MARK
    btn.addEventListener('click', toggle)

    panel = document.createElement('div')
    panel.className = 'dsh-lechat-panel'
    panel.setAttribute('role', 'complementary')
    panel.setAttribute('aria-label', 'Mistral Le Chat')

    var head = document.createElement('div')
    head.className = 'dsh-lechat-head'
    var dot = document.createElement('span')
    dot.className = 'dsh-lechat-dot'
    var title = document.createElement('span')
    title.className = 'dsh-lechat-title'
    title.textContent = 'Mistral Le Chat'
    var close = document.createElement('button')
    close.className = 'dsh-lechat-x'
    close.type = 'button'
    close.title = 'Close (Escape)'
    close.setAttribute('aria-label', 'Close Le Chat pane')
    close.textContent = '\u2715'
    close.addEventListener('click', hide)
    head.appendChild(dot)
    head.appendChild(title)
    // The browser's third-party cookie isolation keeps Le Chat's sign-in
    // session out of the embedded frame by design (this Helium build force-
    // denies Storage Access too), so signing in needs a top-level Le Chat
    // window from the same profile — where the session persists — while the
    // pane keeps its anonymous Le Chat surface.
    var open = document.createElement('button')
    open.className = 'dsh-lechat-x'
    open.type = 'button'
    open.title = 'Sign in: open Le Chat in a window'
    open.setAttribute('aria-label', 'Open Le Chat in a window to sign in')
    open.textContent = '\u2197'

    open.addEventListener('click', function () {
      window.open('https://chat.mistral.ai/', 'dsh-lechat', 'noopener')
    })
    head.appendChild(open)
    head.appendChild(close)

    frame = document.createElement('iframe')
    frame.className = 'dsh-lechat-frame'
    frame.setAttribute('referrerpolicy', 'no-referrer')
    frame.setAttribute('allow', 'clipboard-read; clipboard-write; microphone; camera')
    frame.setAttribute('sandbox',
      'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox '
      + 'allow-modals allow-downloads allow-storage-access-by-user-activation allow-presentation')

    panel.appendChild(head)
    panel.appendChild(frame)
    document.body.appendChild(panel)
    document.body.appendChild(btn)

    window.addEventListener('keydown', function (event) {
      if (event.ctrlKey && event.altKey && !event.shiftKey && !event.metaKey
        && (event.key === 'm' || event.key === 'M')) {
        event.preventDefault()
        toggle()
      } else if (event.key === 'Escape' && isOpen()) {
        hide()
      }
    }, true)

    // Dismissal echo from inside the pane: Le Chat documents run a small
    // injected listener (see scripts/lechat-frame-permit.mjs) that forwards
    // Escape/Ctrl+Alt+M here, because key events never cross the origin
    // boundary on their own.
    window.addEventListener('message', function (event) {
      if (event.data !== 'dsh-lechat-dismiss' || ECHO_ORIGINS.indexOf(event.origin) === -1) return
      if (isOpen()) hide()
    })

    if (localStorage.getItem(OPEN_KEY) === '1') show()
  }

  function isOpen() {
    return started && panel.classList.contains('open')
  }

  function toggle() {
    isOpen() ? hide() : show(true)
  }

  function show(fromUser) {
    if (!frame.getAttribute('src')) frame.src = URL
    panel.classList.add('open')
    btn.classList.add('active')
    localStorage.setItem(OPEN_KEY, '1')
    if (fromUser) {
      // Route the keyboard into the frame right away (cross-origin Window
      // focus is one of the few calls allowed across the boundary); typing
      // then reaches whatever holds focus inside Le Chat — the composer,
      // once the daemon's watcher lands the caret there.
      try { frame.contentWindow.focus() } catch (e) { /* frame missing: ignore */ }
      // Mailbox read-and-cleared by the daemon's poll: this pane-open wants
      // the composer focused.
      panel.setAttribute('data-lechat-focus', '1')
    }
  }

  function hide() {
    panel.classList.remove('open')
    btn.classList.remove('active')
    localStorage.setItem(OPEN_KEY, '0')
    // Disarm any not-yet-consumed focus request: an open-close race within
    // one daemon poll must not focus the composer of a closed pane.
    panel.removeAttribute('data-lechat-focus')
    // Back to the harness chat panel: the same raw element focus the app's
    // own focusDraftEditor uses, so Lexical picks up and restores selection.
    var composer = document.querySelector('div[data-composer-input]')
    if (composer) {
      try { composer.focus({ preventScroll: true }) } catch (e) { /* absent: ignore */ }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureDom)
  } else {
    ensureDom()
  }
})()
