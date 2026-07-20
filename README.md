# TalentScope — Railway Deployment (Central Shared Workspace)

One deployment, one database, one URL for the whole HR team. Screening results,
interviewer availability, offered slots, and confirmation statuses are stored
centrally in Postgres — anyone opening the app sees the same live data, and
nothing is lost when a laptop closes or a person goes on leave.

## What's new (build 2026-07-18.4) — Security hardening & GDPR / UAE PDPL support

**Security scan & remediation performed:**
- `npm audit`: **0 vulnerabilities**; lockfile now pins patched express 4.22.2 / pg 8.22.0.
- **Fixed stored XSS** (high): candidate names, emails, reasons, interviewer names,
  and uploaded filenames — all attacker-controllable via a crafted CV or availability
  sheet — were rendered unescaped in the scheduling table, dashboard by-role table,
  candidate-lookup table/dropdowns, and availability summaries. All sinks now HTML-escape.
- **Fixed CSV/Excel formula injection** (high): exported cells starting with `= + - @`
  (e.g. a CV named `=HYPERLINK(...)`) would execute as formulas when HR opens a report.
  All exports (department reports, dossier, mail-merge, scheduling) now neutralise
  leading formula characters.
- **Server hardening:** security headers on every response (nosniff, X-Frame-Options
  DENY, Referrer-Policy, Permissions-Policy, HSTS on HTTPS), `x-powered-by` removed,
  **timing-safe** team-code comparison, per-IP **rate limiting** on the AI proxy
  (60/min) so leaked URLs can't burn your API credits, and a startup warning if
  `TEAM_CODE` is unset. Verified live: 401 without code, 429 after limit.

**GDPR / UAE PDPL (Federal Decree-Law 45/2021) support — new Data & Privacy panel
(Candidates tab):**
- **Storage limitation:** configurable auto-retention (6/12/24 months) purges old
  candidacy records on every load, plus a manual "Apply retention now."
- **Data minimisation:** toggle to stop storing CV text (disables database matching
  for new records; existing text stripped on next retention run).
- **Right of access / portability (DSAR):** per-candidate "Export this candidate's
  data" (JSON of all screening records + interview invitations) in Candidate Lookup.
- **Right to erasure:** the existing per-candidate delete removes all records,
  results, comments, and invitations workspace-wide.
- **Transparency:** privacy notice on the login screen disclosing processing purpose
  and AI sub-processors.

**Compliance responsibilities that remain with your organisation (no tool can do
these for you):** a lawful basis / candidate consent for processing; disclosing
cross-border transfer of CV data to AI providers (Anthropic/OpenAI/Google — US-based;
PDPL Art. 22–23 requires adequate protection or consent for transfers out of the UAE);
DPAs with those providers; choosing an appropriate Railway region for data residency;
setting `TEAM_CODE` and limiting who has the URL; breach-notification procedures;
and a records-of-processing entry for this system. Recommended: set retention to 12
months or less, keep `TEAM_CODE` set, and put the app behind an identity layer
(Cloudflare Access / Entra ID) for per-user authentication.

## What's new (build 2026-07-18.3) — End-to-end recruitment pipeline

- **New Pipeline tab** turns TalentScope into a single pane of glass for the
  internal recruiting workflow:
  - **Job Openings (requisitions):** create an opening per role with headcount,
    hiring manager, and target date. Hires count against headcount automatically;
    close/reopen at any time. New screenings auto-link to a matching open opening.
  - **Kanban Pipeline Board:** every candidacy (candidate × role) flows
    Screened → Shortlisted → Interview → Offer → Hired, with a Rejected lane
    (toggleable). Move cards with ‹ › / ✕ buttons; every move is stamped with
    who moved it and when (full stage history kept). Filter by department or opening.
  - **Recruitment Overview metrics:** open positions, candidates in pipeline,
    offers out, total hired, and average time-to-hire.
- **Stage ↔ status sync:** AI verdicts seed the starting stage (Approved →
  Shortlisted, On Hold → Screened, Rejected → Rejected); moving a card updates
  the candidate's status everywhere, and changing status in the Candidates tab
  moves the card sensibly. The Profiles table and exports now show Pipeline Stage.
- Openings and stage history sync to the shared database like everything else.

**Not included (needs external services, by design):** a candidate-facing
application portal, job-board posting (LinkedIn/Indeed), e-signature offers,
background checks, and per-user SSO. For those, pair TalentScope with the
relevant service; everything internal-to-HR now lives here.

## What's new (build 2026-07-18.2)

- **Roles tab is now a full page.** Add / delete / update departments and roles
  lives here (no more hidden toggle), alongside the JD Library (upload/paste +
  save per role) and a **Roles Dashboard** — every role across every department
  with JD status, candidates screened, and Approved/On Hold/Rejected counts at
  a glance.
- **Screening page is now upload-only.** § 01 is just a department/role picker
  showing whether a JD is on file; the actual JD upload/edit happens on the
  Roles tab, so day-to-day screening is just "pick role → upload CVs → run."
- **Candidates tab overhauled.** A new **All Profiles** table lists every
  candidate in the database with Department, Role, editable **Status**
  (Approved / On Hold / Rejected), score, and screening date — filterable by
  department and status, plus a **search box** (name, email, or phone).
  Each row has a comments thread (💬) so the team can leave notes on a profile;
  status changes and comments save immediately to the shared database.
- **"Borderline" is now "On Hold"** everywhere in the Candidates/Reports views,
  and it's editable — HR can move any candidate between Approved / On Hold /
  Rejected regardless of what the AI originally decided.

## What's new (build 2026-07-18.1)

- **Departments & roles with a persistent JD library.** Departments (DevOps
  Engineering, API Settings, Finance, High Churn — fully editable) each hold
  roles (e.g. Intro DevOps Engineer, ASR Engineer, Cyber Security Engineer),
  and each role stores **one JD, uploaded once**. HR picks the department + role
  from dropdowns; nobody re-uploads a JD for every screening run. JDs sync to
  the shared database so the whole team uses the same library.
- **Cross-role auto-rescan.** CVs rejected for the selected role are
  automatically re-checked against every other role that has a saved JD
  (same department first); strong alternate fits are flagged in the results,
  reports, and exports.
- **Department Reports.** A permanent report of every candidate ever screened:
  name, email, editable Employee ID, department, role, status
  (Approved / Under review / Not selected), reason, screening completion date,
  and who uploaded the CV. Filter by department/status; export CSV or a
  multi-sheet Excel with one tab per department.
- **Find Matches in Existing Database.** For a new opening, pick the department
  + role and TalentScope re-screens every candidate already on file against
  that role's JD — no re-uploads. (Résumé text is stored, capped at 8k chars
  per candidate, to make this possible.)
- **Duplicate detection against the database.** If an uploaded CV matches a
  name already screened, it's badged "already screened" with a link to the
  previous result in the dashboard — and can still be re-screened for a new role.
- **Single login + guest access.** One login form (name + optional shared team
  code) replaces the demo profiles. Guests get one-click, view-only access:
  they can browse reports and dashboards but can't upload JDs/CVs or run
  screenings.
- **Uploader tracking.** A popup captures who is uploading each CV batch
  (pre-filled, one click for the same person); the name is stored in an
  **Uploaded by** column throughout the database, reports, and Excel exports.

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
