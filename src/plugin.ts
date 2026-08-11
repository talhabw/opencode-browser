import { Plugin } from "@opencode-ai/plugin";
import net from "net";
import { createAgentBackend, type AgentBackend } from "./agent-backend.js";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "fs";
import { homedir, userInfo } from "os";
import { basename, dirname, isAbsolute, join, resolve } from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";


const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_JSON_PATH = join(__dirname, "..", "package.json");

let cachedVersion: string | null = null;

function getPackageVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8"));
    if (typeof pkg?.version === "string") {
      cachedVersion = pkg.version;
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
  const trimmed = typeof filePath === "string" ? filePath.trim() : "";
  if (!trimmed) throw new Error("filePath is required");
  return isAbsolute(trimmed) ? trimmed : resolve(process.cwd(), trimmed);
}

function buildFileUploadPayload(
  filePath: string,
  fileName?: string,
  mimeType?: string
): { name: string; mimeType?: string; base64: string } {
  const absPath = resolveUploadPath(filePath);
  const stats = statSync(absPath);
  if (!stats.isFile()) throw new Error(`Not a file: ${absPath}`);
  if (stats.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `File too large (${stats.size} bytes). Max is ${MAX_UPLOAD_BYTES} bytes (OPENCODE_BROWSER_MAX_UPLOAD_BYTES). ` +
        `For larger uploads, use OPENCODE_BROWSER_BACKEND=agent.`
    );
  }
  const base64 = readFileSync(absPath).toString("base64");
  const name = typeof fileName === "string" && fileName.trim() ? fileName.trim() : basename(absPath);
  const mt = typeof mimeType === "string" && mimeType.trim() ? mimeType.trim() : undefined;
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

function maybeStartBroker(): void {
  const brokerPath = join(BASE_DIR, "broker.cjs");
  if (!existsSync(brokerPath)) return;

  try {
    const child = spawn(process.execPath, [brokerPath], { detached: true, stdio: "ignore" });
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

const BACKEND_MODE = (process.env.OPENCODE_BROWSER_BACKEND ?? process.env.OPENCODE_BROWSER_MODE ?? "extension")
  .toLowerCase()
  .trim();
const USE_AGENT_BACKEND = ["agent", "agent-browser", "agentbrowser"].includes(BACKEND_MODE);

let socket: net.Socket | null = null;
let lastBrokerError: Error | null = null;
let sessionId = Math.random().toString(36).slice(2);
let reqId = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

const agentBackend: AgentBackend | null = USE_AGENT_BACKEND ? createAgentBackend(sessionId) : null;

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
      if (msg?.type !== "response" || typeof msg.id !== "number") return;
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
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

async function brokerRequest(op: string, payload: Record<string, any>): Promise<any> {
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

async function brokerOnlyRequest(op: string, payload: Record<string, any>): Promise<any> {
  if (USE_AGENT_BACKEND) {
    throw new Error("Tab claims are not supported with agent-browser backend");
  }
  return await brokerRequest(op, payload);
}

function toolResultText(data: any, fallback: string): string {
  if (typeof data?.content === "string") return data.content;
  if (typeof data === "string") return data;
  if (data?.content != null) return JSON.stringify(data.content);
  return fallback;
}

async function toolRequest(toolName: string, args: Record<string, any>): Promise<any> {
  if (USE_AGENT_BACKEND) {
    if (!agentBackend) {
      throw new Error("Agent backend unavailable: configuration failed to initialize");
    }
    return await agentBackend.requestTool(toolName, args);
  }
  return await brokerRequest("tool", { tool: toolName, args });
}

async function statusRequest(): Promise<any> {
  if (USE_AGENT_BACKEND) {
    if (!agentBackend) {
      return {
        backend: "agent-browser",
        connected: false,
        error: "Agent backend unavailable: configuration failed to initialize",
      };
    }
    return await agentBackend.status();
  }
  return await brokerRequest("status", {});
}

type JsonSchema = Record<string, unknown>;
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

function objectInput(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return {
    type: "object",
    properties,
    additionalProperties: false,
    ...(required.length > 0 ? { required } : {}),
  };
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
          `backend: ${USE_AGENT_BACKEND ? "agent-browser" : "extension"}`,
          `brokerSocket: ${SOCKET_PATH}`,
          `agentSession: ${agentBackend?.session ?? ""}`,
          `agentConnection: ${JSON.stringify(agentBackend?.connection ?? null)}`,
          `agentBrowserVersion: ${agentBackend?.getVersion?.() ?? ""}`,
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
          backend: USE_AGENT_BACKEND ? "agent-browser" : "extension",
          agentBrowserVersion: agentBackend?.getVersion?.() ?? null,
        })
      ),

      browserTool("browser_status", "Check backend connection status and current tab claims.", {}, async () =>
        JSON.stringify(await statusRequest())
      ),

      browserTool("browser_get_tabs", "List all open browser tabs", {}, async () =>
        toolResultText(await toolRequest("get_tabs", {}), "ok")
      ),

      browserTool("browser_list_claims", "List tab ownership claims", {}, async () =>
        JSON.stringify(await brokerOnlyRequest("list_claims", {}))
      ),

      browserTool("browser_claim_tab", "Claim a browser tab for this session", {
        tabId: numberField(),
        force: booleanField(),
      }, async ({ tabId, force }) => JSON.stringify(await brokerOnlyRequest("claim_tab", { tabId, force })), ["tabId"]),

      browserTool("browser_release_tab", "Release a claimed browser tab", {
        tabId: numberField(),
      }, async ({ tabId }) => JSON.stringify(await brokerOnlyRequest("release_tab", { tabId })), ["tabId"]),

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

      browserTool("browser_list_downloads", "List recent downloads (Chrome backend) or session downloads (agent backend).", {
        limit: numberField(), state: stringField(),
      }, async ({ limit, state }) => toolResultText(await toolRequest("list_downloads", { limit, state }), "[]")),

      browserTool("browser_set_file_input", "Set a file input element's selected file using a local file path.", {
        selector: stringField(), filePath: stringField(), fileName: stringField(), mimeType: stringField(), index: numberField(), tabId: numberField(), timeoutMs: numberField(), pollMs: numberField(),
      }, async ({ selector, filePath, fileName, mimeType, index, tabId, timeoutMs, pollMs }) => {
        if (USE_AGENT_BACKEND) return toolResultText(await toolRequest("set_file_input", { selector, filePath, tabId, index, timeoutMs, pollMs }), "Set file input");
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
];

const plugin = Plugin.define({
  id: "opencode-browser",
  setup: async (ctx) => {
    await ctx.tool.transform((tools) => {
      for (const browserTool of browserTools) {
        tools.add({
          ...browserTool,
          execute: async (args: any, toolContext: any) => ({
            content: await browserTool.execute(args),
          }),
        } as any);
      }
    });
  },
});

export default plugin;
/*
        description: "Debug plugin loading and connection status.",
        args: {},
        async execute(args, ctx) {
          const lines = [
            "loaded: true",
            `sessionId: ${sessionId}`,
            `pid: ${process.pid}`,
            `backend: ${USE_AGENT_BACKEND ? "agent-browser" : "extension"}`,
            `brokerSocket: ${SOCKET_PATH}`,
            `agentSession: ${agentBackend?.session ?? ""}`,
            `agentConnection: ${JSON.stringify(agentBackend?.connection ?? null)}`,
            `agentBrowserVersion: ${agentBackend?.getVersion?.() ?? ""}`,
            `pluginVersion: ${getPackageVersion()}`,
            `timestamp: ${new Date().toISOString()}`,
          ];
          return lines.join("\n");
        },
      }),

      browser_version: tool({
        description: "Return the installed @different-ai/opencode-browser plugin version.",
        args: {},
        async execute(args, ctx) {
          return JSON.stringify({
            name: "@different-ai/opencode-browser",
            version: getPackageVersion(),
            sessionId,
            pid: process.pid,
            backend: USE_AGENT_BACKEND ? "agent-browser" : "extension",
            agentBrowserVersion: agentBackend?.getVersion?.() ?? null,
          });
        },
      }),

      browser_status: tool({
        description: "Check backend connection status and current tab claims.",
        args: {},
        async execute(args, ctx) {
          const data = await statusRequest();
          return JSON.stringify(data);
        },
      }),

      browser_get_tabs: tool({
        description: "List all open browser tabs",
        args: {},
        async execute(args, ctx) {
          const data = await toolRequest("get_tabs", {});
          return toolResultText(data, "ok");
        },
      }),

      browser_list_claims: tool({
        description: "List tab ownership claims",
        args: {},
        async execute(args, ctx) {
          const data = await brokerOnlyRequest("list_claims", {});
          return JSON.stringify(data);
        },
      }),

      browser_claim_tab: tool({
        description: "Claim a browser tab for this session",
        args: {
          tabId: schema.number(),
          force: schema.boolean().optional(),
        },
        async execute({ tabId, force }, ctx) {
          const data = await brokerOnlyRequest("claim_tab", { tabId, force });
          return JSON.stringify(data);
        },
      }),

      browser_release_tab: tool({
        description: "Release a claimed browser tab",
        args: {
          tabId: schema.number(),
        },
        async execute({ tabId }, ctx) {
          const data = await brokerOnlyRequest("release_tab", { tabId });
          return JSON.stringify(data);
        },
      }),

      browser_open_tab: tool({
        description: "Open a new browser tab",
        args: {
          url: schema.string().optional(),
          active: schema.boolean().optional(),
        },
        async execute({ url, active }, ctx) {
          const data = await toolRequest("open_tab", { url, active });
          return toolResultText(data, "Opened new tab");
        },
      }),

      browser_close_tab: tool({
        description: "Close a browser tab owned by this session",
        args: {
          tabId: schema.number().optional(),
        },
        async execute({ tabId }, ctx) {
          const data = await toolRequest("close_tab", { tabId });
          return toolResultText(data, "Closed tab");
        },
      }),

      browser_navigate: tool({
        description: "Navigate to a URL in the browser",
        args: {
          url: schema.string(),
          tabId: schema.number().optional(),
        },
        async execute({ url, tabId }, ctx) {
          const data = await toolRequest("navigate", { url, tabId });
          return toolResultText(data, `Navigated to ${url}`);
        },
      }),

      browser_click: tool({
        description: "Click an element on the page using a CSS selector",
        args: {
          selector: schema.string(),
          index: schema.number().optional(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute({ selector, index, tabId, timeoutMs, pollMs }, ctx) {
          const data = await toolRequest("click", { selector, index, tabId, timeoutMs, pollMs });
          return toolResultText(data, `Clicked ${selector}`);
        },
      }),

      browser_type: tool({
        description: "Type text into an input element",
        args: {
          selector: schema.string(),
          text: schema.string(),
          clear: schema.boolean().optional(),
          index: schema.number().optional(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute({ selector, text, clear, index, tabId, timeoutMs, pollMs }, ctx) {
          const data = await toolRequest("type", { selector, text, clear, index, tabId, timeoutMs, pollMs });
          return toolResultText(data, `Typed "${text}" into ${selector}`);
        },
      }),

      browser_select: tool({
        description: "Select an option in a native select element",
        args: {
          selector: schema.string(),
          value: schema.string().optional(),
          label: schema.string().optional(),
          optionIndex: schema.number().optional(),
          index: schema.number().optional(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute({ selector, value, label, optionIndex, index, tabId, timeoutMs, pollMs }, ctx) {
          const data = await toolRequest("select", { selector, value, label, optionIndex, index, tabId, timeoutMs, pollMs });
          const summary = value ?? label ?? (optionIndex != null ? String(optionIndex) : "option");
          return toolResultText(data, `Selected ${summary} in ${selector}`);
        },
      }),

      browser_screenshot: tool({
        description: "Take a screenshot of the current page. Returns base64 image data URL.",
        args: {
          tabId: schema.number().optional(),
        },
        async execute({ tabId }, ctx) {
          const data = await toolRequest("screenshot", { tabId });
          return toolResultText(data, "Screenshot failed");
        },
      }),

      browser_snapshot: tool({
        description: "Get an accessibility tree snapshot of the page.",
        args: {
          tabId: schema.number().optional(),
        },
        async execute({ tabId }, ctx) {
          const data = await toolRequest("snapshot", { tabId });
          return toolResultText(data, "Snapshot failed");
        },
      }),

      browser_scroll: tool({
        description: "Scroll the page or scroll an element into view",
        args: {
          selector: schema.string().optional(),
          x: schema.number().optional(),
          y: schema.number().optional(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute({ selector, x, y, tabId, timeoutMs, pollMs }, ctx) {
          const data = await toolRequest("scroll", { selector, x, y, tabId, timeoutMs, pollMs });
          return toolResultText(data, "Scrolled");
        },
      }),

      browser_wait: tool({
        description: "Wait for a specified duration",
        args: {
          ms: schema.number().optional(),
          tabId: schema.number().optional(),
        },
        async execute({ ms, tabId }, ctx) {
          const data = await toolRequest("wait", { ms, tabId });
          return toolResultText(data, "Waited");
        },
      }),

      browser_query: tool({
        description:
          "Read data from the page using selectors, optional wait, or page_text extraction (shadow DOM + same-origin iframes).",
        args: {
          selector: schema.string().optional(),
          mode: schema.string().optional(),
          attribute: schema.string().optional(),
          property: schema.string().optional(),
          index: schema.number().optional(),
          limit: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
          pattern: schema.string().optional(),
          flags: schema.string().optional(),
          tabId: schema.number().optional(),
        },
        async execute({ selector, mode, attribute, property, index, limit, timeoutMs, pollMs, pattern, flags, tabId }, ctx) {
          const data = await toolRequest("query", {
            selector,
            mode,
            attribute,
            property,
            index,
            limit,
            timeoutMs,
            pollMs,
            pattern,
            flags,
            tabId,
          });
          return toolResultText(data, "Query failed");
        },
      }),

      browser_download: tool({
        description: "Download a file via URL or by clicking an element on the page.",
        args: {
          url: schema.string().optional(),
          selector: schema.string().optional(),
          filename: schema.string().optional(),
          conflictAction: schema.string().optional(),
          saveAs: schema.boolean().optional(),
          wait: schema.boolean().optional(),
          downloadTimeoutMs: schema.number().optional(),
          index: schema.number().optional(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute(
          { url, selector, filename, conflictAction, saveAs, wait, downloadTimeoutMs, index, tabId, timeoutMs, pollMs },
          ctx
        ) {
          const data = await toolRequest("download", {
            url,
            selector,
            filename,
            conflictAction,
            saveAs,
            wait,
            downloadTimeoutMs,
            index,
            tabId,
            timeoutMs,
            pollMs,
          });
          return toolResultText(data, "Download started");
        },
      }),

      browser_list_downloads: tool({
        description: "List recent downloads (Chrome backend) or session downloads (agent backend).",
        args: {
          limit: schema.number().optional(),
          state: schema.string().optional(),
        },
        async execute({ limit, state }, ctx) {
          const data = await toolRequest("list_downloads", { limit, state });
          return toolResultText(data, "[]");
        },
      }),

      browser_set_file_input: tool({
        description: "Set a file input element's selected file using a local file path.",
        args: {
          selector: schema.string(),
          filePath: schema.string(),
          fileName: schema.string().optional(),
          mimeType: schema.string().optional(),
          index: schema.number().optional(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute({ selector, filePath, fileName, mimeType, index, tabId, timeoutMs, pollMs }, ctx) {
          if (USE_AGENT_BACKEND) {
            const data = await toolRequest("set_file_input", { selector, filePath, tabId, index, timeoutMs, pollMs });
            return toolResultText(data, "Set file input");
          }

          const file = buildFileUploadPayload(filePath, fileName, mimeType);
          const data = await toolRequest("set_file_input", {
            selector,
            tabId,
            index,
            timeoutMs,
            pollMs,
            files: [file],
          });
          return toolResultText(data, "Set file input");
        },
      }),

      browser_highlight: tool({
        description: "Highlight an element on the page with a colored border for visual debugging.",
        args: {
          selector: schema.string(),
          index: schema.number().optional(),
          duration: schema.number().optional(),
          color: schema.string().optional(),
          showInfo: schema.boolean().optional(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute({ selector, index, duration, color, showInfo, tabId, timeoutMs, pollMs }, ctx) {
          const data = await toolRequest("highlight", {
            selector,
            index,
            duration,
            color,
            showInfo,
            tabId,
            timeoutMs,
            pollMs,
          });
          return toolResultText(data, "Highlight failed");
        },
      }),

      browser_console: tool({
        description:
          "Read console log messages from the page. Uses chrome.debugger API for complete capture. " +
          "The debugger attaches lazily on first call and may show a banner in the browser.",
        args: {
          tabId: schema.number().optional(),
          clear: schema.boolean().optional(),
          filter: schema.string().optional(),
        },
        async execute({ tabId, clear, filter }, ctx) {
          const data = await toolRequest("console", { tabId, clear, filter });
          return toolResultText(data, "[]");
        },
      }),

      browser_errors: tool({
        description:
          "Read JavaScript errors from the page. Uses chrome.debugger API for complete capture. " +
          "The debugger attaches lazily on first call and may show a banner in the browser.",
        args: {
          tabId: schema.number().optional(),
          clear: schema.boolean().optional(),
        },
        async execute({ tabId, clear }, ctx) {
          const data = await toolRequest("errors", { tabId, clear });
          return toolResultText(data, "[]");
        },
      }),
    },
  };
*/
