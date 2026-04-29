// Cron Worker — runs scheduled tasks for patrouch.ca
// Replaces OpenClaw crons so game is independent of local machine

const BASE = 'https://patrouch.ca';
const LOG_TTL = 86400 * 7; // 7 days

export default {
  async scheduled(event, env, ctx) {
    const CRON_SECRET = await env.CRON_SECRET?.get?.() ?? null;
    const AUTH = CRON_SECRET ? `Bearer ${CRON_SECRET}` : null;

    switch (event.cron) {
      case '0 15 * * 1':
        // Sundays 3PM CST — Sappho writes + weekly email
        await logAndRun(env, 'sappho', '/api/sappho/write', 'POST', AUTH);
        await logAndRun(env, 'weekly-email', '/api/newsletter/send-weekly', 'POST', AUTH);
        break;
      case '0 2,8,14,20 * * *':
        // 4x daily — Narrator events
        await logAndRun(env, 'narrator', '/api/narrator', 'POST', AUTH);
        break;
      case '0 */6 * * *':
        // Every 6 hours — Booty Bots AI + Drift simulation
        await logAndRun(env, 'bot-ai', '/api/bottlequest/bot-ai-cron', 'POST', AUTH);
        await logAndRun(env, 'drift', '/api/bottlequest/drift/simulate', 'POST', AUTH);
        break;
      case '0 3 * * *':
        // Daily 3AM UTC — Search index rebuild
        await logAndRun(env, 'search-reindex', '/api/search/index', 'POST', AUTH);
        break;
      default:
        console.log(`No task matching cron: ${event.cron}`);
    }
  },

  // Manual trigger via fetch (for testing)
  async fetch(request, env) {
    const url = new URL(request.url);

    // Status endpoint
    if (url.pathname === '/status') {
      const secret = url.searchParams.get('secret');
      const statusSecret = (await env.STATUS_SECRET?.get?.()) || CRON_SECRET;
      if (!statusSecret || secret !== statusSecret) {
        return new Response('Forbidden', { status: 403 });
      }
      return statusEndpoint(env);
    }

    const task = url.searchParams.get('task');
    const secret = url.searchParams.get('secret');
    const AUTH = CRON_SECRET ? `Bearer ${CRON_SECRET}` : null;

    if (!task || !CRON_SECRET || secret !== CRON_SECRET) {
      return new Response('Forbidden', { status: 403 });
    }

    const tasks = {
      'sappho': '/api/sappho/write',
      'weekly-email': '/api/newsletter/send-weekly',
      'narrator': '/api/narrator',
      'bot-ai': '/api/bottlequest/bot-ai-cron',
      'search-reindex': '/api/search/index',
      'drift': '/api/bottlequest/drift/simulate'
    };

    const path = tasks[task];
    if (!path) return new Response(`Unknown task: ${task}`, { status: 400 });

    const result = await runTask(task, path, 'POST', AUTH);
    await saveLog(env, result);
    return new Response(JSON.stringify(result, null, 2), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

async function logAndRun(env, name, path, method, auth) {
  const result = await runTask(name, path, method, auth);
  await saveLog(env, result);
  return result;
}

async function saveLog(env, result) {
  if (!env.CRON_LOGS) return;
  const now = new Date();
  const dateKey = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const key = `cron_logs/${dateKey}/${result.task}`;
  const entry = {
    task: result.task,
    status: result.ok ? 'ok' : 'error',
    message: result.error || `HTTP ${result.status}`,
    detail: result.detail || null,
    duration_ms: result.ms,
    timestamp: now.toISOString()
  };
  await env.CRON_LOGS.put(key, JSON.stringify(entry), { expirationTtl: LOG_TTL });
}

async function statusEndpoint(env) {
  if (!env.CRON_LOGS) {
    return new Response(JSON.stringify({ error: 'CRON_LOGS KV not bound' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }

  const now = new Date();
  const cutoff = new Date(now.getTime() - 48 * 3600 * 1000);
  const logs = [];

  // List keys with prefix for last 2 days
  const today = now.toISOString().slice(0, 10);
  const yesterday = new Date(cutoff).toISOString().slice(0, 10);

  for (const dateKey of [today, yesterday]) {
    const prefix = `cron_logs/${dateKey}/`;
    const list = await env.CRON_LOGS.list({ prefix });
    for (const key of list.keys) {
      const val = await env.CRON_LOGS.get(key.name);
      if (val) logs.push(JSON.parse(val));
    }
  }

  // Sort by timestamp desc
  logs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  // Summary
  const ok = logs.filter(l => l.status === 'ok').length;
  const errors = logs.filter(l => l.status === 'error').length;

  const summary = {
    period: `${today} to present`,
    total: logs.length,
    ok,
    errors,
    logs
  };

  return new Response(JSON.stringify(summary, null, 2), {
    headers: { 'Content-Type': 'application/json' }
  });
}

async function runTask(name, path, method, auth, customBase) {
  const start = Date.now();
  console.log(`[CRON] Starting: ${name}`);
  try {
    const url = path.startsWith('http') ? path : `${customBase || BASE}${path}`;
    const resp = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(auth ? { Authorization: auth } : {})
      }
    });
    console.log(`[CRON] ${name}: ${resp.status} (${Date.now() - start}ms)`);
    let detail = null;
    try {
      const body = await resp.text();
      try { detail = JSON.parse(body); } catch { detail = body.slice(0, 300); }
    } catch {}
    return { task: name, status: resp.status, ok: resp.ok, ms: Date.now() - start, detail };
  } catch (e) {
    console.error(`[CRON] ${name} FAILED: ${e.message}`);
    return { task: name, error: e.message, ok: false, ms: Date.now() - start };
  }
}
