// Cron Worker — runs scheduled tasks for patrouch.ca
// Replaces OpenClaw crons so game is independent of local machine

const BASE = 'https://patrouch.ca';

export default {
  async scheduled(event, env, ctx) {
    const AUTH = env.CRON_SECRET ? `Bearer ${env.CRON_SECRET}` : null;

    switch (event.cron) {
      case '0 15 * * 1':
        // Sundays 333PM CST — Sappho writes
        await runTask('sappho', '/api/sappho/write', 'POST', AUTH);
        break;
      case '0 2,8,14,20 * * *':
        // 4x daily — Narrator events
        await runTask('narrator', '/api/narrator', 'POST', AUTH);
        break;
      case '0 */6 * * *':
        // Every 6 hours — Booty Bots AI decisions
        await runTask('bot-ai', '/api/bottlequest/bot-ai-cron', 'POST', AUTH);
        break;
      case '0 3 * * *':
        // Daily 3AM UTC — Search index rebuild
        await runTask('search-reindex', '/api/search/index', 'POST', AUTH);
        break;
      default:
        console.log(`No task matching cron: ${event.cron}`);
    }
  },

  // Manual trigger via fetch (for testing)
  async fetch(request, env) {
    const url = new URL(request.url);
    const task = url.searchParams.get('task');
    const secret = url.searchParams.get('secret');
    const AUTH = env.CRON_SECRET ? `Bearer ${env.CRON_SECRET}` : null;

    if (!task || !env.CRON_SECRET || secret !== env.CRON_SECRET) {
      return new Response('Forbidden', { status: 403 });
    }

    const tasks = {
      'sappho': '/api/sappho/write',
      'narrator': '/api/narrator',
      'bot-ai': '/api/bottlequest/bot-ai-cron',
      'search-reindex': '/api/search/index'
    };

    const path = tasks[task];
    if (!path) return new Response(`Unknown task: ${task}`, { status: 400 });

    const result = await runTask(task, path, 'POST', AUTH);
    return new Response(JSON.stringify(result, null, 2), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

async function runTask(name, path, method, auth) {
  const start = Date.now();
  console.log(`[CRON] Starting: ${name}`);
  try {
    const resp = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(auth ? { Authorization: auth } : {})
      }
    });
    console.log(`[CRON] ${name}: ${resp.status} (${Date.now() - start}ms)`);
    return { task: name, status: resp.status, ok: resp.ok, ms: Date.now() - start };
  } catch (e) {
    console.error(`[CRON] ${name} FAILED: ${e.message}`);
    return { task: name, error: e.message, ok: false, ms: Date.now() - start };
  }
}
