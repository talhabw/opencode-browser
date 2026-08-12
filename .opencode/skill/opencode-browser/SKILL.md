---
name: opencode-browser
description: Automate Chrome or Chromium through the OpenCode Browser plugin. Use for tabs, navigation, page content, element interaction, forms, screenshots, files, downloads, console logs, and browser errors.
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
