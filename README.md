# TalentScope — Railway Deployment (Central Shared Workspace)

One deployment, one database, one URL for the whole HR team. Screening results,
interviewer availability, offered slots, and confirmation statuses are stored
centrally in Postgres — anyone opening the app sees the same live data, and
nothing is lost when a laptop closes or a person goes on leave.

## Deploy in 5 minutes

1. **Push this folder to a GitHub repo** (or use `railway up` from the CLI).

2. **Create the Railway project**
   - Railway → New Project → Deploy from GitHub repo → select the repo.
   - Railway auto-detects Node and runs `npm start`.

3. **Add Postgres (this is the central store)**
   - In the project canvas: **+ New → Database → PostgreSQL**.
   - Open your app service → **Variables** → add a variable reference:
     `DATABASE_URL` → reference → Postgres → `DATABASE_URL`.
   - Redeploy. The server creates its table automatically on first boot.

4. **(Recommended) Protect the workspace**
   - App service → Variables → add `TEAM_CODE` = a passphrase you share with HR.
   - Each user is prompted once in the browser; the code is remembered per device.

5. **Open the public URL** (Settings → Networking → Generate Domain) and share it
   with the team.

## How the sync works

- Every change (screening finished, slots assigned, invitation sent, candidate
  confirmed) is saved to the server within ~1 second.
- Every open browser polls the server every 20 seconds, so a colleague's updates
  appear automatically — no refresh needed.
- Writes are last-write-wins. Fine for a small HR team working candidate-by-
  candidate; avoid two people editing the *same candidate's* status at the same
  moment.
- If the file is opened locally (not via the Railway URL), the app quietly falls
  back to browser-only storage, exactly as before.

## Environment variables

| Variable       | Required | Purpose                                               |
|----------------|----------|-------------------------------------------------------|
| `DATABASE_URL` | Recommended | Railway Postgres connection string (referenced)    |
| `TEAM_CODE`    | Optional | Shared passcode gating the API                        |
| `PORT`         | Auto     | Injected by Railway                                   |
| `DATA_FILE`    | Optional | JSON-file storage path if you skip Postgres (mount a Railway Volume at `/app/data` or data is lost on redeploys) |

## Notes for production use

- Candidate PII lives in this database — restrict the Railway project to the
  right team members and consider UAE PDPL data-residency requirements when
  choosing the Railway region.
- API keys for the AI models remain per-browser (localStorage); they are never
  stored on the server.
- For real login accounts per HR user (instead of a shared code), put the app
  behind an identity layer (e.g., Cloudflare Access or Entra ID app proxy) —
  no code changes needed.
