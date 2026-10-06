# Website Submissions Ledger

Every Netlify form submission on oxfordra.net is appended to one Excel workbook on SharePoint/OneDrive: one tab and one Excel Table per form type, written through Microsoft Graph by `netlify/functions/submissions-ledger.js`.

## How it works

1. A visitor submits any Netlify form (spam-filtered by Netlify first).
2. Netlify's **outgoing webhook** (any form) POSTs the signed submission to `/.netlify/functions/submissions-ledger`.
3. The function verifies the HMAC signature (`NETLIFY_WEBHOOK_SECRET`), reads the table's live header row, maps values by header name, and appends a row. Redeliveries are de-duplicated on Submission ID.
4. Netlify keeps the raw submission as the system of record. A failed append returns 502 (Netlify retries) and logs to the `pipeline-failures` form.

No form markup changes: every form already carries `data-netlify`.

## Forms and tabs

| Form (`name`) | Tab |
|---|---|
| commercial-lease-application | Tenant Applications |
| owner-submission-intake | Owner Submissions |
| broker-submission-intake | Broker Submissions |
| broker-network-ledger | Broker Scores |
| leasing-inquiry | Leasing Inquiries |
| listing-inquiry | Listing Inquiries |
| contact | Contact |
| checklist-download | Checklist Downloads |
| chat-lead | Chat Leads |
| pipeline-failures | Pipeline Failures |
| anything else | Other Forms (full JSON) |

Tenant applications store form text plus the uploaded **file names** and a `Docs Folder` pointer (`Tenant Applications/*_<first 8 of submission id>`). The documents themselves stay in the OneDrive folder `tenant-application-processor` already creates; no file URLs are written to Excel.

## One-time setup (Gabriel)

1. **Graph app permissions.** Reuses the existing app (`GRAPH_TENANT_ID` / `GRAPH_CLIENT_ID` / `GRAPH_CLIENT_SECRET` / `GRAPH_DRIVE_ID`). It already writes files to the drive, so confirm it holds `Files.ReadWrite.All` (or `Sites.Selected` with write on the site). Workbook calls need no extra scope.
2. **Env vars (Netlify, Site settings → Environment).** Optional: `GRAPH_LEDGER_PATH` (default `Website Submissions/ORA_Website_Submissions_v1.0.xlsx`, relative to the `GRAPH_DRIVE_ID` drive root). `LEDGER_TEXT_PREFIX` (default `'`; see step 5).
3. **Webhook.** Site settings → Build & deploy → Post processing → Deploy notifications → Add notification → **Outgoing webhook**, event **Form submission**, form **Any form**, URL `https://oxfordra.net/.netlify/functions/submissions-ledger`, with the same JWS signature secret as the other three webhooks (`NETLIFY_WEBHOOK_SECRET`).
4. **Restrict the folder.** The first submission creates `Website Submissions/` and the workbook automatically. Then in SharePoint, break inheritance on that folder and share only with Gabriel and Eric. The file contains applicant PII.
5. **Verify on a preview deploy before production.** Submit a test contact form with the message `=1+1` and a phone starting with `0`. Confirm the cell shows the literal text with no visible apostrophe and no formula result. If an apostrophe is visible, set `LEDGER_TEXT_PREFIX` to an empty string and instead set the affected columns to Text format in the template.
6. **Production deploy** only on explicit approval, per the oxfordra.net deploy rule.

## Changing the schema

Edit `netlify/functions/_shared/submissions-schema.json`, run `python3 scripts/build-submissions-template.py`, commit the regenerated `submissions-template.xlsx`. Fields not yet in the schema are never lost: they land in `Other Fields (JSON)`. For an already-live workbook, add the new column header in Excel (rows are mapped by header name, so no code deploy is required for existing tables).

## Operations

- **Missed row:** replay from Netlify → Forms → submission → Resend webhook; the dedupe check makes this safe.
- **Secret rotation:** `GRAPH_CLIENT_SECRET` expires every 24 months (see the graph-app-registration runbook). Expiry shows up as `ledger_append_failed` rows in Pipeline Failures.
- **Loop guard:** the ledger never logs its own failure when the submission is itself a `pipeline-failures` row, otherwise a Graph outage would re-trigger the webhook indefinitely.
- **Concurrency:** Graph serializes workbook writes; the function retries 409/423/429/5xx up to 4 times. Avoid editing the workbook in desktop Excel with an exclusive lock during business hours.
