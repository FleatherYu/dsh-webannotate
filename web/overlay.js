/**
 * dsh-webannotate — the in-page overlay.
 *
 * This file is injected into every page the built-in browser opens (the host
 * half does the injecting). It is a self-contained IIFE: no imports, no
 * globals beyond one namespaced object, and it re-runs safely on every
 * navigation because `boot()` returns early once installed.
 *
 * UX in one sentence: a small 「批注」pill sits in the bottom-right corner;
 * switching it on turns the pointer into a picker, a click on an element opens
 * a compact comment box, saving pins a numbered marker on that element and
 * adds a row to the batch list; 「发送全部」hands the batch to the host, which
 * turns it into one chat message for the agent.
 */
;(() => {
  const VERSION = '0.1.0'
  const NS = 'dsh-webannotate'
  const MARKER_ATTR = 'data-dsh-webannotate-id'
  const MAX_TEXT = 90
  const MAX_QUOTE = 160

  if (window.__dshWebAnnotate && window.__dshWebAnnotate.version === VERSION) {
    return
  }

  /* ------------------------------------------------------------- utilities */

  const clamp = (value, min, max) => (value < min ? min : value > max ? max : value)

  function textOf(node) {
    if (!node) return ''
    const raw = typeof node.getAttribute === 'function' ? node.getAttribute('aria-label') || node.textContent || '' : ''
    const flat = String(raw).replace(/\s+/gu, ' ').trim()
    return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT - 1)}…` : flat
  }

  function quoteOf(node) {
    if (!node) return ''
    const flat = String(node).replace(/\s+/gu, ' ').trim()
    return flat.length > MAX_QUOTE ? `${flat.slice(0, MAX_QUOTE - 1)}…` : flat
  }

  function escapeIdent(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value)
    return String(value).replace(/[^a-zA-Z0-9_-]/gu, (char) => `\\${char}`)
  }

  /** A short, human-checkable selector: `#id`, `.a.b`, or `tag:nth-of-type`. */
  function selectorOf(element) {
    if (!element || element.nodeType !== 1) return ''
    if (element.id) return `#${escapeIdent(element.id)}`
    const parts = []
    let node = element
    let depth = 0
    while (node && node.nodeType === 1 && depth < 4) {
      const tag = node.tagName.toLowerCase()
      if (tag === 'html' || tag === 'body') {
        parts.unshift(tag)
        break
      }
      if (node.id) {
        parts.unshift(`#${escapeIdent(node.id)}`)
        break
      }
      const testId = node.getAttribute('data-testid') || node.getAttribute('data-test-id')
      if (testId) {
        parts.unshift(`${tag}[data-testid="${testId}"]`)
        break
      }
      const classes = Array.from(node.classList || [])
        .filter((name) => name && !/^(is-|has-)|^js-/u.test(name))
        .slice(0, 2)
        .map((name) => `.${escapeIdent(name)}`)
        .join('')
      let part = `${tag}${classes}`
      const parent = node.parentElement
      if (parent) {
        const sameTag = Array.from(parent.children).filter((child) => child.tagName === node.tagName)
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`
      }
      parts.unshift(part)
      node = parent
      depth += 1
    }
    return parts.join(' > ') || element.tagName.toLowerCase()
  }

  /** Best-effort component name for React / Vue front-ends. */
  function componentOf(element) {
    try {
      for (const key in element) {
        if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
          let fiber = element[key]
          for (let depth = 0; fiber && depth < 24; depth += 1) {
            const type = fiber.elementType || fiber.type
            const name =
              typeof type === 'function'
                ? type.displayName || type.name
                : typeof type === 'string'
                  ? ''
                  : type && (type.displayName || type.name)
            if (name && /^[A-Z]/u.test(name)) return name
            fiber = fiber.return
          }
          return ''
        }
        if (key.startsWith('__vueParentComponent') || key.startsWith('__vue__')) {
          const instance = element[key]
          const name = instance && instance.type && (instance.type.__name || instance.type.name)
          return name || ''
        }
      }
    } catch {
      /* the page's framework internals are a bonus, never a requirement */
    }
    return ''
  }

  function cssOf(element) {
    try {
      const style = window.getComputedStyle(element)
      return {
        display: style.display,
        color: style.color,
        backgroundColor: style.backgroundColor,
        fontSize: style.fontSize,
        padding: style.padding,
        margin: style.margin,
        width: Math.round(element.getBoundingClientRect().width),
        height: Math.round(element.getBoundingClientRect().height),
      }
    } catch {
      return null
    }
  }

  function isOwnUi(node) {
    const host = uiHost
    if (!host || !node) return false
    return host === node || (node.nodeType === 1 && host.contains(node))
  }

  function fiberOf(element) {
    try {
      for (const key in element) {
        if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) return element[key]
      }
    } catch {
      /* framework internals are a bonus, never a requirement */
    }
    return null
  }

  /**
   * React 18/19 dev builds and Vue keep the JSX / SFC that rendered an element.
   * `file:line` is what lets the agent open the exact source instead of guessing
   * from a class chain, so it is worth walking the owner chain for.
   */
  function sourceOf(element) {
    try {
      let node = fiberOf(element)
      for (let depth = 0; node && depth < 32; depth += 1) {
        const direct = node._debugSource
        if (direct && typeof direct.fileName === 'string' && direct.fileName) {
          return `${direct.fileName}:${direct.lineNumber || 0}`
        }
        const info = node._debugInfo
        if (Array.isArray(info)) {
          for (const entry of info) {
            if (entry && typeof entry.fileName === 'string' && entry.fileName) {
              return `${entry.fileName}:${entry.lineNumber || 0}`
            }
          }
        }
        node = node.return
      }
      const vue = element.__vueParentComponent || element.__vueParentInstance
      const file = vue && vue.type && vue.type.__file
      if (typeof file === 'string' && file) return file
    } catch {
      /* production builds strip this; the selector stays the fallback */
    }
    return ''
  }

  /** The component nesting that owns the element, outermost first. */
  function componentChain(element) {
    const names = []
    try {
      let node = fiberOf(element)
      for (let depth = 0; node && depth < 28; depth += 1) {
        const type = node.elementType || node.type
        const name =
          typeof type === 'function'
            ? type.displayName || type.name
            : type && (type.displayName || type.name)
        if (name && /^[A-Z]/u.test(name) && !names.includes(name)) names.push(name)
        if (names.length >= 4) break
        node = node.return
      }
    } catch {
      /* ignore */
    }
    return names.reverse().join(' > ')
  }

  function describeTarget(element) {
    const rect = element.getBoundingClientRect()
    return {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      selector: selectorOf(element),
      tag: element.tagName.toLowerCase(),
      component: componentOf(element),
      components: componentChain(element),
      source: sourceOf(element),
      text: textOf(element),
      quote: '',
      comment: '',
      css: cssOf(element),
      // Geometry snapshot: if the element is gone or hidden by the time the
      // batch is sent (dialogs close, menus re-render), the chat half can still
      // point the screenshot at the document position the user meant.
      rect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
        docY: Math.round(rect.top + window.scrollY),
      },
      scrollY: Math.round(window.scrollY),
      at: Date.now(),
      url: location.href,
    }
  }

  /* ------------------------------------------------------------------ state */

  const state = {
    mode: false,
    picking: null,
    pendingQuote: '',
    items: [],
    openItemId: '',
    listOpen: false,
    draft: null,
    editing: false,
    toast: '',
  }
  /** id → { element, badge } */
  const pins = new Map()
  const storeKey = () => `${NS}:${location.origin}${location.pathname}`

  function persist() {
    try {
      sessionStorage.setItem(
        storeKey(),
        JSON.stringify(
          state.items.map((item) => ({
            id: item.id,
            selector: item.selector,
            tag: item.tag,
            component: item.component,
            text: item.text,
            quote: item.quote,
            comment: item.comment,
            css: item.css,
            rect: item.rect || null,
            scrollY: item.scrollY || 0,
            at: item.at,
            url: item.url,
          })),
        ),
      )
    } catch {
      /* private-mode quota is not worth a broken overlay */
    }
  }

  function restore() {
    let raw = ''
    try {
      raw = sessionStorage.getItem(storeKey()) || ''
    } catch {
      return
    }
    if (!raw) return
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) state.items = parsed.filter((item) => item && item.selector)
    } catch {
      /* a corrupt key only loses the draft */
    }
  }

  /* ------------------------------------------------------------------- view */

  let uiHost = null
  let shadow = null
  let layer = null
  let pill = null
  let listButton = null
  let dock = null
  let hoverBox = null
  let composer = null
  let listPanel = null
  let toastNode = null

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .wrap {
      font: 12px/1.45 -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
      color: #1f2328;
      -webkit-font-smoothing: antialiased;
      pointer-events: none;
    }
    /* The host is a full-viewport, inert layer pinned at the top of the page's
       stacking order; only these surfaces take pointer events back. */
    .pill, .card, .list, .countbtn { pointer-events: auto; }
    .toast { pointer-events: none; }
    button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
    .dock { position: fixed; right: 14px; bottom: 14px; z-index: 3; display: flex; align-items: center; gap: 6px; width: max-content; }
    .dock .pill { position: static; width: max-content; flex: none; }
    .pill {
      position: fixed; right: 14px; bottom: 14px; z-index: 3;
      display: flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px;
      border-radius: 13px; background: rgba(32, 36, 44, .82); color: #fff;
      box-shadow: 0 2px 10px rgba(0,0,0,.22); backdrop-filter: blur(7px);
      font-size: 11.5px; letter-spacing: .2px; user-select: none;
    }
    .pill:hover { background: rgba(32, 36, 44, .95); }
    .pill[data-on="true"] { background: #2f6feb; }
    .pill .dot { width: 5px; height: 5px; border-radius: 50%; background: #8ab4ff; }
    .pill .count { min-width: 15px; height: 15px; padding: 0 4px; border-radius: 8px; background: #fff; color: #20242c; font-size: 10px; line-height: 15px; text-align: center; }
    .countbtn {
      display: inline-block; height: 26px; min-width: 26px; padding: 0 7px; border-radius: 13px;
      background: #2f6feb; color: #fff; font-size: 11.5px; line-height: 26px; text-align: center;
      font-variant-numeric: tabular-nums; box-shadow: 0 2px 10px rgba(0,0,0,.22);
    }
    .countbtn:hover { background: #2760d0; }
    .layer { position: fixed; inset: 0; z-index: 2; pointer-events: none; }
    .hoverbox {
      position: absolute; border: 1.5px solid #2f6feb; border-radius: 3px;
      background: rgba(47,111,235,.10); transition: all .04s linear;
    }
    .hovertag {
      position: absolute; left: 0; top: 0; transform: translateY(-100%);
      max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      padding: 1px 5px; border-radius: 3px 3px 0 0; background: #2f6feb; color: #fff; font-size: 10.5px;
    }
    .pin {
      position: absolute; width: 17px; height: 17px; margin: -8.5px 0 0 -8.5px;
      border-radius: 50%; background: #2f6feb; color: #fff; font-size: 10px; line-height: 17px;
      text-align: center; box-shadow: 0 1px 4px rgba(0,0,0,.3); pointer-events: auto; cursor: pointer;
      border: 1.5px solid #fff;
    }
    .pin.flash { animation: dash .7s ease-out 2; }
    @keyframes dash { 50% { box-shadow: 0 0 0 5px rgba(47,111,235,.35); } }

    .card {
      position: fixed; z-index: 5; width: 320px; padding: 9px 10px;
      border-radius: 8px; background: #fff; border: 1px solid #d8dde5;
      box-shadow: 0 8px 26px rgba(20,26,36,.18);
    }
    .card .head { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
    .card .where { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #57606a; font-size: 11px; }
    .card .where b { color: #1f2328; font-weight: 600; }
    .card .tag { flex: none; padding: 0 5px; height: 16px; line-height: 16px; border-radius: 8px; background: rgba(47,111,235,.10); color: #2f6feb; font-size: 10px; }
    .x { width: 18px; height: 18px; border-radius: 4px; color: #6e7781; font-size: 13px; line-height: 16px; text-align: center; }
    .x:hover { background: #f1f3f6; color: #1f2328; }
    textarea {
      width: 100%; height: 58px; resize: vertical; padding: 6px 7px; font: inherit; font-size: 12px;
      color: #1f2328; border: 1px solid #d8dde5; border-radius: 6px; outline: none; background: #fff;
    }
    textarea:focus { border-color: #2f6feb; box-shadow: 0 0 0 3px rgba(47,111,235,.13); }
    .actions { display: flex; align-items: center; gap: 6px; }
    .hint { flex: 1; color: #8a939d; font-size: 10.5px; }
    .btn { flex: none; white-space: nowrap; height: 24px; padding: 0 10px; border-radius: 6px; border: 1px solid #d8dde5; color: #1f2328; font-size: 11.5px; }
    .btn:hover { background: #f6f8fa; }
    .btn.primary { background: #2f6feb; border-color: #2f6feb; color: #fff; }
    .btn.primary:hover { background: #2760d0; }
    .btn.ghost { border-color: transparent; color: #6e7781; }

    .list {
      position: fixed; right: 14px; bottom: 46px; z-index: 4; width: min(272px, calc(100vw - 28px)); max-height: min(40vh, 360px);
      display: flex; flex-direction: column; border-radius: 9px; background: #fff;
      border: 1px solid #d8dde5; box-shadow: 0 10px 30px rgba(20,26,36,.18); overflow: hidden;
    }
    .list > header { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-bottom: 1px solid #eef1f5; background: #fbfcfd; }
    .list > header .title { flex: 1; font-size: 11.5px; font-weight: 600; }
    .list > header .url { max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #8a939d; font-size: 10.5px; }
    .rows { overflow: auto; }
    .row { display: flex; gap: 6px; padding: 6px 8px; border-bottom: 1px solid #f2f4f7; }
    .row:last-child { border-bottom: 0; }
    .row:hover { background: #fbfcfd; }
    .row .num { flex: none; width: 15px; height: 15px; margin-top: 1px; border-radius: 50%; background: #2f6feb; color: #fff; font-size: 9px; line-height: 15px; text-align: center; }
    .row .body { flex: 1; min-width: 0; cursor: pointer; }
    .row .body:hover .comment { color: #1f2328; }
    .row .top { display: flex; align-items: center; gap: 5px; min-width: 0; }
    .row .sel { flex: 1; min-width: 0; color: #6e7781; font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
    .row .sel:hover { color: #2f6feb; text-decoration: underline; }
    .row .comment {
      margin-top: 1px; font-size: 11.5px; line-height: 1.45; white-space: pre-wrap; word-break: break-word;
      display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
    }
    .row .quote { margin-top: 1px; padding-left: 5px; border-left: 2px solid #e3e7ed; color: #6e7781; font-size: 10px; }
    .row .tools { display: flex; flex-direction: column; gap: 2px; }
    .row .tools button { width: 18px; height: 18px; border-radius: 4px; color: #8a939d; font-size: 11px; }
    .row .tools button:hover { background: #f1f3f6; color: #1f2328; }
    .list > footer { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-top: 1px solid #eef1f5; background: #fbfcfd; }
    .list > footer .url { min-width: 0; flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #8a939d; font-size: 10.5px; }
    .list > footer .spacer { flex: 1; min-width: 8px; }
    .empty { padding: 16px 9px; color: #8a939d; font-size: 11.5px; text-align: center; }

    .toast {
      position: fixed; right: 14px; bottom: 48px; z-index: 6; max-width: 300px;
      padding: 6px 10px; border-radius: 6px; background: rgba(32,36,44,.92); color: #fff; font-size: 11.5px;
    }
    .toast[data-tone="ok"] { background: #1f7a4d; }
    .toast[data-tone="warn"] { background: #a25b00; }
  `

  function h(tag, props, ...children) {
    const node = document.createElement(tag)
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value === null || value === undefined || value === false) continue
        if (key === 'class') node.className = value
        else if (key === 'text') node.textContent = value
        else if (key === 'html') node.innerHTML = value
        else if (key === 'style') node.setAttribute('style', value)
        else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value)
        else node.setAttribute(key, value === true ? '' : String(value))
      }
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue
      node.append(child.nodeType ? child : document.createTextNode(String(child)))
    }
    return node
  }

  function mountUi() {
    if (uiHost) return
    uiHost = document.createElement('div')
    uiHost.setAttribute('data-dsh-webannotate', 'root')
    // Fixed full-viewport host with the maximum z-index: pages routinely pin
    // their own sidebar/toolbar at 9999, and anything lower would let that
    // sidebar paint over the comment card. The host itself is inert; the pill,
    // card and list opt back into pointer events through CSS.
    uiHost.style.cssText =
      'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;overflow:visible'
    shadow = uiHost.attachShadow({ mode: 'open' })
    shadow.append(h('style', { text: CSS }))
    const wrap = h('div', { class: 'wrap' })
    shadow.append(wrap)

    layer = h('div', { class: 'layer' })
    hoverBox = h('div', { class: 'hoverbox', style: 'display:none' })
    layer.append(hoverBox)

    pill = h(
      'button',
      {
        class: 'pill',
        title: '网页批注：点击进入标注模式，再点页面上的元素写意见',
        'data-on': 'false',
        onclick: () => toggleMode(),
      },
      h('span', { class: 'dot' }),
      h('span', { class: 'label', text: '批注' }),
    )

    // Saving a comment is not the end of the flow, but the send button lives in
    // the list — so the list keeps a compact entry once something has been
    // annotated: a numbered bubble, with the purpose spelled out on hover.
    listButton = h('button', {
      class: 'countbtn',
      style: 'display:none',
      title: '查看本页批注，确认后一次性发送到对话',
      onclick: () => (state.listOpen ? closeList() : openList()),
    })

    dock = h('div', { class: 'dock' })
    dock.append(pill, listButton)

    wrap.append(layer, dock)
    document.documentElement.append(uiHost)
    renderPill()
  }

  function renderPill() {
    if (!pill) return
    pill.setAttribute('data-on', state.mode ? 'true' : 'false')
    const label = pill.querySelector('.label')
    if (label) label.textContent = state.mode ? '标注中' : '批注'
    if (listButton) {
      const total = state.items.length
      listButton.style.display = total ? '' : 'none'
      listButton.textContent = String(total)
      listButton.title = `查看 ${total} 条批注，确认后一次性发送到对话`
    }
  }

  function showToast(message, tone = 'ok', ttl = 2200) {
    if (!shadow) return
    if (toastNode) toastNode.remove()
    toastNode = h('div', { class: 'toast', 'data-tone': tone, text: message })
    shadow.querySelector('.wrap').append(toastNode)
    setTimeout(() => {
      if (toastNode) {
        toastNode.remove()
        toastNode = null
      }
    }, ttl)
  }

  /* ------------------------------------------------------------ interaction */

  function toggleMode(force) {
    state.mode = typeof force === 'boolean' ? force : !state.mode
    if (state.mode) {
      try {
        const selection = window.getSelection()
        const text = selection && selection.rangeCount ? quoteOf(selection.toString()) : ''
        if (text) {
          state.pendingQuote = text
          showToast(`已记录选区引用：${text.slice(0, 22)}…`)
        }
      } catch {
        /* selection is optional */
      }
    } else {
      hideHover()
      closeComposer()
    }
    renderPill()
  }

  function hideHover() {
    if (hoverBox) hoverBox.style.display = 'none'
  }

  function onPointerMove(event) {
    if (!state.mode || state.draft) return
    const target = event.target
    if (!target || target.nodeType !== 1 || isOwnUi(target)) return
    if (state.picking && state.picking === target) return
    state.picking = target
    const rect = target.getBoundingClientRect()
    hoverBox.style.cssText = `display:block;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px`
    let tag = hoverBox.querySelector('.hovertag')
    if (!tag) {
      tag = h('span', { class: 'hovertag' })
      hoverBox.append(tag)
    }
    const component = componentOf(target)
    tag.textContent = `${target.tagName.toLowerCase()}${component ? ` · ${component}` : ''}${textOf(target) ? ` · ${textOf(target)}` : ''}`
  }

  function onClickCapture(event) {
    if (!state.mode || state.draft) return
    const target = event.target
    if (!target || target.nodeType !== 1 || isOwnUi(target)) return
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
    openComposer(target)
  }

  function onKeyDown(event) {
    if (event.key !== 'Escape') return
    if (state.draft) {
      closeComposer()
      event.preventDefault()
      return
    }
    if (state.mode) {
      toggleMode(false)
      event.preventDefault()
    }
  }

  function blockNav(event) {
    if (!state.mode || state.draft) return
    event.preventDefault()
    event.stopPropagation()
  }

  /* ---------------------------------------------------------------- composer */

  /**
   * Without `existing` this starts a new annotation on `element`; with it, the
   * same composer re-opens pre-filled so a saved comment can be edited in place
   * (`element` may be null when the annotated node no longer exists).
   */
  function openComposer(element, existing) {
    closeComposer()
    const draft = element
      ? describeTarget(element)
      : {
          id: existing.id,
          selector: existing.selector,
          tag: existing.tag,
          component: existing.component,
          text: existing.text,
          css: existing.css,
          components: existing.components || '',
          source: existing.source || '',
          rect: existing.rect || null,
          scrollY: existing.scrollY || 0,
          at: existing.at || Date.now(),
          url: existing.url || location.href,
        }
    if (existing) {
      draft.id = existing.id
      draft.comment = existing.comment || ''
      draft.quote = existing.quote || ''
    } else {
      draft.quote = state.pendingQuote || ''
    }
    state.draft = draft
    state.editing = Boolean(existing)
    const width = 320
    let left
    let top
    if (element) {
      const rect = element.getBoundingClientRect()
      left = clamp(rect.left, 8, window.innerWidth - width - 8)
      top = rect.bottom + 8 + 190 < window.innerHeight ? rect.bottom + 8 : clamp(rect.top - 190, 8, window.innerHeight - 200)
    } else {
      left = clamp((window.innerWidth - width) / 2, 8, window.innerWidth - width - 8)
      top = clamp(window.innerHeight / 2 - 110, 8, window.innerHeight - 230)
    }

    const textarea = h('textarea', {
      placeholder: '这里要怎么改？（Ctrl+Enter 保存，Esc 取消）',
      onkeydown: (event) => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault()
          saveDraft()
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          closeComposer()
        }
      },
    })
    textarea.value = draft.comment || ''
    const head = h(
      'div',
      { class: 'head' },
      h('div', { class: 'where', html: `<b>${draft.tag}</b>${draft.component ? ` · ${draft.component}` : ''} · ${draft.selector}` }),
      existing ? h('span', { class: 'tag', text: '编辑' }) : null,
      h('button', { class: 'x', title: '取消（Esc）', text: '✕', onclick: () => closeComposer() }),
    )
    const hint = h('span', { class: 'hint', text: existing ? '编辑中 · Ctrl+Enter 保存' : 'Ctrl+Enter 保存' })
    const actions = h(
      'div',
      { class: 'actions' },
      hint,
      h('button', { class: 'btn ghost', text: '取消', onclick: () => closeComposer() }),
      h('button', { class: 'btn primary', text: '保存', onclick: () => saveDraft() }),
    )
    composer = h(
      'div',
      { class: 'card', style: `left:${left}px;top:${top}px` },
      head,
      textarea,
      draft.quote ? h('div', { class: 'quote', text: `引用：${draft.quote}` }) : null,
      actions,
    )
    shadow.querySelector('.wrap').append(composer)
    hideHover()
    textarea.focus()
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
  }

  function closeComposer() {
    if (composer) {
      composer.remove()
      composer = null
    }
    state.draft = null
    state.editing = false
    state.pendingQuote = ''
  }

  function saveDraft() {
    if (!state.draft || !composer) return
    const textarea = composer.querySelector('textarea')
    const comment = textarea ? textarea.value.trim() : ''
    if (!comment) {
      if (textarea) textarea.focus()
      showToast('先写一句要怎么改', 'warn')
      return
    }
    const wasEditing = state.editing
    const item = { ...state.draft, comment, quote: state.draft.quote || '' }
    const existing = state.items.findIndex((entry) => entry.id === item.id)
    if (existing >= 0) state.items[existing] = item
    else state.items.push(item)
    persist()
    closeComposer()
    renderPins()
    renderPill()
    renderList()
    showToast(
      wasEditing ? '已更新这条批注' : `已记下第 ${state.items.length} 条，点右下角数字统一发送`,
      'ok',
      wasEditing ? 1600 : 2600,
    )
  }

  /** Re-open a saved annotation in the composer, in place. */
  function editItem(item) {
    if (!item) return
    const element = elementFor(item)
    openComposer(element && element.isConnected ? element : null, item)
  }

  function removeItem(id) {
    state.items = state.items.filter((item) => item.id !== id)
    persist()
    renderPins()
    renderPill()
    renderList()
  }

  /* ------------------------------------------------------------------- pins */

  function elementFor(item) {
    const existing = pins.get(item.id)
    if (existing && existing.element && existing.element.isConnected) return existing.element
    try {
      return document.querySelector(item.selector)
    } catch {
      return null
    }
  }

  function renderPins() {
    if (!layer) return
    for (const [id, pin] of pins) {
      if (!state.items.some((item) => item.id === id)) {
        pin.badge.remove()
        pins.delete(id)
      }
    }
    state.items.forEach((item, index) => {
      const element = elementFor(item)
      let entry = pins.get(item.id)
      if (!entry) {
        const badge = h('div', {
          class: 'pin',
          text: String(index + 1),
          title: item.comment || item.selector,
          onclick: (event) => {
            event.stopPropagation()
            event.preventDefault()
            editItem(item)
          },
        })
        layer.append(badge)
        entry = { badge, element }
        pins.set(item.id, entry)
      }
      entry.element = element
      if (element) {
        entry.badge.style.display = ''
        entry.badge.textContent = String(index + 1)
        entry.badge.title = `${index + 1}. ${item.comment || item.selector}（点击编辑）`
      } else {
        entry.badge.style.display = 'none'
      }
    })
    positionPins()
  }

  function positionPins() {
    for (const [, entry] of pins) {
      if (!entry.badge || entry.badge.style.display === 'none') continue
      const element = entry.element
      if (!element || !element.isConnected) {
        entry.badge.style.display = 'none'
        continue
      }
      const rect = element.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) {
        entry.badge.style.display = 'none'
        continue
      }
      entry.badge.style.display = ''
      entry.badge.style.left = `${rect.left + rect.width}px`
      entry.badge.style.top = `${rect.top}px`
    }
  }

  function flash(item) {
    const element = elementFor(item)
    if (!element) {
      showToast('这个元素已经不在页面上了（可能路由变了）', 'warn')
      return
    }
    element.scrollIntoView({ block: 'center', behavior: 'smooth' })
    const entry = pins.get(item.id)
    if (entry && entry.badge) {
      entry.badge.classList.remove('flash')
      void entry.badge.offsetWidth
      entry.badge.classList.add('flash')
    }
  }

  /* ------------------------------------------------------------------- list */

  function openList() {
    state.listOpen = true
    renderList()
  }

  function closeList() {
    state.listOpen = false
    renderList()
  }

  function renderList() {
    if (!shadow) return
    if (listPanel) {
      listPanel.remove()
      listPanel = null
    }
    if (!state.listOpen) return
    const rows = h('div', { class: 'rows' })
    if (!state.items.length) {
      rows.append(h('div', { class: 'empty', text: '还没有批注。点「批注」进入标注模式，再点页面上要改的地方。' }))
    }
    state.items.forEach((item, index) => {
      rows.append(
        h(
          'div',
          { class: 'row' },
          h('div', { class: 'num', text: String(index + 1) }),
          h(
            'div',
            { class: 'body', title: '点击编辑这条批注', onclick: () => editItem(item) },
            h(
              'div',
              { class: 'top' },
              h('div', {
                class: 'sel',
                title: '点一下定位到页面上的元素',
                text: `${item.selector}${item.component ? ` · ${item.component}` : ''}`,
                onclick: (event) => {
                  event.stopPropagation()
                  flash(item)
                },
              }),
            ),
            h('div', { class: 'comment', text: item.comment }),
            item.quote ? h('div', { class: 'quote', text: `引用：${item.quote}` }) : null,
          ),
          h(
            'div',
            { class: 'tools' },
            h('button', { text: '✎', title: '编辑这条批注', onclick: () => editItem(item) }),
            h('button', { text: '✕', title: '删除这条批注', onclick: () => removeItem(item.id) }),
          ),
        ),
      )
    })
    const footer = h(
      'footer',
      null,
      h('span', { class: 'url', text: `${location.pathname}` }),
      h('span', { class: 'spacer' }),
      state.items.length ? h('button', { class: 'btn ghost', text: '清空', onclick: () => clearAll() }) : null,
      h('button', {
        class: 'btn primary',
        text: `发送全部 (${state.items.length})`,
        disabled: state.items.length ? null : true,
        style: state.items.length ? '' : 'opacity:.45;cursor:default',
        onclick: () => submitAll(),
      }),
    )
    listPanel = h(
      'div',
      { class: 'list' },
      h(
        'header',
        null,
        h('span', { class: 'title', text: `本页批注 ${state.items.length}` }),
        h('button', { class: 'x', title: '收起列表（批注会保留）', text: '✕', onclick: () => closeList() }),
      ),
      rows,
      footer,
    )
    shadow.querySelector('.wrap').append(listPanel)
  }

  function clearAll() {
    state.items = []
    persist()
    renderPins()
    renderPill()
    renderList()
    showToast('已清空本页批注', 'ok', 1400)
  }

  function rectOf(item) {
    const element = elementFor(item)
    if (!element) return null
    const rect = element.getBoundingClientRect()
    if (!(rect.width > 0) || !(rect.height > 0)) return null
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      // Document-space top: stays valid while the page scrolls, so the chat half
      // can scroll back to this element before taking the grouped screenshot.
      docY: Math.round(rect.top + window.scrollY),
    }
  }

  /**
   * Geometry recorded when the user saved the note. Used only when the element
   * is no longer measurable, so a closed dialog still gets a screenshot of the
   * place it used to occupy.
   */
  function snapshotRect(item) {
    const rect = item && item.rect
    if (!rect || !(rect.w > 0) || !(rect.h > 0)) return null
    const scrollY = Number(item.scrollY) || 0
    return {
      x: rect.x,
      y: rect.y,
      w: rect.w,
      h: rect.h,
      docY: Number.isFinite(rect.docY) ? rect.docY : rect.y + scrollY,
      stale: true,
    }
  }

  function submitAll() {
    if (!state.items.length) return
    const payload = {
      type: 'submit',
      url: location.href,
      origin: location.origin,
      title: document.title,
      // The chat half groups items by scroll position and takes one screenshot
      // per group, so the geometry travels in viewport coordinates plus the
      // document-space top of every element.
      viewport: {
        w: window.innerWidth,
        h: window.innerHeight,
        dpr: window.devicePixelRatio || 1,
        scrollY: Math.round(window.scrollY),
        docH: Math.max(
          document.documentElement.scrollHeight,
          document.body ? document.body.scrollHeight : 0,
        ),
      },
      items: state.items.map((item, index) => ({
        index: index + 1,
        selector: item.selector,
        tag: item.tag,
        component: item.component || '',
        components: item.components || '',
        source: item.source || '',
        text: item.text || '',
        quote: item.quote || '',
        css: item.css || null,
        comment: item.comment,
        rect: rectOf(item) || snapshotRect(item),
      })),
    }
    pushOutbox(payload)
    showToast(`正在发送 ${state.items.length} 条批注…`, 'ok', 2000)
    state.mode = false
    hideHover()
    closeComposer()
    closeList()
    renderPill()
  }

  /* ----------------------------------------------------------------- outbox */

  const outbox = []

  function pushOutbox(action) {
    outbox.push(action)
  }

  /** Called by the host half through `executeJavaScript`; drains the queue. */
  function takeOutbox() {
    if (!outbox.length) return []
    return outbox.splice(0, outbox.length)
  }

  /* -------------------------------------------------------------------- boot */

  function onScrollOrResize() {
    positionPins()
    if (state.mode && state.picking && hoverBox && hoverBox.style.display !== 'none') {
      const rect = state.picking.getBoundingClientRect()
      hoverBox.style.cssText = `display:block;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px`
    }
  }

  let rafPending = false
  function scheduleReposition() {
    if (rafPending) return
    rafPending = true
    requestAnimationFrame(() => {
      rafPending = false
      onScrollOrResize()
    })
  }

  function boot() {
    if (document.documentElement.querySelector('[data-dsh-webannotate="root"]')) {
      // another copy (for example from a previous HMR reload) is alive; take over
      const stale = document.documentElement.querySelector('[data-dsh-webannotate="root"]')
      if (stale !== uiHost) stale.remove()
    }
    restore()
    mountUi()
    renderPill()
    renderPins()
    document.addEventListener('mousemove', onPointerMove, true)
    document.addEventListener('click', onClickCapture, true)
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('mousedown', blockNav, true)
    document.addEventListener('auxclick', blockNav, true)
    window.addEventListener('scroll', scheduleReposition, { passive: true, capture: true })
    window.addEventListener('resize', scheduleReposition, { passive: true })
    try {
      new MutationObserver(scheduleReposition).observe(document.documentElement, { childList: true, subtree: true })
    } catch {
      /* repositioning also runs on scroll */
    }
  }

  /**
   * Called back by the DSH half once the chat accepted (or refused) a batch.
   * Until this lands the page only knows the batch left the page.
   */
  function notify(action) {
    if (!action || typeof action.ok !== 'boolean') return
    if (action.ok) {
      const images = Number(action.images) || 0
      state.items = []
      persist()
      renderPins()
      renderPill()
      renderList()
      if (action.note) {
        showToast(String(action.note), 'warn', 4000)
        return
      }
      showToast(images > 0 ? `已发送（含 ${images} 张截图），切回对话即可看到` : '已发送，切回对话即可看到', 'ok', 2400)
      return
    }
    showToast(`发送失败：${action.error || '未知原因'}（批注还在列表里）`, 'warn', 4000)
  }

  window.__dshWebAnnotate = {
    version: VERSION,
    boot,
    outbox: takeOutbox,
    notify,
    toggle: (force) => toggleMode(force),
    state: () => ({
      mode: state.mode,
      count: state.items.length,
      listOpen: state.listOpen,
      url: location.href,
    }),
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => boot(), { once: true })
  } else {
    boot()
  }
})()
