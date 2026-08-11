# Request: Publish OpenCode Browser to Chrome Web Store

## Goal

Publish `@talhabw/opencode-browser` extension to Chrome Web Store and pass review.

## Scope

- Publish extension package built from `bun run build:cws`
- Complete Chrome Web Store listing metadata and data safety disclosures
- Submit for review and address policy feedback

## Package

- Artifact path: `artifacts/chrome-web-store/opencode-browser-cws-v<version>.zip`
- Effective store manifest: `artifacts/chrome-web-store/manifest.chrome-web-store.json`
- Privacy policy source: `PRIVACY.md`

## Acceptance Criteria

- Listing draft is complete with icons, screenshots, description, support URL, and privacy policy URL
- Data disclosure form is fully completed and aligned with `PRIVACY.md`
- Submission is sent for review
- If rejected, reviewer feedback is captured with a concrete remediation checklist

## Known manual blockers

- Chrome Web Store developer account access and payment
- Identity verification and publisher profile completion
- Final privacy policy hosted URL
- Human review turnaround time

## Recommended owner checklist

1. Run `bun run build:cws`
2. Verify extension loads from `artifacts/chrome-web-store/extension`
3. Upload zip in Chrome Web Store dashboard
4. Complete listing and disclosures
5. Submit and track review status
