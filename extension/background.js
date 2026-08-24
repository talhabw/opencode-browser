const NATIVE_HOST_NAME = "com.opencode.browser_automation"
const KEEPALIVE_ALARM = "keepalive"
const PERMISSION_HINT = "Click the OpenCode Browser extension icon and approve requested permissions."
const OPTIONAL_RUNTIME_PERMISSIONS = ["nativeMessaging", "downloads", "debugger"]
const OPTIONAL_RUNTIME_ORIGINS = ["<all_urls>"]

const runtimeManifest = chrome.runtime.getManifest()
const declaredOptionalPermissions = new Set(runtimeManifest.optional_permissions || [])
const declaredOptionalOrigins = new Set(runtimeManifest.optional_host_permissions || [])

let port = null
let isConnected = false
let connectionAttempts = 0
let nativePermissionHintLogged = false

// Debugger state management for devtools (console/errors/network/storage/...)
const debuggerState = new Map()
const MAX_LOG_ENTRIES = 1000
const MAX_NETWORK_ENTRIES = 400

function isString(value) {
  return Object.prototype.toString.call(value) === "[object String]"
}

function isBoolean(value) {
  return value === true || value === false
}

function isRecord(value) {
  return value !== null && !Array.isArray(value) && Object.prototype.toString.call(value) === "[object Object]"
}

function truncateValue(value, maxStringLen = 20000, maxArrayItems = 500) {
  if (value === null || value === undefined) return value
  if (isString(value)) {
    if (value.length <= maxStringLen) return value
    return `${value.slice(0, maxStringLen)}...[truncated, ${value.length} chars total]`
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, maxArrayItems).map((v) => truncateValue(v, maxStringLen, maxArrayItems))
    if (value.length > maxArrayItems) {
      items.push(`...[truncated, ${value.length} items total]`)
    }
    return items
  }
  if (!isRecord(value)) return value
  const out = {}
  for (const key of Object.keys(value)) {
    out[key] = truncateValue(value[key], maxStringLen, maxArrayItems)
  }
  return out
}

async function hasPermissions(query) {
  if (!chrome.permissions?.contains) return true
  try {
    return await chrome.permissions.contains(query)
  } catch {
    return false
  }
}

async function hasNativeMessagingPermission() {
  return await hasPermissions({ permissions: ["nativeMessaging"] })
}

async function hasDebuggerPermission() {
  return await hasPermissions({ permissions: ["debugger"] })
}

async function hasDownloadsPermission() {
  return await hasPermissions({ permissions: ["downloads"] })
}

async function hasHostAccessPermission() {
  return await hasPermissions({ origins: ["<all_urls>"] })
}

async function requestOptionalPermissionsFromClick() {
  if (!chrome.permissions?.contains || !chrome.permissions?.request) {
    return { granted: true, requested: false, permissions: [], origins: [] }
  }

  const permissions = []
  for (const permission of OPTIONAL_RUNTIME_PERMISSIONS) {
    if (!declaredOptionalPermissions.has(permission)) continue
    const granted = await hasPermissions({ permissions: [permission] })
    if (!granted) permissions.push(permission)
  }

  const origins = []
  for (const origin of OPTIONAL_RUNTIME_ORIGINS) {
    if (!declaredOptionalOrigins.has(origin)) continue
    const granted = await hasPermissions({ origins: [origin] })
    if (!granted) origins.push(origin)
  }

  if (!permissions.length && !origins.length) {
    return { granted: true, requested: false, permissions, origins }
  }

  try {
    const granted = await chrome.permissions.request({ permissions, origins })
    return { granted, requested: true, permissions, origins }
  } catch (error) {
    return {
      granted: false,
      requested: true,
      permissions,
      origins,
      error: error?.message || String(error),
    }
  }
}

async function ensureDebuggerAvailable() {
  if (!chrome.debugger?.attach) {
    return {
      ok: false,
      reason: "Debugger API unavailable in this build.",
    }
  }

  const granted = await hasDebuggerPermission()
  if (!granted) {
    return {
      ok: false,
      reason: `Debugger permission not granted. ${PERMISSION_HINT}`,
    }
  }

  return { ok: true }
}

async function ensureDownloadsAvailable() {
  if (!chrome.downloads) {
    throw new Error(`Downloads API unavailable in this build. ${PERMISSION_HINT}`)
  }

  const granted = await hasDownloadsPermission()
  if (!granted) {
    throw new Error(`Downloads permission not granted. ${PERMISSION_HINT}`)
  }
}

async function ensureDebuggerAttached(tabId) {
  const availability = await ensureDebuggerAvailable()
  if (!availability.ok) {
    return {
      attached: false,
      unavailableReason: availability.reason,
      attachError: availability.reason,
      consoleMessages: [],
      pageErrors: [],
      networkRequests: [],
      networkSeq: 0,
    }
  }

  const existing = debuggerState.get(tabId)
  if (existing) {
    // Concurrent first calls share the same in-flight attach.
    if (existing.attaching) await existing.attaching
    return existing
  }

  const state = {
    attached: false,
    attachError: null,
    attaching: null,
    consoleMessages: [],
    pageErrors: [],
    networkRequests: [],
    networkSeq: 0,
  }
  debuggerState.set(tabId, state)

  const attach = (async () => {
    try {
      await chrome.debugger.attach({ tabId }, "1.3")
      try {
        await chrome.debugger.sendCommand({ tabId }, "Runtime.enable")
      } catch (e) {
        // Partial attach: roll back so the tab is not left with a broken debugger.
        try {
          await chrome.debugger.detach({ tabId })
        } catch {}
        throw new Error(`Runtime.enable failed: ${e?.message || String(e)}`)
      }
      try {
        await chrome.debugger.sendCommand({ tabId }, "Network.enable")
      } catch {
        // Network capture is best-effort; other devtools still work without it.
      }
      state.attached = true
    } catch (e) {
      state.attachError = e?.message || String(e)
      console.warn("[OpenCode] Failed to attach debugger:", state.attachError)
      // Drop the failed state so the next call retries from scratch.
      debuggerState.delete(tabId)
    } finally {
      state.attaching = null
    }
  })()

  state.attaching = attach
  await attach
  return state
}

function requireDebugger(state) {
  if (!state?.attached) {
    const reason = state?.attachError || state?.unavailableReason
    throw new Error(
      reason
        ? `Debugger not attached: ${reason}`
        : "Debugger not attached. Close DevTools on the tab (only one debugger may attach) and retry."
    )
  }
}

async function sendDebuggerCommand(tabId, method, params) {
  const tab = await getTabById(tabId)
  const state = await ensureDebuggerAttached(tab.id)
  requireDebugger(state)
  return await chrome.debugger.sendCommand({ tabId: tab.id }, method, params || {})
}

function findNetworkEntry(state, requestId) {
  if (!state.networkRequests) state.networkRequests = []
  let entry = state.networkRequests.find((r) => r.requestId === requestId)
  if (!entry) {
    if (state.networkRequests.length >= MAX_NETWORK_ENTRIES) state.networkRequests.shift()
    // startedAt is filled from the CDP monotonic timestamp on requestWillBeSent;
    // hasCdpStart guards duration math against mismatched clocks.
    entry = { requestId, seq: ++state.networkSeq, startedAt: null, hasCdpStart: false }
    state.networkRequests.push(entry)
  }
  return entry
}

function computeNetworkDuration(entry, finishedAt) {
  if (
    entry.hasCdpStart &&
    entry.startedAt != null &&
    Number.isFinite(entry.startedAt) &&
    Number.isFinite(finishedAt) &&
    finishedAt >= entry.startedAt
  ) {
    entry.duration = Math.round((finishedAt - entry.startedAt) * 1000) / 1000
  }
}

function applyNetworkResponse(entry, response, isRedirect) {
  entry.url = response.url || entry.url
  entry.status = response.status
  entry.statusText = response.statusText
  entry.mimeType = response.mimeType
  entry.responseHeaders = response.headers
  entry.fromDiskCache = response.fromDiskCache || false
  entry.protocol = response.protocol || null
  entry.remoteIPAddress = response.remoteIPAddress || null
  if (response.timing) entry.timing = response.timing
  if (isRedirect) entry.redirected = true
}

if (chrome.debugger?.onEvent) {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    const state = debuggerState.get(source.tabId)
    if (!state) return

    if (method === "Runtime.consoleAPICalled") {
      if (state.consoleMessages.length >= MAX_LOG_ENTRIES) {
        state.consoleMessages.shift()
      }
      state.consoleMessages.push({
        type: params.type,
        text: params.args.map((a) => a.value ?? a.description ?? "").join(" "),
        timestamp: Date.now(),
        source: params.stackTrace?.callFrames?.[0]?.url,
        line: params.stackTrace?.callFrames?.[0]?.lineNumber,
      })
    }

    if (method === "Runtime.exceptionThrown") {
      if (state.pageErrors.length >= MAX_LOG_ENTRIES) {
        state.pageErrors.shift()
      }
      state.pageErrors.push({
        message: params.exceptionDetails.text,
        source: params.exceptionDetails.url,
        line: params.exceptionDetails.lineNumber,
        column: params.exceptionDetails.columnNumber,
        stack: params.exceptionDetails.exception?.description,
        timestamp: Date.now(),
      })
    }

    if (method === "Network.requestWillBeSent") {
      const entry = findNetworkEntry(state, params.requestId)
      entry.url = params.request.url
      entry.method = params.request.method
      entry.type = params.type || entry.type
      entry.initiatorType = params.initiator?.type || entry.initiatorType
      entry.requestHeaders = params.request.headers
      entry.hasPostData = params.request.hasPostData || false
      if (params.timestamp != null) {
        entry.startedAt = params.timestamp
        entry.hasCdpStart = true
      }
      if (params.wallTime != null) entry.wallTime = new Date(params.wallTime * 1000).toISOString()
      if (params.redirectResponse) {
        applyNetworkResponse(entry, params.redirectResponse, true)
      }
    }

    if (method === "Network.responseReceived") {
      const entry = findNetworkEntry(state, params.requestId)
      applyNetworkResponse(entry, params.response, false)
    }

    if (method === "Network.loadingFinished") {
      const entry = findNetworkEntry(state, params.requestId)
      entry.finishedAt = params.timestamp != null ? params.timestamp : entry.finishedAt
      entry.encodedDataLength = params.encodedDataLength
      entry.decodedBodyLength = params.decodedBodyLength
      computeNetworkDuration(entry, params.timestamp)
      entry.responseLoaded = true
    }

    if (method === "Network.loadingFailed") {
      const entry = findNetworkEntry(state, params.requestId)
      entry.failed = true
      entry.errorText = params.errorText
      entry.canceled = !!params.canceled
      entry.finishedAt = params.timestamp != null ? params.timestamp : entry.finishedAt
      entry.type = params.type || entry.type
      computeNetworkDuration(entry, params.timestamp)
    }

    if (method === "Network.webSocketCreated") {
      const entry = findNetworkEntry(state, params.requestId)
      entry.url = params.url
      entry.method = "WebSocket"
      entry.type = "WebSocket"
      entry.wsState = "open"
    }

    if (method === "Network.webSocketFrameSent") {
      const entry = findNetworkEntry(state, params.requestId)
      entry.wsSentFrames = (entry.wsSentFrames || 0) + 1
    }

    if (method === "Network.webSocketFrameReceived") {
      const entry = findNetworkEntry(state, params.requestId)
      entry.wsReceivedFrames = (entry.wsReceivedFrames || 0) + 1
    }

    if (method === "Network.webSocketClosed") {
      const entry = findNetworkEntry(state, params.requestId)
      entry.wsState = "closed"
      entry.finishedAt = params.timestamp != null ? params.timestamp : entry.finishedAt
    }
  })
}

if (chrome.debugger?.onDetach) {
  chrome.debugger.onDetach.addListener((source) => {
    // One debugger per tab: if we get detached (e.g. DevTools UI opened),
    // drop local state so the next devtools call re-attaches cleanly.
    debuggerState.delete(source.tabId)
  })
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (debuggerState.has(tabId)) {
    if (chrome.debugger?.detach) chrome.debugger.detach({ tabId }).catch(() => {})
    debuggerState.delete(tabId)
  }
})

chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.25 })

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    if (!isConnected) connect().catch(() => {})
  }
})

async function connect() {
  if (port) {
    try {
      port.disconnect()
    } catch {}
    port = null
  }

  const nativeMessagingAllowed = await hasNativeMessagingPermission()
  if (!nativeMessagingAllowed) {
    isConnected = false
    updateBadge(false)
    if (!nativePermissionHintLogged) {
      nativePermissionHintLogged = true
      console.log(`[OpenCode] Native messaging permission not granted. ${PERMISSION_HINT}`)
    }
    return
  }

  nativePermissionHintLogged = false

  try {
    port = chrome.runtime.connectNative(NATIVE_HOST_NAME)

    port.onMessage.addListener((message) => {
      handleMessage(message).catch((e) => {
        console.error("[OpenCode] Message handler error:", e)
      })
    })

    port.onDisconnect.addListener(() => {
      isConnected = false
      port = null
      updateBadge(false)

      const err = chrome.runtime.lastError
      if (err?.message) {
        connectionAttempts++
        if (connectionAttempts === 1) {
          console.log("[OpenCode] Native host not available. Run: npx @talhabw/opencode-browser install")
        } else if (connectionAttempts % 20 === 0) {
          console.log("[OpenCode] Still waiting for native host...")
        }
      }
    })

    isConnected = true
    connectionAttempts = 0
    updateBadge(true)
  } catch (e) {
    isConnected = false
    updateBadge(false)
    console.error("[OpenCode] connectNative failed:", e)
  }
}

function updateBadge(connected) {
  chrome.action.setBadgeText({ text: connected ? "ON" : "" })
  chrome.action.setBadgeBackgroundColor({ color: connected ? "#22c55e" : "#ef4444" })
}

function send(message) {
  if (!port) return false
  try {
    port.postMessage(message)
    return true
  } catch {
    return false
  }
}

async function handleMessage(message) {
  if (!isRecord(message)) return

  if (message.type === "tool_request") {
    await handleToolRequest(message)
  } else if (message.type === "ping") {
    send({ type: "pong" })
  }
}

async function handleToolRequest(request) {
  const { id, tool, args } = request

  try {
    const result = await executeTool(tool, args || {})
    send({ type: "tool_response", id, result })
  } catch (error) {
    send({
      type: "tool_response",
      id,
      error: { content: error?.message || String(error) },
    })
  }
}

async function executeTool(toolName, args) {
  const tools = {
    get_active_tab: toolGetActiveTab,
    get_tabs: toolGetTabs,
    open_tab: toolOpenTab,
    close_tab: toolCloseTab,
    navigate: toolNavigate,
    click: toolClick,
    type: toolType,
    select: toolSelect,
    screenshot: toolScreenshot,
    snapshot: toolSnapshot,
    query: toolQuery,
    scroll: toolScroll,
    wait: toolWait,
    download: toolDownload,
    list_downloads: toolListDownloads,
    set_file_input: toolSetFileInput,
    highlight: toolHighlight,
    console: toolConsole,
    errors: toolErrors,
    network: toolNetwork,
    eval: toolEval,
    cookies: toolCookies,
    storage: toolStorage,
    performance: toolPerformance,
    devtools: toolDevtools,
  }

  const fn = tools[toolName]
  if (!fn) throw new Error(`Unknown tool: ${toolName}`)
  return await fn(args)
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) throw new Error("No active tab found")
  return tab
}

async function getTabById(tabId) {
  return tabId ? await chrome.tabs.get(tabId) : await getActiveTab()
}

async function runInPage(tabId, command, args) {
  const hasHostAccess = await hasHostAccessPermission()
  if (!hasHostAccess) {
    throw new Error(`Site access permission not granted. ${PERMISSION_HINT}`)
  }

  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: pageOps,
      args: [command, args || {}],
      world: "ISOLATED",
    })
    return result[0]?.result
  } catch (error) {
    const message = error?.message || String(error)
    if (message.includes("Cannot access contents of the page")) {
      throw new Error(`Site access permission not granted for this page. ${PERMISSION_HINT}`)
    }
    throw error
  }
}

async function pageOps(command, args) {
  const options = args || {}
  const MAX_DEPTH = 6
  const DEFAULT_TIMEOUT_MS = 2000

  function isStringValue(value) {
    return Object.prototype.toString.call(value) === "[object String]"
  }

  function safeString(value) {
    return isStringValue(value) ? value : ""
  }

  function normalizeSelectorList(selector) {
    if (Array.isArray(selector)) {
      return selector.map((s) => safeString(s).trim()).filter(Boolean)
    }
    if (!isStringValue(selector)) return []
    const parts = selector
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    return parts.length ? parts : [selector.trim()].filter(Boolean)
  }

  function stripQuotes(value) {
    return safeString(value).replace(/^['"]|['"]$/g, "")
  }

  function normalizeText(value) {
    return safeString(value).replace(/\s+/g, " ").trim().toLowerCase()
  }

  function matchesText(value, target) {
    if (!target) return false
    const normTarget = normalizeText(target)
    if (!normTarget) return false
    const normValue = normalizeText(value)
    return normValue === normTarget || normValue.includes(normTarget)
  }

  function normalizeLocatorKey(key) {
    if (key === "css") return "css"
    if (key === "label" || key === "field") return "label"
    if (key === "aria" || key === "aria-label") return "aria"
    if (key === "placeholder") return "placeholder"
    if (key === "name") return "name"
    if (key === "role") return "role"
    if (key === "text") return "text"
    if (key === "id") return "id"
    return null
  }

  function parseLocator(raw) {
    const trimmed = safeString(raw).trim()
    if (!trimmed) return { kind: "css", value: "", raw: "" }
    const match = trimmed.match(/^([a-zA-Z_-]+)\s*(=|:)\s*(.+)$/)
    if (match) {
      const key = match[1].toLowerCase()
      const kind = normalizeLocatorKey(key)
      if (kind) {
        return { kind, value: stripQuotes(match[3]), raw: trimmed }
      }
    }
    return { kind: "css", value: trimmed, raw: trimmed }
  }

  function isVisible(el) {
    if (!el) return false
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    const style = window.getComputedStyle(el)
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false
    return true
  }

  function deepQuerySelectorAll(sel, rootDoc) {
    const out = []
    const seen = new Set()

    function addAll(nodeList) {
      for (const el of nodeList) {
        if (!el || seen.has(el)) continue
        seen.add(el)
        out.push(el)
      }
    }

    function walkRoot(root, depth) {
      if (!root || depth > MAX_DEPTH) return
      try {
        addAll(root.querySelectorAll(sel))
      } catch {
        return
      }

      const tree = root.querySelectorAll ? root.querySelectorAll("*") : []
      for (const el of tree) {
        if (el.shadowRoot) {
          walkRoot(el.shadowRoot, depth + 1)
        }
      }

      const frames = root.querySelectorAll ? root.querySelectorAll("iframe") : []
      for (const frame of frames) {
        try {
          const doc = frame.contentDocument
          if (doc) walkRoot(doc, depth + 1)
        } catch {}
      }
    }

    walkRoot(rootDoc || document, 0)
    return out
  }

  function getAriaLabelledByText(el) {
    const ids = safeString(el?.getAttribute?.("aria-labelledby")).split(/\s+/).filter(Boolean)
    if (!ids.length) return ""
    const parts = []
    for (const id of ids) {
      const ref = document.getElementById(id)
      if (ref) parts.push(ref.innerText || ref.textContent || "")
    }
    return parts.join(" ")
  }

  function findByAttribute(attr, target, allowedTags) {
    if (!target) return []
    const nodes = deepQuerySelectorAll(`[${attr}]`, document)
    return nodes.filter((el) => {
      if (Array.isArray(allowedTags) && allowedTags.length && !allowedTags.includes(el.tagName)) return false
      return matchesText(el.getAttribute(attr), target)
    })
  }

  function findByLabelText(target) {
    if (!target) return []
    const results = []
    const seen = new Set()
    const labels = deepQuerySelectorAll("label", document)
    for (const label of labels) {
      if (!matchesText(label.innerText || label.textContent || "", target)) continue
      const control = label.control || label.querySelector("input, textarea, select")
      if (control && !seen.has(control)) {
        seen.add(control)
        results.push(control)
      }
    }
    const labelled = deepQuerySelectorAll("[aria-labelledby]", document)
    for (const el of labelled) {
      if (!matchesText(getAriaLabelledByText(el), target)) continue
      if (!seen.has(el)) {
        seen.add(el)
        results.push(el)
      }
    }
    return results
  }

  function findByRole(target) {
    if (!target) return []
    const nodes = deepQuerySelectorAll("[role]", document)
    return nodes.filter((el) => matchesText(el.getAttribute("role"), target))
  }

  function findByName(target) {
    return findByAttribute("name", target)
  }

  function findByText(target) {
    if (!target) return []
    const results = []
    const seen = new Set()
    const pool = []
    const candidates = deepQuerySelectorAll(
      "button, a, label, option, summary, [role='button'], [role='link'], [role='tab'], [role='menuitem'], [role='option'], [role='listitem'], [role='row'], [tabindex]",
      document
    )
    for (const el of candidates) {
      const text = el.innerText || el.textContent || ""
      if (!matchesText(text, target)) continue
      pool.push({ el, text: normalizeText(text) })
    }

    const generic = deepQuerySelectorAll("div, span, li, article", document)
    for (const el of generic) {
      const text = el.innerText || el.textContent || ""
      if (!matchesText(text, target)) continue
      const style = window.getComputedStyle(el)
      const likelyInteractive =
        !!el.getAttribute("onclick") ||
        !!el.getAttribute("role") ||
        el.tabIndex >= 0 ||
        style.cursor === "pointer"
      if (!likelyInteractive) continue
      pool.push({ el, text: normalizeText(text) })
    }

    const inputs = deepQuerySelectorAll("input[type='button'], input[type='submit'], input[type='reset']", document)
    for (const el of inputs) {
      if (!matchesText(el.value || "", target)) continue
      pool.push({ el, text: normalizeText(el.value || "") })
    }

    const normTarget = normalizeText(target)
    pool.sort((a, b) => {
      const aExact = a.text === normTarget ? 0 : 1
      const bExact = b.text === normTarget ? 0 : 1
      if (aExact !== bExact) return aExact - bExact
      return a.text.length - b.text.length
    })

    for (const { el } of pool) {
      if (!seen.has(el)) {
        seen.add(el)
        results.push(el)
      }
    }
    return results
  }

  function resolveLocator(locator) {
    if (locator.kind === "css") {
      const value = safeString(locator.value)
      if (!value) return []
      return deepQuerySelectorAll(value, document)
    }

    if (locator.kind === "label") return findByLabelText(locator.value)
    if (locator.kind === "aria") return findByAttribute("aria-label", locator.value)
    if (locator.kind === "placeholder") return findByAttribute("placeholder", locator.value, ["INPUT", "TEXTAREA"])
    if (locator.kind === "name") return findByName(locator.value)
    if (locator.kind === "role") return findByRole(locator.value)
    if (locator.kind === "text") return findByText(locator.value)

    if (locator.kind === "id") {
      const idValue = safeString(locator.value).trim()
      if (!idValue) return []
      const escaped = window.CSS && window.CSS.escape ? window.CSS.escape(idValue) : idValue.replace(/[^a-zA-Z0-9_-]/g, "\\$&")
      return deepQuerySelectorAll(`#${escaped}`, document)
    }

    return []
  }

  function resolveMatchesOnce(selectors, index) {
    for (const sel of selectors) {
      const locator = parseLocator(sel)
      if (!locator.value) continue
      const matches = resolveLocator(locator)
      if (!matches.length) continue
      const visible = matches.filter(isVisible)
      const chosen = visible[index] || matches[index] || null
      return { selectorUsed: locator.raw, matches, chosen }
    }
    return { selectorUsed: selectors[0] || "", matches: [], chosen: null }
  }

  async function resolveMatches(selectors, index, timeoutMs, pollMs) {
    let match = resolveMatchesOnce(selectors, index)
    if (timeoutMs > 0) {
      const start = Date.now()
      while (!match.matches.length && Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, pollMs))
        match = resolveMatchesOnce(selectors, index)
      }
    }
    return match
  }

  function clickElement(el) {
    try {
      el.scrollIntoView({ block: "center", inline: "center" })
    } catch {}

    const rect = el.getBoundingClientRect()
    const x = Math.min(Math.max(rect.left + rect.width / 2, 0), window.innerWidth - 1)
    const y = Math.min(Math.max(rect.top + rect.height / 2, 0), window.innerHeight - 1)
    const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }

    try {
      el.dispatchEvent(new MouseEvent("mouseover", opts))
      el.dispatchEvent(new MouseEvent("mousemove", opts))
      el.dispatchEvent(new MouseEvent("mousedown", opts))
      el.dispatchEvent(new MouseEvent("mouseup", opts))
    } catch {}

    try {
      el.click()
    } catch {}
  }

  function setNativeValue(el, value) {
    const tag = el.tagName
    if (tag === "INPUT" || tag === "TEXTAREA") {
      const proto = tag === "INPUT" ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set
      if (setter) setter.call(el, value)
      else el.value = value
      return true
    }
    return false
  }

  function setSelectValue(el, value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set
    if (setter) setter.call(el, value)
    else el.value = value
  }

  function getInputValues() {
    const out = []
    const nodes = document.querySelectorAll("input, textarea")
    nodes.forEach((el) => {
      try {
        const name = el.getAttribute("aria-label") || el.getAttribute("name") || el.id || el.className || el.tagName
        const value = el.value
        if (value != null && String(value).trim()) out.push(`${name}: ${value}`)
      } catch {}
    })
    return out.join("\n")
  }

  function getPseudoText() {
    const out = []
    const elements = Array.from(document.querySelectorAll("*"))
    for (let i = 0; i < elements.length && out.length < 2000; i++) {
      const el = elements[i]
      try {
        const style = window.getComputedStyle(el)
        if (style.display === "none" || style.visibility === "hidden") continue
        const before = window.getComputedStyle(el, "::before").content
        const after = window.getComputedStyle(el, "::after").content
        const pushContent = (content) => {
          if (!content) return
          const c = String(content)
          if (!c || c === "none" || c === "normal") return
          const unquoted = c.replace(/^"|"$/g, "").replace(/^'|'$/g, "")
          if (unquoted && unquoted !== "none" && unquoted !== "normal") out.push(unquoted)
        }
        pushContent(before)
        pushContent(after)
      } catch {}
    }
    return out.join("\n")
  }

  function buildMatches(text, pattern, flags) {
    if (!pattern) return []
    try {
      const re = new RegExp(pattern, flags || "")
      const found = []
      let m
      while ((m = re.exec(text)) && found.length < 50) {
        found.push(m[0])
        if (!re.global) break
      }
      return found
    } catch {
      return []
    }
  }

  function getPageText(limit, pattern, flags) {
    const parts = []
    const bodyText = safeString(document.body?.innerText || "")
    if (bodyText.trim()) parts.push(bodyText)
    const inputValues = getInputValues()
    if (inputValues) parts.push(inputValues)
    const pseudo = getPseudoText()
    if (pseudo) parts.push(pseudo)
    const text = parts.filter(Boolean).join("\n\n").slice(0, Math.max(0, limit))
    return {
      url: location.href,
      title: document.title,
      text,
      matches: buildMatches(text, pattern, flags),
    }
  }

  const mode = isStringValue(options.mode) && options.mode ? options.mode : "text"
  const selectors = normalizeSelectorList(options.selector)
  const index = Number.isFinite(options.index) ? options.index : 0
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : 200
  const limit = Number.isFinite(options.limit) ? options.limit : mode === "page_text" ? 20000 : 50
  const pattern = isStringValue(options.pattern) ? options.pattern : null
  const flags = isStringValue(options.flags) ? options.flags : "i"

  if (command === "click") {
    const match = await resolveMatches(selectors, index, timeoutMs, pollMs)
    if (!match.chosen) {
      return { ok: false, error: `Element not found for selectors: ${selectors.join(", ")}` }
    }
    clickElement(match.chosen)
    return { ok: true, selectorUsed: match.selectorUsed }
  }

  if (command === "type") {
    const text = options.text
    const shouldClear = !!options.clear
    const match = await resolveMatches(selectors, index, timeoutMs, pollMs)
    if (!match.chosen) {
      return { ok: false, error: `Element not found for selectors: ${selectors.join(", ")}` }
    }

    try {
      match.chosen.scrollIntoView({ block: "center", inline: "center" })
    } catch {}

    try {
      match.chosen.focus()
    } catch {}

    const tag = match.chosen.tagName
    const isTextInput = tag === "INPUT" || tag === "TEXTAREA"

    if (isTextInput) {
      if (shouldClear) setNativeValue(match.chosen, "")
      setNativeValue(match.chosen, (match.chosen.value || "") + text)
      match.chosen.dispatchEvent(new Event("input", { bubbles: true }))
      match.chosen.dispatchEvent(new Event("change", { bubbles: true }))
      return { ok: true, selectorUsed: match.selectorUsed }
    }

    if (match.chosen.isContentEditable) {
      if (shouldClear) match.chosen.textContent = ""
      try {
        document.execCommand("insertText", false, text)
      } catch {
        match.chosen.textContent = (match.chosen.textContent || "") + text
      }
      match.chosen.dispatchEvent(new Event("input", { bubbles: true }))
      return { ok: true, selectorUsed: match.selectorUsed }
    }

    return { ok: false, error: `Element is not typable: ${match.selectorUsed} (${tag.toLowerCase()})` }
  }

  if (command === "select") {
    const value = isStringValue(options.value) ? options.value : null
    const label = isStringValue(options.label) ? options.label : null
    const optionIndex = Number.isFinite(options.optionIndex) ? options.optionIndex : null
    const match = await resolveMatches(selectors, index, timeoutMs, pollMs)
    if (!match.chosen) {
      return { ok: false, error: `Element not found for selectors: ${selectors.join(", ")}` }
    }

    const tag = match.chosen.tagName
    if (tag !== "SELECT") {
      return { ok: false, error: `Element is not a select: ${match.selectorUsed} (${tag.toLowerCase()})` }
    }

    if (value === null && label === null && optionIndex === null) {
      return { ok: false, error: "value, label, or optionIndex is required" }
    }

    const selectEl = match.chosen
    const optionList = Array.from(selectEl.options || [])
    let option = null

    if (value !== null) {
      option = optionList.find((opt) => opt.value === value)
    }

    if (!option && label !== null) {
      const target = label.trim()
      option = optionList.find((opt) => (opt.label || opt.textContent || "").trim() === target)
    }

    if (!option && optionIndex !== null) {
      option = optionList[optionIndex]
    }

    if (!option) {
      return { ok: false, error: "Option not found" }
    }

    try {
      selectEl.scrollIntoView({ block: "center", inline: "center" })
    } catch {}

    try {
      selectEl.focus()
    } catch {}

    setSelectValue(selectEl, option.value)
    option.selected = true
    selectEl.dispatchEvent(new Event("input", { bubbles: true }))
    selectEl.dispatchEvent(new Event("change", { bubbles: true }))

    return {
      ok: true,
      selectorUsed: match.selectorUsed,
      value: selectEl.value,
      label: (option.label || option.textContent || "").trim(),
    }
  }

  if (command === "set_file_input") {
    const rawFiles = Array.isArray(options.files) ? options.files : options.files ? [options.files] : []
    if (!rawFiles.length) return { ok: false, error: "files is required" }

    const match = await resolveMatches(selectors, index, timeoutMs, pollMs)
    if (!match.chosen) {
      return { ok: false, error: `Element not found for selectors: ${selectors.join(", ")}` }
    }

    const tag = match.chosen.tagName
    if (tag !== "INPUT" || match.chosen.type !== "file") {
      return { ok: false, error: `Element is not a file input: ${match.selectorUsed} (${tag.toLowerCase()})` }
    }

    function decodeBase64(value) {
      const raw = safeString(value)
      const b64 = raw.includes(",") ? raw.split(",").pop() : raw
      const binary = atob(b64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      return bytes
    }

    const dt = new DataTransfer()
    const names = []

    for (const fileInfo of rawFiles) {
      const name = safeString(fileInfo?.name) || "upload.bin"
      const mimeType = safeString(fileInfo?.mimeType) || "application/octet-stream"
      const base64 = safeString(fileInfo?.base64)
      if (!base64) return { ok: false, error: "file.base64 is required" }
      const bytes = decodeBase64(base64)
      const file = new File([bytes], name, { type: mimeType, lastModified: Date.now() })
      dt.items.add(file)
      names.push(name)
    }

    try {
      match.chosen.scrollIntoView({ block: "center", inline: "center" })
    } catch {}

    try {
      match.chosen.focus()
    } catch {}

    try {
      match.chosen.files = dt.files
    } catch {
      try {
        Object.defineProperty(match.chosen, "files", { value: dt.files, writable: false })
      } catch {
        return { ok: false, error: "Failed to set file input" }
      }
    }

    match.chosen.dispatchEvent(new Event("input", { bubbles: true }))
    match.chosen.dispatchEvent(new Event("change", { bubbles: true }))

    return { ok: true, selectorUsed: match.selectorUsed, count: dt.files.length, names }
  }

  if (command === "scroll") {
    const scrollX = Number.isFinite(options.x) ? options.x : 0
    const scrollY = Number.isFinite(options.y) ? options.y : 0
    if (selectors.length) {
      const match = await resolveMatches(selectors, index, timeoutMs, pollMs)
      if (!match.chosen) {
        return { ok: false, error: `Element not found for selectors: ${selectors.join(", ")}` }
      }
      if (scrollX || scrollY) {
        try {
          match.chosen.scrollBy({ left: scrollX, top: scrollY, behavior: "instant" })
        } catch {
          match.chosen.scrollLeft = Number(match.chosen.scrollLeft || 0) + scrollX
          match.chosen.scrollTop = Number(match.chosen.scrollTop || 0) + scrollY
        }
        return { ok: true, selectorUsed: match.selectorUsed, elementScroll: { x: scrollX, y: scrollY } }
      }

      try {
        match.chosen.scrollIntoView({ behavior: "instant", block: "center" })
      } catch {}
      return { ok: true, selectorUsed: match.selectorUsed }
    }
    window.scrollBy(scrollX, scrollY)
    return { ok: true }
  }

  if (command === "highlight") {
    const duration = Number.isFinite(options.duration) ? options.duration : 3000
    const color = isStringValue(options.color) ? options.color : "#ff0000"
    const showInfo = !!options.showInfo

    const match = await resolveMatches(selectors, index, timeoutMs, pollMs)
    if (!match.chosen) {
      return { ok: false, error: `Element not found for selectors: ${selectors.join(", ")}` }
    }

    const el = match.chosen
    const rect = el.getBoundingClientRect()

    // Remove any existing highlight overlay
    const existing = document.getElementById("__opc_highlight_overlay")
    if (existing) existing.remove()

    // Create overlay
    const overlay = document.createElement("div")
    overlay.id = "__opc_highlight_overlay"
    overlay.style.cssText = `
      position: fixed;
      top: ${rect.top}px;
      left: ${rect.left}px;
      width: ${rect.width}px;
      height: ${rect.height}px;
      border: 3px solid ${color};
      box-shadow: 0 0 10px ${color};
      pointer-events: none;
      z-index: 2147483647;
      transition: opacity 0.3s;
    `

    if (showInfo) {
      const info = document.createElement("div")
      info.style.cssText = `
        position: absolute;
        top: -25px;
        left: 0;
        background: ${color};
        color: white;
        padding: 2px 8px;
        font-size: 12px;
        font-family: monospace;
        border-radius: 3px;
        white-space: nowrap;
      `
      info.textContent = `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}`
      overlay.appendChild(info)
    }

    document.body.appendChild(overlay)

    setTimeout(() => {
      overlay.style.opacity = "0"
      setTimeout(() => overlay.remove(), 300)
    }, duration)

    return {
      ok: true,
      selectorUsed: match.selectorUsed,
      highlighted: true,
      tag: el.tagName,
      id: el.id || null,
    }
  }

  if (command === "query") {
    if (mode === "page_text") {
      if (selectors.length && timeoutMs > 0) {
        await resolveMatches(selectors, index, timeoutMs, pollMs)
      }
      return { ok: true, value: getPageText(limit, pattern, flags) }
    }

    if (!selectors.length) {
      return { ok: false, error: "Selector is required" }
    }

    const match = await resolveMatches(selectors, index, timeoutMs, pollMs)

    if (mode === "exists") {
      return {
        ok: true,
        selectorUsed: match.selectorUsed,
        value: { exists: match.matches.length > 0, count: match.matches.length },
      }
    }

    if (!match.chosen) {
      return { ok: false, error: `No matches for selectors: ${selectors.join(", ")}` }
    }

    if (mode === "text") {
      const text = (match.chosen.innerText || match.chosen.textContent || "").trim()
      return { ok: true, selectorUsed: match.selectorUsed, value: text }
    }

    if (mode === "value") {
      const value = match.chosen.value
      return { ok: true, selectorUsed: match.selectorUsed, value: String(value ?? "") }
    }

    if (mode === "attribute") {
      const value = options.attribute ? match.chosen.getAttribute(options.attribute) : null
      return { ok: true, selectorUsed: match.selectorUsed, value }
    }

    if (mode === "property") {
      if (!options.property) return { ok: false, error: "property is required" }
      return { ok: true, selectorUsed: match.selectorUsed, value: match.chosen[options.property] }
    }

    if (mode === "html") {
      return { ok: true, selectorUsed: match.selectorUsed, value: match.chosen.outerHTML }
    }

    if (mode === "list") {
      const maxItems = Math.min(Math.max(1, limit), 200)
      const items = match.matches.slice(0, maxItems).map((el) => ({
        text: (el.innerText || el.textContent || "").trim().slice(0, 200),
        tag: (el.tagName || "").toLowerCase(),
        ariaLabel: el.getAttribute ? el.getAttribute("aria-label") : null,
      }))
      return {
        ok: true,
        selectorUsed: match.selectorUsed,
        value: { items, count: match.matches.length },
      }
    }

    return { ok: false, error: `Unknown mode: ${mode}` }
  }

  return { ok: false, error: `Unknown command: ${String(command)}` }
}

async function toolGetActiveTab() {
  const tab = await getActiveTab()
  return { tabId: tab.id, content: { tabId: tab.id, url: tab.url, title: tab.title } }
}

async function toolOpenTab({ url, active = true }) {
  const createOptions = {}
  if (isString(url) && url.trim()) createOptions.url = url.trim()
  if (isBoolean(active)) createOptions.active = active

  const tab = await chrome.tabs.create(createOptions)
  return { tabId: tab.id, content: { tabId: tab.id, url: tab.url, active: tab.active } }
}

async function toolCloseTab({ tabId }) {
  if (!Number.isFinite(tabId)) throw new Error("tabId is required")
  await chrome.tabs.remove(tabId)
  return { tabId, content: { tabId, closed: true } }
}

async function toolNavigate({ url, tabId }) {
  if (!url) throw new Error("URL is required")
  const tab = await getTabById(tabId)
  await chrome.tabs.update(tab.id, { url })

  await new Promise((resolve) => {
    const listener = (updatedTabId, info) => {
      if (updatedTabId === tab.id && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener)
        resolve()
      }
    }
    chrome.tabs.onUpdated.addListener(listener)
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener)
      resolve()
    }, 30000)
  })

  return { tabId: tab.id, content: `Navigated to ${url}` }
}

async function toolClick({ selector, tabId, index = 0, timeoutMs, pollMs }) {
  if (!selector) throw new Error("Selector is required")
  const tab = await getTabById(tabId)

  const result = await runInPage(tab.id, "click", { selector, index, timeoutMs, pollMs })
  if (!result?.ok) throw new Error(result?.error || "Click failed")
  const used = result.selectorUsed || selector
  return { tabId: tab.id, content: `Clicked ${used}` }
}

async function toolType({ selector, text, tabId, clear = false, index = 0, timeoutMs, pollMs }) {
  if (!selector) throw new Error("Selector is required")
  if (text === undefined) throw new Error("Text is required")
  const tab = await getTabById(tabId)

  const result = await runInPage(tab.id, "type", { selector, text, clear, index, timeoutMs, pollMs })
  if (!result?.ok) throw new Error(result?.error || "Type failed")
  const used = result.selectorUsed || selector
  return { tabId: tab.id, content: `Typed "${text}" into ${used}` }
}

async function toolSelect({ selector, value, label, optionIndex, tabId, index = 0, timeoutMs, pollMs }) {
  if (!selector) throw new Error("Selector is required")
  if (value === undefined && label === undefined && optionIndex === undefined) {
    throw new Error("value, label, or optionIndex is required")
  }
  const tab = await getTabById(tabId)

  const result = await runInPage(tab.id, "select", { selector, value, label, optionIndex, index, timeoutMs, pollMs })
  if (!result?.ok) throw new Error(result?.error || "Select failed")
  const used = result.selectorUsed || selector
  const valueText = result.value ? String(result.value) : ""
  const labelText = result.label ? String(result.label) : ""
  const summary = labelText && valueText && labelText !== valueText ? `${labelText} (${valueText})` : labelText || valueText
  return { tabId: tab.id, content: `Selected ${summary || "option"} in ${used}` }
}

async function toolScreenshot({ tabId }) {
  const tab = await getTabById(tabId)
  const png = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" })
  return { tabId: tab.id, content: png }
}

async function toolSnapshot({ tabId }) {
  const tab = await getTabById(tabId)

  const result = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      function safeText(s) {
        return Object.prototype.toString.call(s) === "[object String]" ? s : ""
      }

      function isVisible(el) {
        if (!el) return false
        const rect = el.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return false
        const style = window.getComputedStyle(el)
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false
        return true
      }

      function pseudoText(el) {
        try {
          const before = window.getComputedStyle(el, "::before").content
          const after = window.getComputedStyle(el, "::after").content
          const norm = (v) => {
            const s = safeText(v)
            if (!s || s === "none") return ""
            return s.replace(/^"|"$/g, "")
          }
          return { before: norm(before), after: norm(after) }
        } catch {
          return { before: "", after: "" }
        }
      }

      function getName(el) {
        const aria = el.getAttribute("aria-label")
        if (aria) return aria
        const alt = el.getAttribute("alt")
        if (alt) return alt
        const title = el.getAttribute("title")
        if (title) return title
        const placeholder = el.getAttribute("placeholder")
        if (placeholder) return placeholder
        const txt = safeText(el.innerText)
        if (txt.trim()) return txt.slice(0, 200)
        const pt = pseudoText(el)
        const combo = `${pt.before} ${pt.after}`.trim()
        if (combo) return combo.slice(0, 200)
        return ""
      }

      function build(el, depth = 0, uid = 0) {
        if (!el || depth > 12) return { nodes: [], nextUid: uid }
        const nodes = []

        if (!isVisible(el)) return { nodes: [], nextUid: uid }

        const isInteractive =
          ["A", "BUTTON", "INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) ||
          el.getAttribute("onclick") ||
          el.getAttribute("role") === "button" ||
          el.isContentEditable

        const name = getName(el)
        const pt = pseudoText(el)

        const shouldInclude = isInteractive || name.trim() || pt.before || pt.after

        if (shouldInclude) {
          const node = {
            uid: `e${uid}`,
            role: el.getAttribute("role") || el.tagName.toLowerCase(),
            name: name,
            tag: el.tagName.toLowerCase(),
          }

          if (pt.before) node.before = pt.before
          if (pt.after) node.after = pt.after

          if (el.href) node.href = el.href

          if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
            node.type = el.type
            node.value = el.value
            if (el.readOnly) node.readOnly = true
            if (el.disabled) node.disabled = true
          }

          if (el.id) node.selector = `#${el.id}`
          else if (safeText(el.className)) {
            const cls = el.className.trim().split(/\s+/).slice(0, 2).join(".")
            if (cls) node.selector = `${el.tagName.toLowerCase()}.${cls}`
          }

          nodes.push(node)
          uid++
        }

        if (el.shadowRoot) {
          const r = build(el.shadowRoot.host, depth + 1, uid)
          uid = r.nextUid
        }

        for (const child of el.children) {
          const r = build(child, depth + 1, uid)
          nodes.push(...r.nodes)
          uid = r.nextUid
        }

        return { nodes, nextUid: uid }
      }

      function getAllLinks() {
        const links = []
        const seen = new Set()
        document.querySelectorAll("a[href]").forEach((a) => {
          const href = a.href
          if (href && !seen.has(href) && !href.startsWith("javascript:")) {
            seen.add(href)
            const text = a.innerText?.trim().slice(0, 100) || a.getAttribute("aria-label") || ""
            links.push({ href, text })
          }
        })
        return links.slice(0, 200)
      }

      let pageText = ""
      try {
        pageText = safeText(document.body?.innerText || "").slice(0, 20000)
      } catch {}

      const built = build(document.body).nodes.slice(0, 800)

      return {
        url: location.href,
        title: document.title,
        text: pageText,
        nodes: built,
        links: getAllLinks(),
      }
    },
    world: "ISOLATED",
  })

  return { tabId: tab.id, content: JSON.stringify(result[0]?.result, null, 2) }
}

async function toolGetTabs() {
  const tabs = await chrome.tabs.query({})
  const out = tabs.map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId }))
  return { content: JSON.stringify(out, null, 2) }
}

async function toolQuery({
  tabId,
  selector,
  mode = "text",
  attribute,
  property,
  limit,
  index = 0,
  timeoutMs,
  pollMs,
  pattern,
  flags,
}) {
  if (!selector && mode !== "page_text") throw new Error("selector is required")
  const tab = await getTabById(tabId)

  const result = await runInPage(tab.id, "query", {
    selector,
    mode,
    attribute,
    property,
    limit,
    index,
    timeoutMs,
    pollMs,
    pattern,
    flags,
  })

  if (!result?.ok) throw new Error(result?.error || "Query failed")

  if (mode === "list" || mode === "property" || mode === "exists" || mode === "page_text") {
    return { tabId: tab.id, content: JSON.stringify(result, null, 2) }
  }

  return { tabId: tab.id, content: isString(result.value) ? result.value : JSON.stringify(result.value) }
}

async function toolScroll({ x = 0, y = 0, selector, tabId, timeoutMs, pollMs }) {
  const tab = await getTabById(tabId)

  const result = await runInPage(tab.id, "scroll", { x, y, selector, timeoutMs, pollMs })
  if (!result?.ok) throw new Error(result?.error || "Scroll failed")
  const target = result.selectorUsed ? `to ${result.selectorUsed}` : `by (${x}, ${y})`
  return { tabId: tab.id, content: `Scrolled ${target}` }
}

async function toolWait({ ms = 1000, tabId }) {
  await new Promise((resolve) => setTimeout(resolve, ms))
  return { tabId, content: `Waited ${ms}ms` }
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

function normalizeDownloadTimeoutMs(value) {
  return clampNumber(value, 0, 60000, 60000)
}

function waitForNextDownloadCreated(timeoutMs) {
  const timeout = normalizeDownloadTimeoutMs(timeoutMs)
  return new Promise((resolve, reject) => {
    const listener = (item) => {
      cleanup()
      resolve(item)
    }

    const timer = timeout
      ? setTimeout(() => {
          cleanup()
          reject(new Error("Timed out waiting for download to start"))
        }, timeout)
      : null

    function cleanup() {
      chrome.downloads.onCreated.removeListener(listener)
      if (timer) clearTimeout(timer)
    }

    chrome.downloads.onCreated.addListener(listener)
  })
}

async function getDownloadById(downloadId) {
  const items = await chrome.downloads.search({ id: downloadId })
  return items && items.length ? items[0] : null
}

async function waitForDownloadCompletion(downloadId, timeoutMs) {
  const timeout = normalizeDownloadTimeoutMs(timeoutMs)
  const pollMs = 200
  const endAt = Date.now() + timeout

  while (true) {
    const item = await getDownloadById(downloadId)
    if (item && (item.state === "complete" || item.state === "interrupted")) return item
    if (!timeout || Date.now() >= endAt) return item
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

async function toolDownload({
  url,
  selector,
  filename,
  conflictAction,
  saveAs = false,
  wait = false,
  downloadTimeoutMs,
  tabId,
  index = 0,
  timeoutMs,
  pollMs,
}) {
  const hasUrl = isString(url) && url.trim()
  const hasSelector = isString(selector) && selector.trim()

  await ensureDownloadsAvailable()

  if (!hasUrl && !hasSelector) throw new Error("url or selector is required")
  if (hasUrl && hasSelector) throw new Error("Provide either url or selector, not both")

  let downloadId = null

  if (hasUrl) {
    const options = { url: url.trim() }
    if (isString(filename) && filename.trim()) options.filename = filename.trim()
    if (isString(conflictAction) && conflictAction.trim()) options.conflictAction = conflictAction.trim()
    if (isBoolean(saveAs)) options.saveAs = saveAs

    downloadId = await chrome.downloads.download(options)
  } else {
    const tab = await getTabById(tabId)
    const created = waitForNextDownloadCreated(downloadTimeoutMs)
    const clicked = await runInPage(tab.id, "click", { selector, index, timeoutMs, pollMs })
    if (!clicked?.ok) throw new Error(clicked?.error || "Click failed")
    const createdItem = await created
    downloadId = createdItem?.id
  }

  if (!Number.isFinite(downloadId)) throw new Error("Download did not start")

  if (!wait) {
    const item = await getDownloadById(downloadId)
    return { content: { downloadId, item } }
  }

  const item = await waitForDownloadCompletion(downloadId, downloadTimeoutMs)
  return { content: { downloadId, item } }
}

async function toolListDownloads({ limit = 20, state } = {}) {
  await ensureDownloadsAvailable()

  const limitValue = clampNumber(limit, 1, 200, 20)
  const query = { orderBy: ["-startTime"], limit: limitValue }
  if (isString(state) && state.trim()) query.state = state.trim()

  const downloads = await chrome.downloads.search(query)
  const out = downloads.map((d) => ({
    id: d.id,
    url: d.url,
    filename: d.filename,
    state: d.state,
    bytesReceived: d.bytesReceived,
    totalBytes: d.totalBytes,
    startTime: d.startTime,
    endTime: d.endTime,
    error: d.error,
    mime: d.mime,
  }))

  return { content: JSON.stringify({ downloads: out }, null, 2) }
}

async function toolSetFileInput({ selector, tabId, index = 0, timeoutMs, pollMs, files }) {
  if (!selector) throw new Error("Selector is required")
  const tab = await getTabById(tabId)

  const result = await runInPage(tab.id, "set_file_input", { selector, index, timeoutMs, pollMs, files })
  if (!result?.ok) throw new Error(result?.error || "Failed to set file input")
  const used = result.selectorUsed || selector
  return { tabId: tab.id, content: JSON.stringify({ selector: used, ...result }, null, 2) }
}

async function toolHighlight({ selector, tabId, index = 0, duration, color, showInfo, timeoutMs, pollMs }) {
  if (!selector) throw new Error("Selector is required")
  const tab = await getTabById(tabId)

  const result = await runInPage(tab.id, "highlight", {
    selector,
    index,
    duration,
    color,
    showInfo,
    timeoutMs,
    pollMs,
  })
  if (!result?.ok) throw new Error(result?.error || "Highlight failed")
  return {
    tabId: tab.id,
    content: JSON.stringify({
      highlighted: true,
      tag: result.tag,
      id: result.id,
      selectorUsed: result.selectorUsed,
    }),
  }
}

async function toolConsole({ tabId, clear = false, filter } = {}) {
  const tab = await getTabById(tabId)
  const state = await ensureDebuggerAttached(tab.id)

  if (!state.attached) {
    return {
      tabId: tab.id,
      content: JSON.stringify({
        error:
          state.attachError ||
          state.unavailableReason ||
          "Debugger not attached. Close DevTools on the tab (only one debugger may attach).",
        messages: [],
      }),
    }
  }

  let messages = [...state.consoleMessages]

  if (filter && isString(filter)) {
    const filterType = filter.toLowerCase()
    messages = messages.filter((m) => m.type === filterType)
  }

  if (clear) {
    state.consoleMessages = []
  }

  return {
    tabId: tab.id,
    content: JSON.stringify(messages, null, 2),
  }
}

async function toolErrors({ tabId, clear = false } = {}) {
  const tab = await getTabById(tabId)
  const state = await ensureDebuggerAttached(tab.id)

  if (!state.attached) {
    return {
      tabId: tab.id,
      content: JSON.stringify({
        error:
          state.attachError ||
          state.unavailableReason ||
          "Debugger not attached. Close DevTools on the tab (only one debugger may attach).",
        errors: [],
      }),
    }
  }

  const errors = [...state.pageErrors]

  if (clear) {
    state.pageErrors = []
  }

  return {
    tabId: tab.id,
    content: JSON.stringify(errors, null, 2),
  }
}

async function toolNetwork({ tabId, filter, method, limit, onlyFailed, includeBody, clear } = {}) {
  const tab = await getTabById(tabId)
  const state = await ensureDebuggerAttached(tab.id)
  requireDebugger(state)

  try {
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Network.enable", {})
  } catch {}

  if (clear) {
    state.networkRequests = []
    state.networkSeq = 0
    return { tabId: tab.id, content: "Network log cleared. Reload the page to capture a fresh load." }
  }

  let requests = state.networkRequests.map((r) => ({ ...r }))
  const methodFilter = isString(method) && method.trim() ? method.trim().toUpperCase() : null
  const textFilter = isString(filter) && filter.trim() ? filter.trim().toLowerCase() : null

  if (methodFilter || textFilter || onlyFailed) {
    requests = requests.filter((r) => {
      if (onlyFailed && !(r.failed || (Number.isFinite(r.status) && r.status >= 400))) return false
      if (methodFilter && !(r.method || "").toUpperCase().includes(methodFilter)) return false
      if (textFilter) {
        const haystack = [r.url, r.method, r.type, r.status, r.mimeType, r.errorText]
          .filter((v) => v !== undefined && v !== null)
          .join(" ")
          .toLowerCase()
        if (!haystack.includes(textFilter)) return false
      }
      return true
    })
  }

  const maxEntries = includeBody ? 50 : 200
  const limitValue = clampNumber(limit, 1, maxEntries, 100)
  let out = requests.slice(-limitValue)

  if (includeBody) {
    for (const r of out) {
      if (r.responseLoaded && !r.failed) {
        try {
          const body = await chrome.debugger.sendCommand(
            { tabId: tab.id },
            "Network.getResponseBody",
            { requestId: r.requestId }
          )
          const text = body.base64Encoded ? `[base64] ${body.body}` : body.body
          r.responseBody = text.length > 100000 ? `${text.slice(0, 100000)}... (truncated)` : text
        } catch {
          r.responseBodyError = "not available (cached/redirected or body stored offscreen)"
        }
      }
      if (r.hasPostData) {
        try {
          const post = await chrome.debugger.sendCommand(
            { tabId: tab.id },
            "Network.getRequestPostData",
            { requestId: r.requestId }
          )
          const text = post.postData || ""
          r.postData = text.length > 100000 ? `${text.slice(0, 100000)}... (truncated)` : text
        } catch {}
      }
    }
  }

  return {
    tabId: tab.id,
    content: JSON.stringify({ count: out.length, total: requests.length, requests: out }, null, 2),
  }
}

async function toolEval({ tabId, expression, awaitPromise = true } = {}) {
  if (!isString(expression) || !expression.trim()) throw new Error("expression is required")
  const tab = await getTabById(tabId)
  const state = await ensureDebuggerAttached(tab.id)
  requireDebugger(state)

  const result = await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: !!awaitPromise,
  })

  if (result.exceptionDetails) {
    return {
      tabId: tab.id,
      content: JSON.stringify(
        {
          ok: false,
          error: result.exceptionDetails.text || "Uncaught exception",
          exception: result.exceptionDetails.exception?.description || null,
          stack: result.exceptionDetails.stackTrace?.callFrames?.slice(0, 10) || null,
        },
        null,
        2
      ),
    }
  }

  const value = result.result || {}
  return {
    tabId: tab.id,
    content: JSON.stringify(
      {
        ok: true,
        type: value.type || null,
        value:
          value.value !== undefined
            ? truncateValue(value.value)
            : value.unserializableValue !== undefined
              ? truncateValue(value.unserializableValue)
              : value.description ?? null,
      },
      null,
      2
    ),
  }
}

async function toolCookies({ tabId, action = "list", url, name, value, domain, path, expires, httpOnly, secure, sameSite } = {}) {
  const tab = await getTabById(tabId)
  const state = await ensureDebuggerAttached(tab.id)
  requireDebugger(state)
  const target = { tabId: tab.id }
  const permittedActions = ["list", "get", "set", "delete", "clear"]
  if (!permittedActions.includes(action)) {
    throw new Error(`Unknown action: ${action}. Use one of: ${permittedActions.join(", ")}`)
  }

  if (action === "list") {
    const result = url
      ? await chrome.debugger.sendCommand(target, "Network.getCookies", { urls: [url] })
      : await chrome.debugger.sendCommand(target, "Network.getAllCookies", {})
    return { tabId: tab.id, content: JSON.stringify({ count: (result.cookies || []).length, cookies: result.cookies || [] }, null, 2) }
  }

  if (action === "get") {
    if (!isString(name) || !name) throw new Error("name is required")
    const cookies = url
      ? (await chrome.debugger.sendCommand(target, "Network.getCookies", { urls: [url] })).cookies || []
      : (await chrome.debugger.sendCommand(target, "Network.getAllCookies", {})).cookies || []
    const matches = cookies.filter((c) => c.name === name)
    if (!matches.length) return { tabId: tab.id, content: JSON.stringify({ found: false, cookie: null }) }
    return { tabId: tab.id, content: JSON.stringify({ found: true, cookie: matches[0] }, null, 2) }
  }

  if (action === "set") {
    if (!isString(name) || !name) throw new Error("name is required")
    if (value === undefined) throw new Error("value is required (pass url or domain too)")
    const cookie = { name, value: String(value) }
    if (isString(url) && url.trim()) cookie.url = url.trim()
    else if (isString(domain) && domain.trim()) cookie.domain = domain.trim()
    else throw new Error("url or domain is required to set a cookie")
    if (isString(path) && path.trim()) cookie.path = path.trim()
    if (Number.isFinite(expires)) cookie.expires = expires
    if (isBoolean(httpOnly)) cookie.httpOnly = httpOnly
    if (isBoolean(secure)) cookie.secure = secure
    if (isString(sameSite) && sameSite.trim()) {
      const normalized = sameSite.trim()
      const valid = ["Strict", "Lax", "None"].includes(normalized)
      if (!valid) throw new Error(`sameSite must be Strict, Lax, or None (got: ${normalized})`)
      cookie.sameSite = normalized
    }
    const result = await chrome.debugger.sendCommand(target, "Network.setCookie", cookie)
    return {
      tabId: tab.id,
      content: JSON.stringify({ ok: !!result.success, cookie }, null, 2),
    }
  }

  if (action === "delete") {
    if (!isString(name) || !name) throw new Error("name is required")
    const params = { name }
    if (isString(url) && url.trim()) params.url = url.trim()
    if (isString(domain) && domain.trim()) params.domain = domain.trim()
    if (isString(path) && path.trim()) params.path = path.trim()
    if (!params.url && !params.domain) throw new Error("url or domain is required to delete a cookie")
    await chrome.debugger.sendCommand(target, "Network.deleteCookies", params)
    return { tabId: tab.id, content: `Deleted cookie: ${params.name}` }
  }

  // action === "clear"
  await chrome.debugger.sendCommand(target, "Network.clearBrowserCookies", {})
  return { tabId: tab.id, content: "All cookies cleared" }
}

async function toolStorage({ tabId, action = "list", storage = "local", key, value } = {}) {
  if (storage !== "local" && storage !== "session") {
    throw new Error(`Unknown storage: ${storage}. Use "local" or "session"`)
  }
  const storageName = storage === "session" ? "sessionStorage" : "localStorage"
  const tab = await getTabById(tabId)
  const state = await ensureDebuggerAttached(tab.id)
  requireDebugger(state)

  let expression = null
  if (action === "list") {
    expression = `({ origin: location.origin, items: Object.entries(${storageName}).map(([k, v]) => ({ key: k, value: v })) })`
  } else if (action === "get") {
    if (!isString(key) || !key) throw new Error("key is required")
    expression = `(() => { const v = ${storageName}.getItem(${JSON.stringify(key)}); return ({ origin: location.origin, found: v !== null, value: v }) })()`
  } else if (action === "set") {
    if (!isString(key) || !key) throw new Error("key is required")
    if (value === undefined) throw new Error("value is required")
    expression = `${storageName}.setItem(${JSON.stringify(key)}, ${JSON.stringify(String(value))}); ({ origin: location.origin, ok: true })`
  } else if (action === "remove") {
    if (!isString(key) || !key) throw new Error("key is required")
    expression = `${storageName}.removeItem(${JSON.stringify(key)}); ({ origin: location.origin, ok: true })`
  } else if (action === "clear") {
    expression = `${storageName}.clear(); ({ origin: location.origin, ok: true })`
  } else {
    throw new Error(`Unknown action: ${action}. Use one of: list, get, set, remove, clear`)
  }

  const result = await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", {
    expression,
    returnByValue: true,
  })

  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Storage operation failed")
  }

  const out = { action, storage: storageName, result: result.result?.value ?? null }
  return {
    tabId: tab.id,
    content: JSON.stringify(truncateValue(out), null, 2),
  }
}

async function toolPerformance({ tabId, resources = false } = {}) {
  const tab = await getTabById(tabId)
  const state = await ensureDebuggerAttached(tab.id)
  requireDebugger(state)

  try {
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Performance.enable", {})
  } catch {}

  const perf = await chrome.debugger.sendCommand({ tabId: tab.id }, "Performance.getMetrics", {})
  const out = {
    metrics: (perf.metrics || []).map((m) => ({ name: m.name, value: m.value })),
  }

  if (resources) {
    const expression = `(() => {
      const nav = performance.getEntriesByType("navigation")[0] || null
      const res = performance.getEntriesByType("resource").slice(-100).map((e) => ({
        name: e.name,
        initiatorType: e.initiatorType,
        duration: e.duration,
        transferSize: e.transferSize,
        decodedBodySize: e.decodedBodySize,
        status: e.responseStatus || null,
      }))
      return { origin: location.origin, navigation: nav ? { name: nav.name, url: nav.url, domContentLoadedEnd: nav.domContentLoadedEventEnd, loadEnd: nav.loadEventEnd, duration: nav.duration, transferSize: nav.transferSize } : null, resources: res }
    })()`
    const r = await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", {
      expression,
      returnByValue: true,
    })
    if (!r.exceptionDetails) out.resourceTiming = truncateValue(r.result?.value ?? null, 5000, 100)
  }

  return { tabId: tab.id, content: JSON.stringify(out, null, 2) }
}

async function toolDevtools({ tabId, method, params } = {}) {
  if (!isString(method) || !method.trim()) {
    throw new Error('method is required, e.g. "DOM.getDocument" (Chrome DevTools Protocol command)')
  }
  if (params !== undefined && !isRecord(params)) {
    throw new Error("params must be a JSON object")
  }

  const result = await sendDebuggerCommand(tabId, method.trim(), params)
  return { tabId: (await getTabById(tabId)).id, content: JSON.stringify({ ok: true, method: method.trim(), result }, null, 2) }
}

chrome.runtime.onInstalled.addListener(() => connect().catch(() => {}))
chrome.runtime.onStartup.addListener(() => connect().catch(() => {}))

if (chrome.permissions?.onAdded) {
  chrome.permissions.onAdded.addListener(() => connect().catch(() => {}))
}

chrome.action.onClicked.addListener(async () => {
  const permissionResult = await requestOptionalPermissionsFromClick()
  if (!permissionResult.granted) {
    updateBadge(false)
    if (permissionResult.error) {
      console.warn("[OpenCode] Permission request failed:", permissionResult.error)
    } else {
      console.warn("[OpenCode] Permission request denied.")
    }
    return
  }

  if (permissionResult.requested) {
    const requestedPermissions = permissionResult.permissions.join(", ") || "none"
    const requestedOrigins = permissionResult.origins.join(", ") || "none"
    console.log(`[OpenCode] Requested permissions -> permissions: ${requestedPermissions}; origins: ${requestedOrigins}`)
  }

  await connect()
})

connect().catch(() => {})
