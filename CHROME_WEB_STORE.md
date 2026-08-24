# Chrome Web Store Submission Guide

This document is the maintainer runbook to prepare and submit OpenCode Browser to the Chrome Web Store.

## 1) Build a store-ready package

From the repo root:

```bash
bun run build:cws
```

This generates:

- `artifacts/chrome-web-store/opencode-browser-cws-v<version>.zip`
- `artifacts/chrome-web-store/extension/` (staging folder)
- `artifacts/chrome-web-store/manifest.chrome-web-store.json` (effective store manifest)

## 2) What the store build changes

The build script transforms `extension/manifest.json` for review-friendly defaults:

- Removes `key` from the store manifest artifact
- Moves broad site access from required `host_permissions` to `optional_host_permissions`
- Moves `nativeMessaging`, `downloads`, and `debugger` to `optional_permissions`
- Drops `notifications` from required permissions

The extension requests optional permissions from the extension action click flow.

## 3) Required listing assets and metadata

Prepare these before submission:

- Extension name, short and long descriptions
- 128x128 icon
- Chrome Web Store screenshots
- Support URL (GitHub issues is acceptable)
- Privacy policy URL (host `PRIVACY.md` on a public URL)

## 4) Data disclosure form (recommended answers)

OpenCode Browser can handle the following categories when a user asks it to automate pages:

- Website content
- User activity
- Personal communications and PII (possible on user-selected sites)

Use the policy in `PRIVACY.md` and disclose local native messaging architecture clearly.

## 5) Permission justification text (copy starter)

- `scripting` and site access: required to execute user-requested browser actions on pages the user authorizes.
- `nativeMessaging`: required to connect Chrome extension commands to a local companion host process.
- `debugger` (optional): used only for explicit DevTools features (console and page errors, network inspection, JS evaluation, cookies/storage access, performance metrics, and raw DevTools Protocol commands).
- `downloads` (optional): used for automation workflows that initiate downloads.

## 6) Manual submission steps

1. Sign in to Chrome Web Store Developer Dashboard.
2. Create or open the draft listing.
3. Upload `artifacts/chrome-web-store/opencode-browser-cws-v<version>.zip`.
4. Complete privacy/data safety disclosures.
5. Add screenshots, descriptions, and support links.
6. Submit for review.

## 7) Post-approval follow-up

After first publish:

1. Record the final store extension ID.
2. Verify native host install path supports that ID (`--extension-id` flow in `bin/cli.js`).
3. Update README installation flow to prefer Web Store install + local host install.
