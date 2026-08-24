# Chrome Web Store Listing Copy (Draft)

Use this as starter content when creating the listing.

## Name

OpenCode Browser Automation

## Short description

Automate real Chrome tabs for OpenCode with local native messaging and per-tab session ownership.

## Detailed description

OpenCode Browser Automation connects OpenCode to your real browser tabs so you can automate workflows on sites you authorize.

What it does:

- Open, close, and navigate tabs
- Click, type, select, query, and scroll on pages
- Capture snapshots and screenshots
- Manage downloads and file-input uploads
- Optional DevTools diagnostics and controls: console logs, page errors, network request inspection, JS evaluation, cookies, storage, performance metrics, and raw Chrome DevTools Protocol commands

Architecture:

- Chrome extension + local native messaging host
- Local broker enforces per-tab ownership for safer multi-session automation

Important:

- This extension is a companion to OpenCode
- It requires local setup of the native messaging host
- It operates on websites only after permissions are granted

## Support URL

https://github.com/talhabw/opencode-browser/issues

## Homepage URL

https://github.com/talhabw/opencode-browser

## Privacy policy URL

Host and link to the published version of `PRIVACY.md`.

## Permission justification (for reviewer notes)

- `scripting` and site access: execute user-requested browser actions on user-authorized websites.
- `nativeMessaging` (optional): bridge Chrome extension requests to a local companion process.
- `downloads` (optional): support automation workflows that trigger file downloads.
- `debugger` (optional): support explicit DevTools features (console and page errors, network inspection, JS evaluation, cookies/storage access, performance metrics, and raw DevTools Protocol commands).
