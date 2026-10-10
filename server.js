import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 4173);
const API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.OPENROUTER_MODEL || 'openrouter/free';
const MAX_BODY = 16_000;
const WINDOW_MS = 10 * 60 * 1000;
const MAX_RUNS_PER_WINDOW = 5;
const requestsByIp = new Map();
let healthCache = { checkedAt: 0, result: null };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8'
};

function sendJson(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(obj));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > MAX_BODY) {
        reject(Object.assign(new Error('Request too large'), { status: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch { reject(Object.assign(new Error('Invalid JSON body'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function ipKey(req) {
  // Render terminates TLS and forwards requests. Use the last forwarded IP only for a coarse demo throttle.
  const raw = req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  return raw.slice(0, 80);
}

function rateAllowed(ip) {
  const now = Date.now();
  const recent = (requestsByIp.get(ip) || []).filter(t => now - t < WINDOW_MS);
  if (recent.length >= MAX_RUNS_PER_WINDOW) {
    requestsByIp.set(ip, recent);
    return false;
  }
  recent.push(now);
  requestsByIp.set(ip, recent);
  if (requestsByIp.size > 2000) {
    for (const [key, list] of requestsByIp) {
      const live = list.filter(t => now - t < WINDOW_MS);
      if (live.length) requestsByIp.set(key, live); else requestsByIp.delete(key);
    }
  }
  return true;
}

function writeSse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function extractJson(content) {
  if (typeof content !== 'string') throw new Error('The AI provider returned an empty response.');
  const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first >= 0 && last > first) return JSON.parse(cleaned.slice(first, last + 1));
  throw new Error('The selected model did not return a readable structured response.');
}

async function callModel(system, user, signal) {
  if (!API_KEY) throw Object.assign(new Error('The backend is missing OPENROUTER_API_KEY. Add it in the hosting provider’s environment settings.'), { code: 'MISSING_KEY' });
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.APP_PUBLIC_URL || 'https://mechpilot.local',
      'X-Title': 'MechPilot Engineering Copilot'
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.2,
      max_tokens: 1500,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    }),
    signal
  });
  if (!response.ok) {
    const status = response.status;
    // Do not include upstream body: some providers may echo request details.
    const safeMessage = status === 401 ? 'The backend API key was rejected. Replace it in the hosting environment.' :
      status === 402 ? 'The provider reports insufficient credits or quota. Check OpenRouter account limits.' :
      status === 429 ? 'The free model is rate-limited or busy. Wait briefly and try again.' :
      status >= 500 ? 'The AI provider is temporarily unavailable. Try again shortly.' :
      `The AI provider returned HTTP ${status}. Check the configured model and account.`;
    throw Object.assign(new Error(safeMessage), { code: 'PROVIDER_ERROR', status });
  }
  const payload = await response.json();
  return extractJson(payload?.choices?.[0]?.message?.content);
}

const COMMON = `You are a specialist agent inside MechPilot, a mechanical engineering decision-support application.
Analyze only the provided case and clearly distinguish user-reported facts, plausible hypotheses, and unknowns.
Do not invent measurements, machine details, standards, citations, repair costs, failure probabilities, or savings.
When information is insufficient, say so and request the most useful missing data.
Prioritize safety: do not advise inspecting machinery while moving, energized, hot, or pressurized. Mention appropriate shutdown, isolation/lockout-tagout and qualified personnel where relevant. Never declare machinery safe based only on chat text.
Return valid JSON only. Keep responses concise, technical, practical, and tied to this particular case.`;

async function runAnalysis(input, onStage) {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 52_000);
  const caseText = `Equipment: ${input.asset}\nCriticality: ${input.criticality}\nObjective: ${input.objective}\nObserved symptoms / context:\n${input.symptoms}`;
  const stages = [];
  try {
    onStage({ index: 0, status: 'active', title: 'Fault diagnosis', detail: 'Separating reported facts from possible causes' });
    const diagnosis = await callModel(
      COMMON + `\nROLE: FAULT DIAGNOSIS AGENT.
Return JSON: {"summary":"case-specific synthesis","observed_facts":["..."],"hypotheses":[{"cause":"...","likelihood":"Low/Medium/High qualitative only","evidence_for":"...","evidence_against_or_alternative":"...","test_to_discriminate":"..."}],"missing_information":["..."],"next_questions":["..."],"risk_flags":["..."]}.
Give 2-4 differentiated hypotheses ranked by evidence, not by generic keyword match. Explicitly note the difference between evidence and speculation.`,
      caseText, abort.signal
    );
    stages.push({ id:'diagnosis', name:'Fault diagnosis', ...diagnosis });
    onStage({ index: 0, status: 'done', title: 'Fault diagnosis', detail: 'Hypotheses and discriminating tests prepared' });

    onStage({ index: 1, status: 'active', title: 'Maintenance planner', detail: 'Building a plan from diagnosis findings' });
    const maintenance = await callModel(
      COMMON + `\nROLE: MAINTENANCE PLANNING AGENT.
You MUST use the actual case and the diagnosis below. Do not restart with generic maintenance advice; each step should test or address a named hypothesis, and must state prerequisites.
Return JSON: {"summary":"...","steps":[{"priority":"Now/Soon/After confirmation","action":"...","reason_linked_to_diagnosis":"...","prerequisites_and_safety":"...","expected_observation":"..."}],"do_not_do":["..."]}.`,
      `${caseText}\n\nDiagnosis agent findings:\n${JSON.stringify(diagnosis)}`, abort.signal
    );
    stages.push({ id:'maintenance', name:'Maintenance planner', ...maintenance });
    onStage({ index: 1, status: 'done', title: 'Maintenance planner', detail: 'Ordered actions tied to candidate causes' });

    onStage({ index: 2, status: 'active', title: 'Efficiency optimizer', detail: 'Finding measurable, defensible improvements' });
    const efficiency = await callModel(
      COMMON + `\nROLE: EFFICIENCY & COST OPTIMIZATION AGENT.
Use the case, diagnosis and maintenance plan. Suggest only plausible improvements relevant to the specific equipment and failure mode. Never make up percentage savings or cost estimates; instead state what to measure and compare.
Return JSON: {"summary":"...","opportunities":[{"recommendation":"...","why_it_fits_this_case":"...","metric_to_track":"...","tradeoff_or_validation_needed":"..."}],"baseline_data_to_collect":["..."]}. Include at least one meaningful validation metric.`,
      `${caseText}\n\nDiagnosis findings:\n${JSON.stringify(diagnosis)}\n\nMaintenance plan:\n${JSON.stringify(maintenance)}`, abort.signal
    );
    stages.push({ id:'efficiency', name:'Efficiency optimizer', ...efficiency });
    onStage({ index: 2, status: 'done', title: 'Efficiency optimizer', detail: 'Recommendations include measurement criteria' });

    onStage({ index: 3, status: 'active', title: 'Safety & quality reviewer', detail: 'Reviewing the entire proposed plan' });
    const safety = await callModel(
      COMMON + `\nROLE: INDEPENDENT SAFETY & QUALITY REVIEWER.
Review the user-reported case and all prior outputs. You may reject, reorder or narrow unsafe/unsubstantiated actions. Flag missing safeguards. The reviewer is an advisory gate, not a certification. Be conservative where the facts imply severe risk.
Return JSON: {"risk_level":"Low/Moderate/High/Critical","decision":"Proceed with precautions / Hold for more information / Stop and escalate","reasoning":"...","critical_concerns":[{"concern":"...","required_control":"...","stop_condition":"..."}],"quality_checks":["..."],"safe_next_step":"..."}.
A user saying they want production restored never overrides safety.`,
      `${caseText}\n\nDiagnosis:\n${JSON.stringify(diagnosis)}\n\nMaintenance plan:\n${JSON.stringify(maintenance)}\n\nEfficiency suggestions:\n${JSON.stringify(efficiency)}`, abort.signal
    );
    stages.push({ id:'safety', name:'Safety & quality reviewer', ...safety });
    onStage({ index: 3, status: 'done', title: 'Safety & quality reviewer', detail: 'Safety gate completed' });

    return {
      id: `MP-${Date.now().toString(36).toUpperCase()}`,
      createdAt: new Date().toISOString(),
      mode: 'live-multi-agent',
      model: MODEL,
      input,
      stages,
      final: {
        summary: diagnosis.summary || 'See specialist findings below.',
        riskLevel: safety.risk_level || 'Requires review',
        decision: safety.decision || 'Hold for qualified review',
        safeNextStep: safety.safe_next_step || '',
        missingInformation: diagnosis.missing_information || [],
        followUpQuestions: diagnosis.next_questions || [],
        limitations: [
          'AI-generated engineering decision support; hypotheses are not confirmed faults.',
          'No live telemetry, physical inspection or manufacturer manual was accessed unless explicitly provided.',
          'Safety review does not certify equipment as safe. Follow local procedures and qualified engineering judgement.'
        ]
      }
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function serveStatic(req, res, pathname) {
  const urlPath = pathname === '/' ? '/index.html' : pathname;
  const resolved = path.resolve(PUBLIC, '.' + decodeURIComponent(urlPath));
  if (!resolved.startsWith(PUBLIC + path.sep) && resolved !== path.join(PUBLIC, 'index.html')) {
    sendJson(res, 403, { error: 'Forbidden' }); return;
  }
  try {
    const info = await stat(resolved);
    if (!info.isFile()) throw new Error('Not a file');
    const bytes = await readFile(resolved);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(resolved)] || 'application/octet-stream',
      'Cache-Control': path.extname(resolved) === '.html' ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Frame-Options': 'DENY'
    });
    res.end(bytes);
  } catch {
    sendJson(res, 404, { error: 'Not found' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/api/health') {
    let check = healthCache.result;
    if (Date.now() - healthCache.checkedAt > 60_000 || !check) {
      if (!API_KEY) {
        check = { configured: false, valid: false, message: 'Backend needs OPENROUTER_API_KEY' };
      } else {
        try {
          // OpenRouter's current-key endpoint verifies the secret without exposing it to the browser.
          const verify = await fetch('https://openrouter.ai/api/v1/key', {
            headers: { 'Authorization': `Bearer ${API_KEY}` },
            signal: AbortSignal.timeout(7000)
          });
          if (verify.ok) {
            const info = await verify.json();
            check = {
              configured: true,
              valid: true,
              message: 'Backend key verified',
              freeTier: Boolean(info?.data?.is_free_tier),
              limitRemaining: typeof info?.data?.limit_remaining === 'number' ? info.data.limit_remaining : null
            };
          } else if (verify.status === 401 || verify.status === 403) {
            check = { configured: true, valid: false, message: 'API key was rejected by OpenRouter' };
          } else {
            check = { configured: true, valid: null, message: 'Could not verify the key right now' };
          }
        } catch {
          check = { configured: true, valid: null, message: 'OpenRouter verification temporarily unavailable' };
        }
      }
      healthCache = { checkedAt: Date.now(), result: check };
    }
    sendJson(res, 200, {
      ok: true,
      ...check,
      provider: 'OpenRouter',
      model: MODEL,
      mode: 'live-multi-agent'
    });
    return;
  }
  if (url.pathname === '/api/analyze' && req.method === 'POST') {
    if (!API_KEY) { sendJson(res, 503, { error: 'The backend is not configured yet. Add OPENROUTER_API_KEY to the server environment.' }); return; }
    if (!rateAllowed(ipKey(req))) { sendJson(res, 429, { error: 'Demo rate limit reached for this network. Please wait up to 10 minutes before trying again.' }); return; }
    let body;
    try { body = await readJson(req); }
    catch (err) { sendJson(res, err.status || 400, { error: err.message || 'Invalid request' }); return; }
    const input = {
      asset: String(body.asset || '').slice(0, 150),
      criticality: String(body.criticality || 'medium').slice(0, 30),
      objective: String(body.objective || '').slice(0, 300),
      symptoms: String(body.symptoms || '').trim().slice(0, 6000)
    };
    if (!input.asset || !input.symptoms || input.symptoms.length < 12) {
      sendJson(res, 400, { error: 'Add equipment details and at least a short description of the symptoms.' }); return;
    }
    if (!['low','medium','high'].includes(input.criticality)) input.criticality = 'medium';
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff'
    });
    res.flushHeaders?.();
    writeSse(res, 'status', { message: 'Connected to the MechPilot backend.' });
    const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': keepalive\n\n'); }, 12000);
    try {
      const report = await runAnalysis(input, stage => {
        if (!res.writableEnded) writeSse(res, 'stage', stage);
      });
      if (!res.writableEnded) writeSse(res, 'complete', report);
    } catch (err) {
      let message = err.name === 'AbortError' ? 'The AI run timed out. Try again or shorten the case description.' : (err.message || 'Analysis failed.');
      if (err.code === 'MISSING_KEY') message = err.message;
      if (!res.writableEnded) writeSse(res, 'failure', { message });
    } finally {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    }
    return;
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    await serveStatic(req, res, url.pathname);
    return;
  }
  sendJson(res, 405, { error: 'Method not allowed' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`MechPilot listening on port ${PORT}`);
});
