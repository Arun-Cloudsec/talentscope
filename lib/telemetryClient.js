/* telemetryClient.js — drop this file into any agent's lib/ folder to report
   usage to the Fleet Control Plane. Reporting is entirely best-effort: it
   never throws, never blocks the caller beyond a short timeout, and is a
   total no-op if CONTROL_PLANE_URL isn't set. See the control plane's
   README for the full integration guide. */

const CONTROL_PLANE_URL = process.env.CONTROL_PLANE_URL || '';
const AGENT_NAME = process.env.AGENT_NAME || 'unnamed-agent';
const AGENT_UNIT = process.env.AGENT_UNIT || 'HR';

async function reportTelemetry({ model, inputTokens, outputTokens, latencyMs, success, errorMessage, quality, action }) {
  if (!CONTROL_PLANE_URL) return; // instrumentation is opt-in
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    await fetch(CONTROL_PLANE_URL.replace(/\/$/, '') + '/api/telemetry/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentName: AGENT_NAME, unit: AGENT_UNIT, model,
        inputTokens: inputTokens || 0, outputTokens: outputTokens || 0,
        latencyMs: latencyMs || 0, success: !!success,
        errorMessage: errorMessage ? String(errorMessage).slice(0, 300) : undefined,
        quality: quality || undefined, action: action || undefined,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
  } catch (e) {
    // best-effort only — telemetry failures must never affect the agent itself
  }
}

/* Optional: ask the control plane whether this call should proceed given
   current budget. Fails OPEN (returns allow:true) if the control plane is
   unreachable or not configured, so an agent never breaks because of it. */
async function checkBudgetGate(estimatedCostUsd = 0) {
  if (!CONTROL_PLANE_URL) return { allow: true, reason: 'control plane not configured' };
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const resp = await fetch(CONTROL_PLANE_URL.replace(/\/$/, '') + '/api/gate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentName: AGENT_NAME, estimatedCostUsd }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) return { allow: true, reason: 'gate check failed, failing open' };
    return await resp.json();
  } catch (e) {
    return { allow: true, reason: 'gate unreachable, failing open' };
  }
}

module.exports = { reportTelemetry, checkBudgetGate, AGENT_NAME, AGENT_UNIT };
