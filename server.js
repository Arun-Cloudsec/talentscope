/* TalentScope central-state server for Railway
 * - Serves the single-page app (index.html)
 * - Stores the shared workspace state (screening results + scheduling) centrally
 * - Storage: Railway Postgres if DATABASE_URL is set, otherwise a JSON file
 * - Optional shared team passcode via TEAM_CODE env var
 */
const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '15mb' }));

const PORT = process.env.PORT || 3000;
const TEAM_CODE = process.env.TEAM_CODE || '';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'state.json');

/* ── Storage adapter ── */
const usePg = !!process.env.DATABASE_URL;
let pool = null;

async function initStorage() {
  if (usePg) {
    const { Pool } = require('pg');
    const cs = process.env.DATABASE_URL;
    pool = new Pool({
      connectionString: cs,
      // Railway internal networking (postgres.railway.internal) rejects SSL;
      // public proxy connections require it.
      ssl: cs.includes('railway.internal') ? false : { rejectUnauthorized: false },
    });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_state (
        key        TEXT PRIMARY KEY,
        data       JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_by TEXT
      )`);
    console.log('Storage: Postgres');
  } else {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    console.log('Storage: JSON file at ' + DATA_FILE + ' (add Railway Postgres + a volume for durability)');
  }
}

async function readState() {
  if (usePg) {
    const r = await pool.query(`SELECT data, updated_at, updated_by FROM app_state WHERE key = 'workspace'`);
    if (r.rows.length === 0) return null;
    return { state: r.rows[0].data, updatedAt: r.rows[0].updated_at.toISOString(), updatedBy: r.rows[0].updated_by || '' };
  }
  if (!fs.existsSync(DATA_FILE)) return null;
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

async function writeState(state, updatedBy) {
  const updatedAt = new Date().toISOString();
  if (usePg) {
    await pool.query(
      `INSERT INTO app_state (key, data, updated_at, updated_by)
       VALUES ('workspace', $1, now(), $2)
       ON CONFLICT (key) DO UPDATE SET data = $1, updated_at = now(), updated_by = $2`,
      [state, updatedBy || '']
    );
  } else {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ state, updatedAt, updatedBy: updatedBy || '' }));
  }
  return updatedAt;
}

/* ── Optional shared-passcode gate for the API ── */
function auth(req, res, next) {
  if (!TEAM_CODE) return next();
  if (req.get('x-team-code') === TEAM_CODE) return next();
  res.status(401).json({ error: 'Team code required' });
}

/* ── AI proxy — keys live ONLY in Railway environment variables, never in the client ── */
const AI_KEYS = {
  anthropic: process.env.ANTHROPIC_API_KEY || '',
  openai: process.env.OPENAI_API_KEY || '',
  google: process.env.GOOGLE_API_KEY || '',
};

app.post('/api/ai/claude', auth, async (req, res) => {
  if (!AI_KEYS.anthropic) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured on server' });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': AI_KEYS.anthropic,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req.body),
    });
    res.status(r.status).json(await r.json());
  } catch (e) { res.status(502).json({ error: 'Upstream Anthropic error: ' + e.message }); }
});

app.post('/api/ai/openai', auth, async (req, res) => {
  if (!AI_KEYS.openai) return res.status(503).json({ error: 'OPENAI_API_KEY not configured on server' });
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + AI_KEYS.openai },
      body: JSON.stringify(req.body),
    });
    res.status(r.status).json(await r.json());
  } catch (e) { res.status(502).json({ error: 'Upstream OpenAI error: ' + e.message }); }
});

app.post('/api/ai/gemini', auth, async (req, res) => {
  if (!AI_KEYS.google) return res.status(503).json({ error: 'GOOGLE_API_KEY not configured on server' });
  try {
    const model = req.query.model || 'gemini-3.1-pro-preview';
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${AI_KEYS.google}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    });
    res.status(r.status).json(await r.json());
  } catch (e) { res.status(502).json({ error: 'Upstream Gemini error: ' + e.message }); }
});

/* ── API ── */
app.get('/api/health', (req, res) => res.json({
  ok: true,
  storage: usePg ? 'postgres' : 'file',
  protected: !!TEAM_CODE,
  serverKeys: { anthropic: !!AI_KEYS.anthropic, openai: !!AI_KEYS.openai, google: !!AI_KEYS.google },
}));

app.get('/api/state', auth, async (req, res) => {
  try {
    const s = await readState();
    res.json(s || { state: null, updatedAt: null, updatedBy: '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/state', auth, async (req, res) => {
  try {
    if (!req.body || typeof req.body.state !== 'object') return res.status(400).json({ error: 'Body must be { state: {...} }' });
    const updatedAt = await writeState(req.body.state, req.body.updatedBy);
    res.json({ ok: true, updatedAt });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── Static app ── */
app.use(express.static(__dirname, { index: 'index.html' }));

initStorage()
  .then(() => app.listen(PORT, () => console.log('TalentScope running on port ' + PORT)))
  .catch(err => { console.error('Startup failed:', err); process.exit(1); });
