# OpenCode Browser

Browser automation plugin for [OpenCode](https://opencode.ai).

Control your real Chromium browser (Chrome/Brave/Arc/Edge) using your existing profile (logins, cookies, bookmarks). No DevTools Protocol, no security prompts.


https://github.com/user-attachments/assets/1496b3b3-419b-436c-b412-8cda2fed83d6


## Why this architecture

This version is optimized for reliability and predictable multi-session behavior:
- **No MCP** -> just opencode plugin
- **No WebSocket port** → no port conflicts
- **Chrome Native Messaging** between extension and a local host process
- A local **broker** multiplexes multiple OpenCode plugin sessions and enforces **per-tab ownership**

## Installation

> Help me improve this! 

```bash
bunx @different-ai/opencode-browser@latest install
```

Supports macOS, Linux, and Windows (Chrome/Edge/Brave/Chromium).


https://github.com/user-attachments/assets/d5767362-fbf3-4023-858b-90f06d9f0b25




The installer will:

1. Copy the extension to `~/.opencode-browser/extension/`
2. Walk you through loading + pinning it in `chrome://extensions`
3. Resolve a fixed extension ID (no copy/paste) and install a **Native Messaging Host manifest**
4. Update your `opencode.json` or `opencode.jsonc` to load the plugin

To override the extension ID, pass `--extension-id <id>` or set `OPENCODE_BROWSER_EXTENSION_ID`.

### Configure OpenCode

> Note: if you run the installer you'll be prompted to include this automatically. If you said "yes", you can skip this part.

Your `opencode.json` or `opencode.jsonc` should contain:

```json
{
  "$schema": "https://opencode.ai/config.json",
   "plugins": ["@different-ai/opencode-browser"]
}
```

The plugin targets OpenCode V2. Its browser tools are registered in the
`opencode-browser` CodeMode namespace.

### Update

```bash
bunx @different-ai/opencode-browser@latest update
```

## CLI tool runner (for local debugging)

Run plugin tools directly from the package CLI (without starting an OpenCode session):

```bash
# list available browser_* tools
npx @different-ai/opencode-browser tools

# run a single tool
npx @different-ai/opencode-browser tool browser_status
npx @different-ai/opencode-browser tool browser_query --args '{"mode":"page_text"}'

# run built-in end-to-end smoke test (click + text selector + container scroll)
npx @different-ai/opencode-browser self-test
```

This is useful for debugging issue reports (for example inbox/chat UIs) before involving a full OpenCode workflow.
After `update`, reload the unpacked extension in `chrome://extensions` before running `self-test`.

## Chrome Web Store maintainer flow

Build a store-ready extension package:

```bash
bun run build:cws
```

Outputs:

- `artifacts/chrome-web-store/opencode-browser-cws-v<version>.zip`
- `artifacts/chrome-web-store/manifest.chrome-web-store.json`

Submission checklist and guidance:

- `CHROME_WEB_STORE.md`
- `CHROME_WEB_STORE_REQUEST_TEMPLATE.md`
- `PRIVACY.md`

## How it works

```
OpenCode Plugin <-> Local Broker (unix socket) <-> Native Host <-> Chrome Extension
```

- The extension connects to the native host.
- The plugin talks to the broker over a local unix socket.
- The broker forwards tool requests to the extension and enforces tab ownership.

## Agent Browser mode (alpha)

This branch adds an alternate backend powered by `agent-browser` (Playwright). It runs headless and does **not** reuse your existing Chrome profile.

### Enable locally

1. Install `agent-browser` and Chromium:

```bash
npm install -g agent-browser
agent-browser install
```

2. Set the backend mode:

```bash
export OPENCODE_BROWSER_BACKEND=agent
```

Optional overrides:
- `OPENCODE_BROWSER_AGENT_SESSION` (custom session name)
- `OPENCODE_BROWSER_AGENT_SOCKET` (unix socket path)
- `OPENCODE_BROWSER_AGENT_AUTOSTART=0` (disable auto-start)
- `OPENCODE_BROWSER_AGENT_DAEMON` (explicit daemon path)

### Tailnet/remote host

On the host (e.g., `home-server.taild435d7.ts.net`), run the TCP gateway:

```bash
OPENCODE_BROWSER_AGENT_GATEWAY_PORT=9833 node bin/agent-gateway.cjs
```

On the client:

```bash
export OPENCODE_BROWSER_BACKEND=agent
export OPENCODE_BROWSER_AGENT_HOST=home-server.taild435d7.ts.net
export OPENCODE_BROWSER_AGENT_PORT=9833
```

## Per-tab ownership

- Each session owns its own tabs; tabs are never shared between sessions.
- If a session has no tab yet, the broker auto-creates a background tab on first tool use.
- `browser_open_tab` always creates and claims a new tab for the session.
- Claims expire after inactivity (`OPENCODE_BROWSER_CLAIM_TTL_MS`, default 5 minutes).
- Use `browser_status` or `browser_list_claims` for debugging.

## Available tools

Core primitives:
- `browser_status`
- `browser_get_tabs`
- `browser_list_claims`
- `browser_claim_tab`
- `browser_release_tab`
- `browser_open_tab`
- `browser_close_tab`
- `browser_navigate`
- `browser_query` (modes: `text`, `value`, `list`, `exists`, `page_text`; optional `timeoutMs`/`pollMs`)
- `browser_click` (optional `timeoutMs`/`pollMs`)
- `browser_type` (optional `timeoutMs`/`pollMs`)
- `browser_select` (optional `timeoutMs`/`pollMs`)
- `browser_scroll` (optional `timeoutMs`/`pollMs`)
- `browser_wait`

Downloads:
- `browser_download`
- `browser_list_downloads`

Uploads:
- `browser_set_file_input` (extension backend supports small files; use agent backend for larger uploads)

Selector helpers (usable in `selector`):
- `label:Mailing Address: City`
- `aria:Principal Address: City`
- `placeholder:Search`, `name:email`, `role:button`, `text:Submit`
- `css:label:has(input)` to force CSS

Selector-based tools wait up to 2000ms by default; set `timeoutMs: 0` to disable.

Diagnostics:
- `browser_snapshot`
- `browser_screenshot`
- `browser_version`

## Roadmap

- [ ] Add tab management tools (`browser_set_active_tab`)
- [ ] Add navigation helpers (`browser_back`, `browser_forward`, `browser_reload`)
- [ ] Add keyboard input tool (`browser_key`)
- [x] Add download support (`browser_download`, `browser_list_downloads`)
- [x] Add upload support (`browser_set_file_input`)

## Troubleshooting

**Extension says native host not available**
- Re-run `npx @different-ai/opencode-browser install`
- If you loaded a custom extension ID, rerun with `--extension-id <id>`

**Tab ownership errors**
- Errors usually mean you passed a `tabId` owned by another session
- Use `browser_open_tab` to create a tab for your session (or omit `tabId` to use your default)
- Use `browser_status` or `browser_list_claims` for debugging

## Uninstall

```bash
npx @different-ai/opencode-browser uninstall
```

Then remove the unpacked extension in `chrome://extensions` and remove the plugin from `opencode.json` or `opencode.jsonc`.

## Privacy

- Privacy policy: `PRIVACY.md`
