/**
 * Shared HTTP primitive for the Voiceflow Functions — fetch-based port of
 * the n8n `http()` in workflows/sarah-agent-loop.js.
 *
 * Voiceflow Functions DO provide a global `fetch` (unlike the n8n task
 * runner). Paste this helper at the top of EACH Function that needs it
 * (VF Functions don't share modules) — or inline it. Never throws; returns
 * { ok, status, body } so a tool failure degrades gracefully.
 *
 * Secrets come from the VF function args/secrets, NOT $vars. Pass an `env`
 * object into each handler: { ANTHROPIC_API_KEY, SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY, VOYAGE_API_KEY, SHOPIFY_STORE_DOMAIN,
 * GHL_API_TOKEN, TAVILY_API_KEY }.
 */
async function http({ method = 'GET', url, headers = {}, body }) {
  try {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) {
      init.headers['Content-Type'] =
        init.headers['Content-Type'] || 'application/json';
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const res = await fetch(url, init);
    let parsed;
    const txt = await res.text();
    try { parsed = txt ? JSON.parse(txt) : null; } catch (_e) { parsed = txt; }
    return { ok: res.status < 400, status: res.status, body: parsed };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      body: { __error: { url, message: e && e.message, name: e && e.name } },
    };
  }
}

function sbHeaders(env) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  };
}

module.exports = { http, sbHeaders };
