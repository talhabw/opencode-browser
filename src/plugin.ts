import { Plugin } from "@opencode-ai/plugin";
import net from "net";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "fs";
import { homedir, userInfo } from "os";
import { basename, dirname, isAbsolute, join, resolve } from "path";
import { execSync, spawn } from "child_process";
import { fileURLToPath } from "url";


const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_JSON_PATH = join(__dirname, "..", "package.json");

let cachedVersion: string | null = null;

function asString(value: any): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value);
  return text === value ? text : undefined;
}

function getPackageVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8"));
    const version = asString(pkg?.version);
    if (version !== undefined) {
      cachedVersion = version;
      return cachedVersion;
    }
  } catch {
    // ignore
  }
  cachedVersion = "unknown";
  return cachedVersion;
}

const BASE_DIR = join(homedir(), ".opencode-browser");
const SOCKET_PATH = getBrokerSocketPath();
const LOG_PATH = join(BASE_DIR, "plugin.log");

function getSafePipeName(): string {
  try {
    const username = userInfo().username || "user";
    return `opencode-browser-${username}`.replace(/[^a-zA-Z0-9._-]/g, "_");
  } catch {
    return "opencode-browser";
  }
}

function getBrokerSocketPath(): string {
  const override = process.env.OPENCODE_BROWSER_BROKER_SOCKET;
  if (override) return override;
  if (process.platform === "win32") return `\\\\.\\pipe\\${getSafePipeName()}`;
  return join(BASE_DIR, "broker.sock");
}

mkdirSync(BASE_DIR, { recursive: true });

function logDebug(message: string): void {
  try {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${message}\n`, "utf8");
  } catch {
    // ignore
  }
}

logDebug(`plugin loaded v${getPackageVersion()} pid=${process.pid} socket=${SOCKET_PATH}`);

const DEFAULT_MAX_UPLOAD_BYTES = 512 * 1024;
const MAX_UPLOAD_BYTES = (() => {
  const raw = process.env.OPENCODE_BROWSER_MAX_UPLOAD_BYTES;
  const value = raw ? Number(raw) : NaN;
  if (Number.isFinite(value) && value > 0) return value;
  return DEFAULT_MAX_UPLOAD_BYTES;
})();

function resolveUploadPath(filePath: string): string {
  const trimmed = filePath.trim();
  if (!trimmed) throw new Error("filePath is required");
  return isAbsolute(trimmed) ? trimmed : resolve(process.cwd(), trimmed);
}

type FileUploadPayload = {
  name: string;
  mimeType?: string;
  base64: string;
};

function buildFileUploadPayload(
  filePath: string,
  fileName?: string,
  mimeType?: string
): FileUploadPayload {
  const absPath = resolveUploadPath(filePath);
  const stats = statSync(absPath);
  if (!stats.isFile()) throw new Error(`Not a file: ${absPath}`);
  if (stats.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `File too large (${stats.size} bytes). Max is ${MAX_UPLOAD_BYTES} bytes (OPENCODE_BROWSER_MAX_UPLOAD_BYTES).`
    );
  }
  const base64 = readFileSync(absPath).toString("base64");
  const name = asString(fileName)?.trim() || basename(absPath);
  const mt = asString(mimeType)?.trim() || undefined;
  return { name, mimeType: mt, base64 };
}

type BrokerResponse =
  | { type: "response"; id: number; ok: true; data: any }
  | { type: "response"; id: number; ok: false; error: string };

function createJsonLineParser(onMessage: (msg: any) => void): (chunk: Buffer) => void {
  let buffer = "";
  return (chunk: Buffer) => {
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

function writeJsonLine(socket: net.Socket, msg: any): void {
  socket.write(JSON.stringify(msg) + "\n");
}

function resolveRuntime(): string | null {
  const candidates: string[] = [];
  if (process.env.OPENCODE_BROWSER_NODE) candidates.push(process.env.OPENCODE_BROWSER_NODE);
  try {
    const cfg = JSON.parse(readFileSync(join(BASE_DIR, "config.json"), "utf8"));
    const nodePath = asString(cfg?.nodePath);
    if (nodePath !== undefined) candidates.push(nodePath);
  } catch {
    // ignore
  }
  if (process.platform !== "win32") {
    try {
      candidates.push(execSync("which node", { stdio: ["ignore", "pipe", "ignore"] }).toString("utf8").trim());
    } catch {
      // ignore
    }
  }
  candidates.push(process.execPath);
  for (const candidate of candidates) {
    if (!candidate) continue;
    const name = basename(candidate).toLowerCase();
    if (name.startsWith("node") || name.startsWith("bun")) return candidate;
  }
  return process.execPath;
}

function maybeStartBroker(): void {
  const brokerPath = join(BASE_DIR, "broker.cjs");
  if (!existsSync(brokerPath)) return;

  try {
    const child = spawn(resolveRuntime(), [brokerPath], { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    // ignore
  }
}

async function connectToBroker(): Promise<net.Socket> {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCKET_PATH);
    socket.once("connect", () => resolve(socket));
    socket.once("error", (err) => {
      lastBrokerError = err instanceof Error ? err : new Error(String(err));
      logDebug(`broker connect error socket=${SOCKET_PATH} error=${lastBrokerError.message}`);
      reject(err);
    });
  });
}

async function sleep(ms: number): Promise<void> {
  return await new Promise((r) => setTimeout(r, ms));
}

let socket: net.Socket | null = null;
let lastBrokerError: Error | null = null;
let sessionId = Math.random().toString(36).slice(2);
let reqId = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

async function ensureBrokerSocket(): Promise<net.Socket> {
  if (socket && !socket.destroyed) return socket;

  // Try to connect; if missing, try to start broker and retry.
  try {
    socket = await connectToBroker();
  } catch {
    maybeStartBroker();
    for (let i = 0; i < 20; i++) {
      await sleep(100);
      try {
        socket = await connectToBroker();
        break;
      } catch {}
    }
  }

  if (!socket || socket.destroyed) {
    const errorMessage = lastBrokerError?.message ? ` (${lastBrokerError.message})` : "";
    throw new Error(
      `Could not connect to local broker at ${SOCKET_PATH}${errorMessage}. ` +
        "Run `npx @talhabw/opencode-browser install` and ensure the extension is loaded."
    );
  }

  socket.setNoDelay(true);
  logDebug(`broker connected socket=${SOCKET_PATH}`);
  socket.on(
    "data",
    createJsonLineParser((msg) => {
      if (msg?.type !== "response") return;
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      // SAFETY: msg.type === "response" was checked and the message id matched a
      // pending request, so the broker payload carries the id/ok/data/error shape.
      const res = msg as BrokerResponse;
      if (!res.ok) p.reject(new Error(res.error));
      else p.resolve(res.data);
    })
  );

  socket.on("close", () => {
    socket = null;
  });

  socket.on("error", () => {
    socket = null;
  });

  writeJsonLine(socket, { type: "hello", role: "plugin", sessionId, pid: process.pid });

  return socket;
}

async function brokerRequest(op: string, payload: any): Promise<any> {
  const s = await ensureBrokerSocket();
  const id = ++reqId;

  return await new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    writeJsonLine(s, { type: "request", id, op, ...payload });
    setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new Error("Timed out waiting for broker response"));
    }, 60000);
  });
}

function toolResultText(data: any, fallback: string): string {
  const content = asString(data?.content);
  if (content !== undefined) return content;
  const text = asString(data);
  if (text !== undefined) return text;
  if (data?.content != null) return JSON.stringify(data.content);
  return fallback;
}

async function toolRequest(toolName: string, args: any): Promise<any> {
  return await brokerRequest("tool", { tool: toolName, args });
}

async function statusRequest(): Promise<any> {
  return await brokerRequest("status", {});
}

type JsonSchema =
  | { type: "string" }
  | { type: "number" }
  | { type: "boolean" }
  | { type: "object"; additionalProperties: true }
  | {
      type: "object";
      properties: Record<string, JsonSchema>;
      additionalProperties: false;
      required?: string[];
    };
type BrowserTool = {
  name: string;
  description: string;
  input: JsonSchema;
  execute: (args: any) => Promise<string>;
  options: { namespace: string; codemode: true };
};

function stringField(): JsonSchema {
  return { type: "string" };
}

function numberField(): JsonSchema {
  return { type: "number" };
}

function booleanField(): JsonSchema {
  return { type: "boolean" };
}

function freeObjectField(): JsonSchema {
  return { type: "object", additionalProperties: true };
}

function objectInput(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  const input: JsonSchema = {
    type: "object",
    properties,
    additionalProperties: false,
  };
  if (required.length > 0) input.required = required;
  return input;
}

function browserTool(
  name: string,
  description: string,
  properties: Record<string, JsonSchema>,
  execute: (args: any) => Promise<string>,
  required: string[] = []
): BrowserTool {
  return {
    name,
    description,
    input: objectInput(properties, required),
    execute,
    options: { namespace: "opencode-browser", codemode: true },
  };
}

const browserTools: BrowserTool[] = [
      browserTool("browser_debug", "Debug plugin loading and connection status.", {}, async () => {
        const lines = [
          "loaded: true",
          `sessionId: ${sessionId}`,
          `pid: ${process.pid}`,
          `backend: extension`,
          `brokerSocket: ${SOCKET_PATH}`,
          `pluginVersion: ${getPackageVersion()}`,
          `timestamp: ${new Date().toISOString()}`,
        ];
        return lines.join("\n");
      }),

      browserTool("browser_version", "Return the installed @talhabw/opencode-browser plugin version.", {}, async () =>
        JSON.stringify({
          name: "@talhabw/opencode-browser",
          version: getPackageVersion(),
          sessionId,
          pid: process.pid,
          backend: "extension",
        })
      ),

      browserTool("browser_status", "Check backend connection status and current tab claims.", {}, async () =>
        JSON.stringify(await statusRequest())
      ),

      browserTool("browser_get_tabs", "List all open browser tabs", {}, async () =>
        toolResultText(await toolRequest("get_tabs", {}), "ok")
      ),

      browserTool("browser_list_claims", "List tab ownership claims", {}, async () =>
        JSON.stringify(await brokerRequest("list_claims", {}))
      ),

      browserTool("browser_claim_tab", "Claim a browser tab for this session", {
        tabId: numberField(),
        force: booleanField(),
      }, async ({ tabId, force }) => JSON.stringify(await brokerRequest("claim_tab", { tabId, force })), ["tabId"]),

      browserTool("browser_release_tab", "Release a claimed browser tab", {
        tabId: numberField(),
      }, async ({ tabId }) => JSON.stringify(await brokerRequest("release_tab", { tabId })), ["tabId"]),

      browserTool("browser_open_tab", "Open a new browser tab", {
        url: stringField(),
        active: booleanField(),
      }, async ({ url, active }) => toolResultText(await toolRequest("open_tab", { url, active }), "Opened new tab")),

      browserTool("browser_close_tab", "Close a browser tab owned by this session", {
        tabId: numberField(),
      }, async ({ tabId }) => toolResultText(await toolRequest("close_tab", { tabId }), "Closed tab")),

      browserTool("browser_navigate", "Navigate to a URL in the browser", {
        url: stringField(),
        tabId: numberField(),
      }, async ({ url, tabId }) => toolResultText(await toolRequest("navigate", { url, tabId }), `Navigated to ${url}`), ["url"]),

      browserTool("browser_click", "Click an element on the page using a CSS selector", {
        selector: stringField(), index: numberField(), tabId: numberField(), timeoutMs: numberField(), pollMs: numberField(),
      }, async ({ selector, index, tabId, timeoutMs, pollMs }) =>
        toolResultText(await toolRequest("click", { selector, index, tabId, timeoutMs, pollMs }), `Clicked ${selector}`), ["selector"]),

      browserTool("browser_type", "Type text into an input element", {
        selector: stringField(), text: stringField(), clear: booleanField(), index: numberField(), tabId: numberField(), timeoutMs: numberField(), pollMs: numberField(),
      }, async ({ selector, text, clear, index, tabId, timeoutMs, pollMs }) =>
        toolResultText(await toolRequest("type", { selector, text, clear, index, tabId, timeoutMs, pollMs }), `Typed "${text}" into ${selector}`), ["selector", "text"]),

      browserTool("browser_select", "Select an option in a native select element", {
        selector: stringField(), value: stringField(), label: stringField(), optionIndex: numberField(), index: numberField(), tabId: numberField(), timeoutMs: numberField(), pollMs: numberField(),
      }, async ({ selector, value, label, optionIndex, index, tabId, timeoutMs, pollMs }) => {
        const summary = value ?? label ?? (optionIndex != null ? String(optionIndex) : "option");
        return toolResultText(await toolRequest("select", { selector, value, label, optionIndex, index, tabId, timeoutMs, pollMs }), `Selected ${summary} in ${selector}`);
      }, ["selector"]),

      browserTool("browser_screenshot", "Take a screenshot of the current page. Returns base64 image data URL.", {
        tabId: numberField(),
      }, async ({ tabId }) => toolResultText(await toolRequest("screenshot", { tabId }), "Screenshot failed")),

      browserTool("browser_snapshot", "Get an accessibility tree snapshot of the page.", {
        tabId: numberField(),
      }, async ({ tabId }) => toolResultText(await toolRequest("snapshot", { tabId }), "Snapshot failed")),

      browserTool("browser_scroll", "Scroll the page or scroll an element into view", {
        selector: stringField(), x: numberField(), y: numberField(), tabId: numberField(), timeoutMs: numberField(), pollMs: numberField(),
      }, async ({ selector, x, y, tabId, timeoutMs, pollMs }) => toolResultText(await toolRequest("scroll", { selector, x, y, tabId, timeoutMs, pollMs }), "Scrolled")),

      browserTool("browser_wait", "Wait for a specified duration", {
        ms: numberField(), tabId: numberField(),
      }, async ({ ms, tabId }) => toolResultText(await toolRequest("wait", { ms, tabId }), "Waited")),

      browserTool("browser_query", "Read data from the page using selectors, optional wait, or page_text extraction (shadow DOM + same-origin iframes).", {
        selector: stringField(), mode: stringField(), attribute: stringField(), property: stringField(), index: numberField(), limit: numberField(), timeoutMs: numberField(), pollMs: numberField(), pattern: stringField(), flags: stringField(), tabId: numberField(),
      }, async ({ selector, mode, attribute, property, index, limit, timeoutMs, pollMs, pattern, flags, tabId }) => toolResultText(await toolRequest("query", { selector, mode, attribute, property, index, limit, timeoutMs, pollMs, pattern, flags, tabId }), "Query failed")),

      browserTool("browser_download", "Download a file via URL or by clicking an element on the page.", {
        url: stringField(), selector: stringField(), filename: stringField(), conflictAction: stringField(), saveAs: booleanField(), wait: booleanField(), downloadTimeoutMs: numberField(), index: numberField(), tabId: numberField(), timeoutMs: numberField(), pollMs: numberField(),
      }, async ({ url, selector, filename, conflictAction, saveAs, wait, downloadTimeoutMs, index, tabId, timeoutMs, pollMs }) => toolResultText(await toolRequest("download", { url, selector, filename, conflictAction, saveAs, wait, downloadTimeoutMs, index, tabId, timeoutMs, pollMs }), "Download started")),

      browserTool("browser_list_downloads", "List recent downloads.", {
        limit: numberField(), state: stringField(),
      }, async ({ limit, state }) => toolResultText(await toolRequest("list_downloads", { limit, state }), "[]")),

      browserTool("browser_set_file_input", "Set a file input element's selected file using a local file path.", {
        selector: stringField(), filePath: stringField(), fileName: stringField(), mimeType: stringField(), index: numberField(), tabId: numberField(), timeoutMs: numberField(), pollMs: numberField(),
      }, async ({ selector, filePath, fileName, mimeType, index, tabId, timeoutMs, pollMs }) => {
        const file = buildFileUploadPayload(filePath, fileName, mimeType);
        return toolResultText(await toolRequest("set_file_input", { selector, tabId, index, timeoutMs, pollMs, files: [file] }), "Set file input");
      }, ["selector", "filePath"]),

      browserTool("browser_highlight", "Highlight an element on the page with a colored border for visual debugging.", {
        selector: stringField(), index: numberField(), duration: numberField(), color: stringField(), showInfo: booleanField(), tabId: numberField(), timeoutMs: numberField(), pollMs: numberField(),
      }, async ({ selector, index, duration, color, showInfo, tabId, timeoutMs, pollMs }) => toolResultText(await toolRequest("highlight", { selector, index, duration, color, showInfo, tabId, timeoutMs, pollMs }), "Highlight failed"), ["selector"]),

      browserTool("browser_console", "Read console log messages from the page. Uses chrome.debugger API for complete capture.", {
        tabId: numberField(), clear: booleanField(), filter: stringField(),
      }, async ({ tabId, clear, filter }) => toolResultText(await toolRequest("console", { tabId, clear, filter }), "[]")),

      browserTool("browser_errors", "Read JavaScript errors from the page. Uses chrome.debugger API for complete capture.", {
        tabId: numberField(), clear: booleanField(),
      }, async ({ tabId, clear }) => toolResultText(await toolRequest("errors", { tabId, clear }), "[]")),

      browserTool("browser_network", "Inspect network activity for the tab (DevTools Network tab). Lists captured requests/responses with method, URL, HTTP status, type (XHR/fetch/document/websocket), mimeType, timing, and sizes. Options: filter (case-insensitive substring matched against URL/method/type/status/mimeType/errorText), method (e.g. \"GET\"), onlyFailed, limit (max entries, default 100), includeBody (fetch response bodies and POST payloads; capped at 50 entries and 100 KB per body), clear (reset the captured log so a reload captures fresh traffic only). Capture starts on the first devtools call and persists across calls — reload the page afterwards to see a full load. Requires the tab to not be inspected by DevTools UI (only one debugger per tab).", {
        tabId: numberField(), filter: stringField(), method: stringField(), limit: numberField(), onlyFailed: booleanField(), includeBody: booleanField(), clear: booleanField(),
      }, async ({ tabId, filter, method, limit, onlyFailed, includeBody, clear }) => toolResultText(await toolRequest("network", { tabId, filter, method, limit, onlyFailed, includeBody, clear }), "[]")),

      browserTool("browser_eval", "Evaluate a JavaScript expression in the page's context (DevTools Console). Runs via CDP Runtime.evaluate with returnByValue, so the result must be JSON-serializable. Use to read page state (variables, fetch responses, framework stores, localStorage-backed data), trigger page-side logic, or verify behavior the DOM does not expose. Edge: true/false/null/undefined work; use awaitPromise (default true) for async IIFEs. Exceptions return { ok: false, error, exception, stack }. Large results are truncated (strings ~20 KB, arrays ~500 items). Requires the tab to not be inspected by DevTools UI (only one debugger per tab).", {
        expression: stringField(), tabId: numberField(), awaitPromise: booleanField(),
      }, async ({ expression, tabId, awaitPromise }) => toolResultText(await toolRequest("eval", { expression, tabId, awaitPromise }), "eval failed"), ["expression"]),

      browserTool("browser_cookies", "Read or modify cookies for the tab (DevTools Application > Cookies). action: list (default; all cookies or those for a url), get (by name, optionally scoped to url), set (needs name + value + url or domain; optional path, expires, httpOnly, secure, sameSite), delete (needs name + url or domain/path), clear (removes all browser cookies). Uses the Network CDP domain via the tab debugger. Requires the tab to not be inspected by DevTools UI (only one debugger per tab).", {
        tabId: numberField(), action: stringField(), url: stringField(), name: stringField(), value: stringField(), domain: stringField(), path: stringField(), expires: numberField(), httpOnly: booleanField(), secure: booleanField(), sameSite: stringField(),
      }, async ({ tabId, action, url, name, value, domain, path, expires, httpOnly, secure, sameSite }) => toolResultText(await toolRequest("cookies", { tabId, action, url, name, value, domain, path, expires, httpOnly, secure, sameSite }), "cookie operation failed")),

      browserTool("browser_storage", "Read or modify the page's local/session storage (DevTools Application > Local/Session Storage). storage: \"local\" (default) or \"session\" only, action: list (default), get (key), set (key + value), remove (key), clear. Operates on the page's origin via Runtime.evaluate in the page context. Requires the tab to not be inspected by DevTools UI (only one debugger per tab).", {
        tabId: numberField(), action: stringField(), storage: stringField(), key: stringField(), value: stringField(),
      }, async ({ tabId, action, storage, key, value }) => toolResultText(await toolRequest("storage", { tabId, action, storage, key, value }), "storage operation failed")),

      browserTool("browser_performance", "Read performance data for the tab (DevTools Performance tab). Returns raw Performance.getMetrics counters (JS heap used, layout count, node count, FramesPerSecond when Chrome provides it, etc.). Set resources:true to also get resource-timing entries (last 100; per-resource duration, transfer size, status, initiator) and the navigation entry. Requires the tab to not be inspected by DevTools UI (only one debugger per tab).", {
        tabId: numberField(), resources: booleanField(),
      }, async ({ tabId, resources }) => toolResultText(await toolRequest("performance", { tabId, resources }), "performance call failed")),

      browserTool("browser_devtools", "Send an arbitrary Chrome DevTools Protocol (CDP) command to the tab's debugger — the escape hatch for every DevTools panel without a dedicated tool. Examples: Elements/DOM: DOM.enable + DOM.getDocument + DOM.getOuterHTML; Sources/Debugger: Debugger.enable, Debugger.pause, Debugger.resume, Debugger.setBreakpointByUrl; Application: DOMStorage.getDOMStorageItems, IndexedDB.enable, Storage.*; Security: Security.enable/disable; Log: Log.enable, Log.clear; Page: Page.reload, Page.getLayoutMetrics, Page.navigate; Emulation: Emulation.setDeviceMetricsOverride. method is required (e.g. \"DOM.getDocument\"); params is a free-form object. Returns the CDP result wrapped as { ok, method, result }. Requires the tab to not be inspected by DevTools UI (only one debugger per tab).", {
        method: stringField(), params: freeObjectField(), tabId: numberField(),
      }, async ({ method, params, tabId }) => toolResultText(await toolRequest("devtools", { method, params, tabId }), "devtools command failed"), ["method"]),
];

const plugin = Plugin.define({
  id: "opencode-browser",
  setup: async (ctx) => {
    await ctx.tool.transform((tools) => {
      for (const browserTool of browserTools) {
        // SAFETY: browserTool.execute returns Promise<string> and input is a plain
        // JSON schema, while the SDK expects an Effect and a schema codec; the
        // adapter wraps the resolved string in { content } and the runtime accepts
        // plain JSON schemas, so the widened cast only bridges static types.
        tools.add({
          ...browserTool,
          execute: async (args: any) => ({
            content: await browserTool.execute(args),
          }),
        } as any);
      }
    });
  },
});

export default plugin;
