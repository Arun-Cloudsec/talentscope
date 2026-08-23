/* TalentScope central-state server for Railway
 * - Serves the single-page app (index.html)
 * - Stores the shared workspace state (screening results + scheduling) centrally
 * - Storage: Railway Postgres if DATABASE_URL is set, otherwise a JSON file
 * - Optional shared team passcode via TEAM_CODE env var
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { reportTelemetry } = require('./lib/telemetryClient');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '15mb' }));

/* ── Security headers on every response ── */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');                       // no embedding in iframes (clickjacking)
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (req.secure || req.get('x-forwarded-proto') === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

const PORT = process.env.PORT || 3000;
const TEAM_CODE = process.env.TEAM_CODE || '';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'state.json');

if (!TEAM_CODE) {
  console.warn('⚠ TEAM_CODE is not set — the workspace API (candidate PII + AI proxy) is open to anyone with the URL. Set TEAM_CODE in Railway variables.');
}

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

/* ── Optional shared-passcode gate for the API (timing-safe comparison) ── */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
function auth(req, res, next) {
  if (!TEAM_CODE) return next();
  if (safeEqual(req.get('x-team-code') || '', TEAM_CODE)) return next();
  res.status(401).json({ error: 'Team code required' });
}

/* ── Simple in-memory rate limit for the AI proxy (per client IP) —
   caps abuse of the server-held API keys if the URL leaks. ── */
const RATE_LIMIT = { windowMs: 60_000, max: 60 };
const rateBuckets = new Map();
function aiRateLimit(req, res, next) {
  const ip = (req.get('x-forwarded-for') || req.socket.remoteAddress || '').split(',')[0].trim();
  const now = Date.now();
  let b = rateBuckets.get(ip);
  if (!b || now - b.start > RATE_LIMIT.windowMs) { b = { start: now, count: 0 }; rateBuckets.set(ip, b); }
  b.count++;
  if (rateBuckets.size > 5000) rateBuckets.clear(); // bound memory
  if (b.count > RATE_LIMIT.max) return res.status(429).json({ error: 'Rate limit exceeded — try again in a minute' });
  next();
}

/* ── AI proxy — keys live ONLY in Railway environment variables, never in the client ── */
const AI_KEYS = {
  anthropic: process.env.ANTHROPIC_API_KEY || '',
  openai: process.env.OPENAI_API_KEY || '',
  google: process.env.GOOGLE_API_KEY || '',
  azure: process.env.AZURE_OPENAI_KEY || '',
  compass: process.env.COMPASS_API_KEY || '',
};

/* ── Azure OpenAI and Core42 Compass ──────────────────────────────────────
   Both speak the Azure OpenAI wire format:
     POST {base}/openai/deployments/{deployment}/chat/completions?api-version=...
     header: api-key: <key>
   Compass is documented at https://api.core42.ai with the same shape, so one
   handler serves both — only the base URL, deployment and version differ.
   Compass matters here because it is UAE-hosted: for a CV screening tool,
   candidate personal data staying in-region is often the deciding factor. */
const AZURE_CFG = {
  base: (process.env.AZURE_OPENAI_ENDPOINT || '').replace(/\/+$/, ''),
  deployment: process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o',
  apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-10-21',
};
const COMPASS_CFG = {
  base: (process.env.COMPASS_BASE_URL || 'https://api.core42.ai').replace(/\/+$/, ''),
  deployment: process.env.COMPASS_DEPLOYMENT || 'gpt-4o',
  apiVersion: process.env.COMPASS_API_VERSION || '2023-05-15',
};

function azureStyleUrl(cfg, deploymentOverride) {
  const dep = encodeURIComponent(deploymentOverride || cfg.deployment);
  return `${cfg.base}/openai/deployments/${dep}/chat/completions?api-version=${encodeURIComponent(cfg.apiVersion)}`;
}

/** One handler for both Azure OpenAI and Compass — identical wire format. */
function azureStyleProxy(name, keyName, cfg, missingHint) {
  return async (req, res) => {
    if (!AI_KEYS[keyName]) return res.status(503).json({ error: missingHint });
    if (!cfg.base) {
      return res.status(503).json({ error: `${name} endpoint not configured on server` });
    }
    const start = Date.now();
    const action = req.get('x-ai-action') || 'unspecified';
    // The deployment name is the "model" for these providers.
    const deployment = req.body?.model || cfg.deployment;
    const body = { ...req.body };
    delete body.model;                       // Azure takes it in the URL, not the body
    try {
      const r = await fetch(azureStyleUrl(cfg, deployment), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': AI_KEYS[keyName] },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      reportTelemetry({
        model: `${keyName}:${deployment}`,
        inputTokens: data?.usage?.prompt_tokens,
        outputTokens: data?.usage?.completion_tokens,
        latencyMs: Date.now() - start,
        success: r.ok,
        errorMessage: r.ok ? undefined : (data?.error?.message || `Upstream error ${r.status}`),
        action,
      });
      res.status(r.status).json(data);
    } catch (e) {
      reportTelemetry({ model: `${keyName}:${deployment}`, latencyMs: Date.now() - start,
                        success: false, errorMessage: e.message, action });
      res.status(502).json({ error: `Upstream ${name} error: ` + e.message });
    }
  };
}

app.post('/api/ai/azure', auth, aiRateLimit,
  azureStyleProxy('Azure OpenAI', 'azure', AZURE_CFG,
    'AZURE_OPENAI_KEY / AZURE_OPENAI_ENDPOINT not configured on server'));

app.post('/api/ai/compass', auth, aiRateLimit,
  azureStyleProxy('Core42 Compass', 'compass', COMPASS_CFG,
    'COMPASS_API_KEY not configured on server'));

app.post('/api/ai/claude', auth, aiRateLimit, async (req, res) => {
  if (!AI_KEYS.anthropic) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured on server' });
  const start = Date.now();
  const action = req.get('x-ai-action') || 'unspecified';
  const model = req.body?.model;
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
    const data = await r.json();
    reportTelemetry({
      model,
      inputTokens: data?.usage?.input_tokens,
      outputTokens: data?.usage?.output_tokens,
      latencyMs: Date.now() - start,
      success: r.ok,
      errorMessage: r.ok ? undefined : (data?.error?.message || `Upstream error ${r.status}`),
      action,
    });
    res.status(r.status).json(data);
  } catch (e) {
    reportTelemetry({ model, latencyMs: Date.now() - start, success: false, errorMessage: e.message, action });
    res.status(502).json({ error: 'Upstream Anthropic error: ' + e.message });
  }
});

app.post('/api/ai/openai', auth, aiRateLimit, async (req, res) => {
  if (!AI_KEYS.openai) return res.status(503).json({ error: 'OPENAI_API_KEY not configured on server' });
  const start = Date.now();
  const action = req.get('x-ai-action') || 'unspecified';
  const model = req.body?.model;
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + AI_KEYS.openai },
      body: JSON.stringify(req.body),
    });
    const data = await r.json();
    reportTelemetry({
      model,
      inputTokens: data?.usage?.prompt_tokens,
      outputTokens: data?.usage?.completion_tokens,
      latencyMs: Date.now() - start,
      success: r.ok,
      errorMessage: r.ok ? undefined : (data?.error?.message || `Upstream error ${r.status}`),
      action,
    });
    res.status(r.status).json(data);
  } catch (e) {
    reportTelemetry({ model, latencyMs: Date.now() - start, success: false, errorMessage: e.message, action });
    res.status(502).json({ error: 'Upstream OpenAI error: ' + e.message });
  }
});

app.post('/api/ai/gemini', auth, aiRateLimit, async (req, res) => {
  if (!AI_KEYS.google) return res.status(503).json({ error: 'GOOGLE_API_KEY not configured on server' });
  const start = Date.now();
  const action = req.get('x-ai-action') || 'unspecified';
  const model = req.query.model || 'gemini-3.1-pro-preview';
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${AI_KEYS.google}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    });
    const data = await r.json();
    reportTelemetry({
      model,
      inputTokens: data?.usageMetadata?.promptTokenCount,
      outputTokens: data?.usageMetadata?.candidatesTokenCount,
      latencyMs: Date.now() - start,
      success: r.ok,
      errorMessage: r.ok ? undefined : (data?.error?.message || `Upstream error ${r.status}`),
      action,
    });
    res.status(r.status).json(data);
  } catch (e) {
    reportTelemetry({ model, latencyMs: Date.now() - start, success: false, errorMessage: e.message, action });
    res.status(502).json({ error: 'Upstream Gemini error: ' + e.message });
  }
});

/* ── API ── */
app.get('/api/health', (req, res) => res.json({
  ok: true,
  storage: usePg ? 'postgres' : 'file',
  protected: !!TEAM_CODE,
  serverKeys: {
    anthropic: !!AI_KEYS.anthropic, openai: !!AI_KEYS.openai, google: !!AI_KEYS.google,
    azure: !!(AI_KEYS.azure && AZURE_CFG.base), compass: !!AI_KEYS.compass,
  },
  providers: {
    azure:   { endpoint: AZURE_CFG.base || null, deployment: AZURE_CFG.deployment, apiVersion: AZURE_CFG.apiVersion },
    compass: { endpoint: COMPASS_CFG.base, deployment: COMPASS_CFG.deployment, apiVersion: COMPASS_CFG.apiVersion },
  },
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
app.use(express.static(__dirname, {
  index: 'index.html',
  setHeaders: (res, filePath) => {
    // Always revalidate the page itself so redeploys reach phones immediately
    // (304 responses keep it fast when nothing changed).
    if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

initStorage()
  .then(() => app.listen(PORT, () => console.log('TalentScope running on port ' + PORT)))
  .catch(err => { console.error('Startup failed:', err); process.exit(1); });
