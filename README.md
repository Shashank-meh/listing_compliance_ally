# Listing Compliance Ally — Chat UI

Chat front end for the **Listing Compliance Ally** agent on SimplAI: audit Amazon listings against
29 cited content rules, benchmark against competitors, and review a compliant rewrite where every
change names its rule.

![Preview](preview.png)

## Features
- Starter flows: audit a SKU, compare with competitors, full audit → rewrite → sign-off
- Markdown replies with tables; rule IDs (e.g. `AMZ-TITLE-04`) become clickable chips, severities are colour-coded
- Audit panel: compliance score (before → after) and every rule cited in the conversation
- Follow-up suggestions, conversation history, stop / retry, mobile layout

## Deploy to Vercel
1. On [vercel.com/new](https://vercel.com/new), import this GitHub repo (Framework preset: **Other**, no build command).
2. Add these **Environment Variables** before deploying:

   | Name | Value |
   |---|---|
   | `SIMPLAI_API_KEY` | your PIM-SID API key |
   | `SIMPLAI_TENANT_ID` | e.g. `11` |
   | `SIMPLAI_USER_ID` | e.g. `72` |
   | `SIMPLAI_AGENT_ID` | e.g. `agent-…` |
   | `SIMPLAI_DEVICE_ID` | optional, defaults to `simplai` |
   | `SIMPLAI_BASE_URL` | optional, defaults to `https://edge-service.simplai.ai` |
   | `ANTHROPIC_API_KEY` | for **Check images** (Claude vision); without it only the measured checks run |
   | `RESEND_API_KEY` | to email the brand for approval with the CSV attached ([resend.com](https://resend.com)); without it the app opens a draft in your email app |
   | `EMAIL_FROM` | sender for approval emails, on a domain verified in Resend, e.g. `Listing Ally <ally@yourbrand.com>` |
   | `PUBLIC_BASE_URL` | optional, the public address CSV links should use (defaults to the Vercel production domain) |

3. Deploy. Every push to `main` redeploys automatically.
4. **Connect file storage** (needed for CSV audits): in the project, open **Storage → Create → Blob**, create a
   store and connect it to this project. Vercel adds the store credentials for you; redeploy once. A **private** store is fine: files are served through this app.

### How attached CSVs reach the agent
The agent's `audit-file` tool takes a `csv_url`. When you attach a CSV, the app uploads it to Vercel Blob and
sends the agent a short URL on this site (`/c/<id>/listings.csv`). Without Blob storage the app falls back to a
self-contained link (`/f/<gzip+base64>/listings.csv`), which works but is long enough that the model may
mis-copy it.

The API key lives only in Vercel's environment; the browser talks to `/api/*` functions, never to SimplAI directly.

## Image checks
After an audit, **Check images** reviews each client SKU's `image_urls` against Amazon's image requirements.
This runs in the app (`lib/images.js`), not the SimplAI agent:
- **Measured in code:** white background (edge pixels), product fill (≥85% of the frame), resolution (≥1000 px), file type, image count (5–7).
- **Judged by Claude vision** (`claude-opus-5-5`): main image free of text/logos/badges, props, cropping, real photo, sharpness; secondary images free of promotional badges.
Map checks to your rulebook IDs in `RULE_IDS` in `lib/images.js`.

## The journey
Upload → Audit → Deep-dive → Benchmark → Rewrite → Re-score → Approve. The stepper in the top bar shows
progress and runs a step when clicked; after each reply the next step is offered first. **Approve** emails the
brand the rewritten CSV with before → after scores, the confirm-with-brand items and the review sheet link.
**Upload to Amazon** is shown as coming soon.

**Autopilot** (on by default, switch in the bar under the stepper) runs the whole journey after an upload:
it audits all client SKUs, deep-dives each one (up to 5), benchmarks, rewrites, re-scores from the review
sheet and opens the approval email. **Skip step** moves on, clicking a step in the stepper jumps there
(earlier steps that never ran are marked skipped), and **Pause** holds it. It pauses itself on an error, an
unreadable sheet, or a reply it can't read, and stops at the approval email, which needs the brand's address.

## Re-score from the review sheet
When the agent shares a Google Sheet, **Re-score from sheet** reads it (`lib/sheets.js`, via Google's CSV
export, so the sheet must be shared as "Anyone with the link can view"; otherwise upload the sheet as CSV).
The app matches the SKU and rewritten title / bullets / description columns (you can adjust the mapping),
merges the rewrites into the original listings CSV, offers the merged CSV for download, and sends it to the
agent to score again, showing before → after.

## Run locally
```bash
cp .env.example .env   # fill in your keys
npm start              # Node 18+, no dependencies
```
Open http://localhost:5173.

## How it works
| UI route | SimplAI endpoint |
|---|---|
| `POST /api/chat` | `POST /interact/api/ve1/intract/agent/conversation` |
| `GET /api/poll` | `GET /interact/api/v1/intract/conversation/fetchDetails` (polled every 1.5 s until `message_status` is `2`, up to 3 min) |
| `GET /api/conversations` | `GET /interact/api/ve1/intract/conversation` |
| `GET /api/conversation?id=` | `GET /interact/api/ve1/intract/conversation/{id}` |
| `POST /api/upload` | Stores an attached CSV in Vercel Blob |
| `GET /c/<id>/<name>.csv` | Serves a stored CSV (short link sent to the agent) |
| `GET /f/<data>/<name>.csv` | Serves a CSV packed into the URL (fallback) |

- `lib/simplai.js` — SimplAI client, shared by both runtimes
- `api/*.js` — Vercel serverless functions
- `server.js` — local dev server
- `public/` — the UI (vanilla JS, no build step)
