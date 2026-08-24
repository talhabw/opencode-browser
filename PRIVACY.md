# OpenCode Browser Privacy Policy

Last updated: 2026-02-10

OpenCode Browser is a companion extension for the OpenCode plugin. It automates browser actions based on user requests.

## What data the extension can access

Depending on granted permissions and the sites you allow, the extension can access:

- Website content (DOM text, element attributes, links, forms)
- User activity related to requested automation steps (clicks, typing, selection)
- Screenshots and page snapshots requested by the user
- Download metadata for files initiated by automation
- Optional diagnostics data (console messages and page errors) when debugger permission is granted
- Network activity metadata (request URLs, methods, status codes, headers, timings) when debugger permission is granted; request/response bodies are only retrieved when explicitly requested by an automation command
- Cookie and storage (local/session storage) data when explicitly inspected or modified via automation commands
- Results of JavaScript expressions evaluated in pages at the user's explicit request (`browser_eval`), performance metrics, and raw Chrome DevTools Protocol command results (`browser_devtools`)

## How data is used

- Data is used only to execute the browser automation commands requested by the user.
- Data is passed to a local native messaging host (`com.opencode.browser_automation`) and local OpenCode plugin processes.
- The extension does not include third-party analytics SDKs or ad trackers.

## Data sharing

- The extension itself does not sell personal data.
- The extension itself does not transfer data to unrelated third parties.
- If you use OpenCode with remote models or services, data you request OpenCode to process may be sent by OpenCode according to your OpenCode configuration.

## Data retention

- Most data is processed in memory for the active automation session.
- Console/error buffers are in-memory rolling buffers and are cleared when tabs close, extension restarts, or when explicitly cleared by tool calls.
- Network capture buffers are in-memory rolling buffers (most recent ~400 requests per tab) and are cleared when tabs close, extension restarts, or when explicitly cleared via `browser_network`.
- DevTools buffers (console/errors/network) are keyed per browser tab, not per OpenCode session: if a tab's ownership passes to another session, that session can read the buffered data until the tab closes, the extension restarts, or the buffer is cleared.
- Native host configuration files are stored locally on the machine for installation and runtime setup.

## User controls

- You can remove optional permissions at any time in `chrome://extensions`.
- You can uninstall the extension and native host at any time.
- You can disable or remove the OpenCode plugin from your OpenCode configuration.

## Security model

- Native messaging traffic stays on the local machine between Chrome and the local native host.
- The extension requires explicit permissions and site access.

## Contact

Questions or concerns:

- Project: https://github.com/talhabw/opencode-browser
- Issues: https://github.com/talhabw/opencode-browser/issues
