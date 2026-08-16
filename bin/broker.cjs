#!/usr/bin/env node
"use strict";

const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");

const BASE_DIR = path.join(os.homedir(), ".opencode-browser");
const SOCKET_PATH = getBrokerSocketPath();

function getSafePipeName() {
  try {
    const username = os.userInfo().username || "user";
    return `opencode-browser-${username}`.replace(/[^a-zA-Z0-9._-]/g, "_");
  } catch {
    return "opencode-browser";
  }
}

function getBrokerSocketPath() {
  const override = process.env.OPENCODE_BROWSER_BROKER_SOCKET;
  if (override) return override;
  if (process.platform === "win32") return `\\\\.\\pipe\\${getSafePipeName()}`;
  return path.join(BASE_DIR, "broker.sock");
}

fs.mkdirSync(BASE_DIR, { recursive: true });

const DEFAULT_LEASE_TTL_MS = 5 * 60 * 1000;
const LEASE_TTL_MS = (() => {
  const raw = process.env.OPENCODE_BROWSER_CLAIM_TTL_MS;
  const value = Number(raw);
  if (Number.isFinite(value) && value >= 0) return value;
  return DEFAULT_LEASE_TTL_MS;
})();
const LEASE_SWEEP_MS =
  LEASE_TTL_MS > 0 ? Math.min(Math.max(10000, Math.floor(LEASE_TTL_MS / 2)), 60000) : 0;

function nowMs() {
  return Date.now();
}

function nowIso() {
  return new Date().toISOString();
}

function createJsonLineParser(onMessage) {
  let buffer = "";
  return (chunk) => {
    buffer += chunk.toString("utf8");
    while (true) {
      const idx = buffer.indexOf("\n");
      if (idx === -1) return;
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        onMessage(JSON.parse(line));
      } catch {
        // ignore
      }
    }
  };
}

function writeJsonLine(socket, msg) {
  socket.write(JSON.stringify(msg) + "\n");
}

function wantsTab(toolName) {
  return !["get_tabs", "get_active_tab", "open_tab", "list_downloads"].includes(toolName);
}

// --- State ---
let host = null; // { socket }
let nextExtId = 0;
const extPending = new Map(); // extId -> { pluginSocket, pluginRequestId, sessionId }

const clients = new Set();

// Tab ownership: tabId -> { sessionId, claimedAt, lastSeenAt }
const claims = new Map();
// Session state: sessionId -> { defaultTabId, lastSeenAt }
const sessionState = new Map();

function listClaims() {
  const out = [];
  for (const [tabId, info] of claims.entries()) {
    out.push({
      tabId,
      sessionId: info.sessionId,
      claimedAt: info.claimedAt,
      lastSeenAt: new Date(info.lastSeenAt).toISOString(),
    });
  }
  out.sort((a, b) => a.tabId - b.tabId);
  return out;
}

function sessionHasClaims(sessionId) {
  for (const info of claims.values()) {
    if (info.sessionId === sessionId) return true;
  }
  return false;
}

function getSessionState(sessionId) {
  if (!sessionId) return null;
  let state = sessionState.get(sessionId);
  if (!state) {
    state = { defaultTabId: null, lastSeenAt: nowMs() };
    sessionState.set(sessionId, state);
  }
  return state;
}

function touchSession(sessionId) {
  const state = getSessionState(sessionId);
  if (!state) return null;
  state.lastSeenAt = nowMs();
  return state;
}

function setDefaultTab(sessionId, tabId) {
  const state = getSessionState(sessionId);
  if (!state) return;
  state.defaultTabId = tabId;
  state.lastSeenAt = nowMs();
}

function clearDefaultTab(sessionId, tabId) {
  const state = sessionState.get(sessionId);
  if (!state) return;
  if (tabId === undefined || state.defaultTabId === tabId) {
    state.defaultTabId = null;
  }
  state.lastSeenAt = nowMs();
}

function releaseClaim(tabId) {
  const info = claims.get(tabId);
  if (!info) return;
  claims.delete(tabId);
  clearDefaultTab(info.sessionId, tabId);
}

function releaseClaimsForSession(sessionId) {
  for (const [tabId, info] of claims.entries()) {
    if (info.sessionId === sessionId) claims.delete(tabId);
  }
  clearDefaultTab(sessionId);
  sessionState.delete(sessionId);
}

function checkClaim(tabId, sessionId) {
  const existing = claims.get(tabId);
  if (!existing) return { ok: true };
  if (existing.sessionId === sessionId) return { ok: true };
  return { ok: false, error: `Tab ${tabId} is owned by another OpenCode session (${existing.sessionId})` };
}

function setClaim(tabId, sessionId) {
  const existing = claims.get(tabId);
  claims.set(tabId, {
    sessionId,
    claimedAt: existing ? existing.claimedAt : nowIso(),
    lastSeenAt: nowMs(),
  });
}

function touchClaim(tabId, sessionId) {
  const existing = claims.get(tabId);
  if (existing && existing.sessionId !== sessionId) return;
  if (existing) {
    existing.lastSeenAt = nowMs();
  } else {
    setClaim(tabId, sessionId);
  }
}

function cleanupStaleClaims() {
  if (!LEASE_TTL_MS) return;
  const now = nowMs();
  for (const [tabId, info] of claims.entries()) {
    if (now - info.lastSeenAt > LEASE_TTL_MS) {
      releaseClaim(tabId);
    }
  }
  for (const [sessionId, state] of sessionState.entries()) {
    if (!sessionHasClaims(sessionId) && now - state.lastSeenAt > LEASE_TTL_MS) {
      sessionState.delete(sessionId);
    }
  }
}

function ensureHost() {
  if (host && host.socket && !host.socket.destroyed) return;
  throw new Error("Chrome extension is not connected (native host offline)");
}

function callExtension(tool, args, sessionId) {
  ensureHost();
  const extId = ++nextExtId;

  return new Promise((resolve, reject) => {
    extPending.set(extId, { resolve, reject, sessionId });
    writeJsonLine(host.socket, {
      type: "to_extension",
      message: { type: "tool_request", id: extId, tool, args },
    });

    const timeout = setTimeout(() => {
      if (!extPending.has(extId)) return;
      extPending.delete(extId);
      reject(new Error("Timed out waiting for extension"));
    }, 60000);

    // attach timeout to resolver
    const pending = extPending.get(extId);
    if (pending) pending.timeout = timeout;
  });
}

async function ensureSessionTab(sessionId) {
  if (!sessionId) throw new Error("Missing sessionId for tab creation");
  const res = await callExtension("open_tab", { active: false }, sessionId);
  const tabId = res && Number.isFinite(res.tabId) ? res.tabId : undefined;
  if (!tabId) throw new Error("Failed to create a new tab for this session");
  touchClaim(tabId, sessionId);
  setDefaultTab(sessionId, tabId);
  return tabId;
}

async function handleTool(pluginSocket, req) {
  const { tool, args = {}, sessionId } = req;
  if (!tool) throw new Error("Missing tool");

  if (sessionId) touchSession(sessionId);

  let tabId = args.tabId;
  const toolArgs = { ...args };

  const isCloseTool = tool === "close_tab";

  if (wantsTab(tool)) {
    if (!Number.isFinite(tabId)) {
      const state = getSessionState(sessionId);
      const defaultTabId = state && Number.isFinite(state.defaultTabId) ? state.defaultTabId : null;
      if (Number.isFinite(defaultTabId)) {
        tabId = defaultTabId;
      } else if (!isCloseTool) {
        tabId = await ensureSessionTab(sessionId);
      } else {
        throw new Error("No tab owned by this session. Open a new tab first.");
      }
    }

    const claimCheck = checkClaim(tabId, sessionId);
    if (!claimCheck.ok) throw new Error(claimCheck.error);
  }

  const res = await callExtension(tool, { ...toolArgs, tabId }, sessionId);

  const usedTabId =
    res && Number.isFinite(res.tabId) ? res.tabId : Number.isFinite(tabId) ? tabId : undefined;
  if (Number.isFinite(usedTabId)) {
    if (isCloseTool) {
      if (claims.has(usedTabId)) {
        releaseClaim(usedTabId);
      } else {
        clearDefaultTab(sessionId, usedTabId);
      }
    } else {
      touchClaim(usedTabId, sessionId);
      setDefaultTab(sessionId, usedTabId);
    }
  }

  return res;
}

function handleClientMessage(socket, client, msg) {
  if (msg && msg.type === "hello") {
    client.role = msg.role || "unknown";
    client.sessionId = msg.sessionId;
    if (client.sessionId) touchSession(client.sessionId);
    if (client.role === "native-host") {
      host = { socket };
      // allow host to see current state
      writeJsonLine(socket, { type: "host_ready", claims: listClaims() });
    }
    return;
  }

  if (msg && msg.type === "from_extension") {
    const message = msg.message;
    if (message && message.type === "tool_response" && Number.isFinite(message.id)) {
      const pending = extPending.get(message.id);
      if (!pending) return;
      extPending.delete(message.id);
      if (pending.timeout) clearTimeout(pending.timeout);

      if (message.error) {
        pending.reject(new Error(message.error.content || String(message.error)));
      } else {
        // Forward full result payload so callers can read tabId
        pending.resolve(message.result);
      }
    }
    return;
  }

  if (msg && msg.type === "request" && Number.isFinite(msg.id)) {
    const requestId = msg.id;
    const sessionId = msg.sessionId || client.sessionId;
    if (sessionId) touchSession(sessionId);

    const replyOk = (data) => writeJsonLine(socket, { type: "response", id: requestId, ok: true, data });
    const replyErr = (err) =>
      writeJsonLine(socket, { type: "response", id: requestId, ok: false, error: err.message || String(err) });

    (async () => {
      try {
        if (msg.op === "status") {
          const state = sessionId ? sessionState.get(sessionId) : null;
          const sessionInfo = state
            ? {
                sessionId,
                defaultTabId: state.defaultTabId,
                lastSeenAt: new Date(state.lastSeenAt).toISOString(),
              }
            : null;
          replyOk({
            broker: true,
            hostConnected: !!host && !!host.socket && !host.socket.destroyed,
            claims: listClaims(),
            leaseTtlMs: LEASE_TTL_MS,
            session: sessionInfo,
          });
          return;
        }

        if (msg.op === "list_claims") {
          replyOk({ claims: listClaims() });
          return;
        }

        if (msg.op === "claim_tab") {
          const tabId = msg.tabId;
          const force = !!msg.force;
          if (!Number.isFinite(tabId)) throw new Error("tabId is required");
          const existing = claims.get(tabId);
          if (existing && existing.sessionId !== sessionId && !force) {
            throw new Error(`Tab ${tabId} is owned by another OpenCode session (${existing.sessionId})`);
          }
          if (existing && existing.sessionId !== sessionId && force) {
            clearDefaultTab(existing.sessionId, tabId);
          }
          setClaim(tabId, sessionId);
          setDefaultTab(sessionId, tabId);
          replyOk({ ok: true, tabId, sessionId });
          return;
        }

        if (msg.op === "release_tab") {
          const tabId = msg.tabId;
          if (!Number.isFinite(tabId)) throw new Error("tabId is required");
          const existing = claims.get(tabId);
          if (!existing) {
            replyOk({ ok: true, tabId, released: false });
            return;
          }
          if (existing.sessionId !== sessionId) {
            throw new Error(`Tab ${tabId} is owned by another OpenCode session (${existing.sessionId})`);
          }
          releaseClaim(tabId);
          replyOk({ ok: true, tabId, released: true });
          return;
        }

        if (msg.op === "tool") {
          const result = await handleTool(socket, { tool: msg.tool, args: msg.args || {}, sessionId });
          replyOk(result);
          return;
        }

        throw new Error(`Unknown op: ${msg.op}`);
      } catch (e) {
        replyErr(e);
      }
    })();

    return;
  }
}

function start() {
  try {
    if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH);
  } catch {
    // ignore
  }

  const server = net.createServer((socket) => {
    socket.setNoDelay(true);

    const client = { role: "unknown", sessionId: null };
    clients.add(client);

    socket.on(
      "data",
      createJsonLineParser((msg) => handleClientMessage(socket, client, msg))
    );

    socket.on("close", () => {
      clients.delete(client);
      if (client.role === "native-host" && host && host.socket === socket) {
        host = null;
        // fail pending extension requests
        for (const [extId, pending] of extPending.entries()) {
          extPending.delete(extId);
          if (pending.timeout) clearTimeout(pending.timeout);
          pending.reject(new Error("Native host disconnected"));
        }
      }
      if (client.sessionId) releaseClaimsForSession(client.sessionId);
    });

    socket.on("error", () => {
      // close handler will clean up
    });
  });

  server.listen(SOCKET_PATH, () => {
    // Make socket group-readable; ignore errors
    try {
      fs.chmodSync(SOCKET_PATH, 0o600);
    } catch {}
    console.error(`[browser-broker] listening on ${SOCKET_PATH}`);
  });

  server.on("error", (err) => {
    console.error("[browser-broker] server error", err);
    process.exit(1);
  });
}

if (LEASE_TTL_MS > 0 && LEASE_SWEEP_MS > 0) {
  const timer = setInterval(cleanupStaleClaims, LEASE_SWEEP_MS);
  timer.unref?.();
}

start();
