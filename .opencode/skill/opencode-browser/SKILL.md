---
name: opencode-browser
description: Automate Chrome or Chromium through the OpenCode Browser plugin. Use for tabs, navigation, page content, element interaction, forms, screenshots, files, downloads, console logs, browser errors, network requests, cookies, storage, performance, and raw DevTools Protocol commands.
license: MIT
compatibility: opencode-v2
metadata:
  audience: agents
  domain: browser
---

# Browser Automation

The current Code Mode catalog is authoritative for tool signatures.

## Invoking the tools

All `browser_*` tools are registered in the `opencode-browser` namespace. They can only be called inside `execute` blocks — direct calls (`browser_status`) or dot notation (`tools.opencode-browser.browser_status`) fail with `Unknown tool`.

Correct pattern — bracket notation, and await the call:

```js
const status = await tools["opencode-browser"]["browser_status"]({})
```

- Results are JSON strings: `JSON.parse()` them when you need structured values.
- Run independent calls concurrently with `Promise.all([...])`.
- Keep parameters in a plain object, e.g. `tools["opencode-browser"]["browser_query"]({ mode: "page_text" })`.

## Tools

Tabs and ownership:

- `browser_get_tabs`, `browser_open_tab`, `browser_close_tab`, `browser_navigate`
- `browser_claim_tab`, `browser_release_tab`, `browser_list_claims`
- `browser_status`, `browser_debug`, `browser_version`

Read and interact:

- `browser_query`, `browser_snapshot`, `browser_screenshot`
- `browser_click`, `browser_type`, `browser_select`, `browser_scroll`, `browser_wait`
- `browser_highlight`

Files and diagnostics:

- `browser_download`, `browser_list_downloads`, `browser_set_file_input`
- `browser_console`, `browser_errors`

DevTools (Chrome DevTools Protocol via the tab debugger):

- `browser_network` — Network tab: list captured requests/responses (filter, method, onlyFailed, limit, includeBody, clear)
- `browser_eval` — Console: run JS in the page context (`expression`, `awaitPromise`)
- `browser_cookies` — Application › Cookies: list/get/set/delete/clear
- `browser_storage` — Application › Local/Session Storage: list/get/set/remove/clear
- `browser_performance` — Performance tab: metrics + optional resource timing (`resources: true`)
- `browser_devtools` — raw CDP passthrough for every other panel (DOM/Sources/Application/Security/Log/Page/Emulation/...)

## DevTools usage

Map DevTools panels to tools:

| Need | Tool |
| --- | --- |
| See page console logs / JS errors | `browser_console`, `browser_errors` |
| Run code in the page | `browser_eval` |
| See what the page fetched (XHR/fetch/doc/WS) | `browser_network` |
| Inspect/modify cookies | `browser_cookies` |
| Inspect/modify localStorage/sessionStorage | `browser_storage` |
| Page performance counters | `browser_performance` |
| Inspect DOM, set breakpoints, IndexedDB, security, logs, page reload, emulation... | `browser_devtools` (`method`, `params`) |

Working patterns:

- **Capture a full page load**: the debugger attaches on the first devtools call on a tab and stays attached, so `browser_network` accumulates requests across calls. To see the whole lifecycle of a page, call `browser_network` once, then reload (`browser_devtools` with `method: "Page.reload"`, or `browser_navigate` to the same URL) and read `browser_network` again.
- **Find the API behind a button**: click it, then `browser_network` with `filter` matching the endpoint name (e.g. `"derskayit"`), and use `includeBody: true` to see the JSON request/response payloads.
- **One debugger per tab**: Chrome allows a single debugger attachment per tab. If DevTools UI is open on a tab, devtools tools fail with `Debugger not attached` — close DevTools on that tab (or use another tab) and retry.
- `browser_eval` results must be JSON-serializable; async code works with `awaitPromise: true` (default). Exceptions come back as `{ ok: false, ... }`.
- `browser_cookies` needs `url` or `domain` when setting/deleting; `browser_storage` operates on the page's own origin.
- `browser_devtools` is powerful — send only commands you understand; state (e.g. `Debugger.pause`) persists until changed.

## Useful Behavior

- Prefer a new background tab for independent tasks. `browser_open_tab` creates and claims one for the session.
- Omit `tabId` to use the session's default owned tab. Do not force-claim another session's tab unless explicitly requested.
- Inspect with `browser_query` before ambiguous actions and verify state after consequential ones.
- Selector tools poll for up to 2000 ms by default on the extension backend; use `timeoutMs` instead of fixed waits where possible.
- `browser_type` appends unless `clear: true`.
- `browser_select` is for native `<select>` elements and needs `value`, `label`, or `optionIndex`.
- `browser_download` needs either `url` or `selector`, not both. Use `wait: true` when completion matters.


## Selecting options

- Use `browser_select` for native `<select>` elements
- Prefer `value` or `label`; use `optionIndex` when needed


## Query modes

- `text`: read visible text from a matched element
- `value`: read input values
- `list`: list many matches with text/metadata
- `exists`: check presence and count
- `page_text`: extract visible page text


## Opening tabs

- Use `browser_open_tab` to create a new tab, optionally with `url` and `active`


## Troubleshooting

- If a selector fails, run `browser_query` with `mode=page_text` to confirm the content exists
- Use `mode=list` on broad selectors (`button`, `a`, `*[role="button"]`, `*[role="listitem"]`) and choose by index
- For inbox/chat panes, try text selectors first (`text:Subject line`) then verify selection with `browser_query`
- For scrollable containers, pass both `selector` and `x`/`y` to `browser_scroll` and then verify `scrollTop`
- Confirm results after each action
