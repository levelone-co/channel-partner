// ⚠ PASTE-READY BODY ONLY. The Voiceflow function creator already
// supplies:  export default async function main(args) { ... }
// Paste everything below BETWEEN its braces. Do NOT add
// `export default`, an outer function, or `module.exports`.

// Voiceflow Function: fn_check_stock  (tool: check_stock)
// Inputs: shopify_variant_id (tool arg) | fv_tenant_id, + secrets
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Output var: tool_result.
  const SUPABASE_URL = args.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = args.SUPABASE_SERVICE_ROLE_KEY;
  const env = { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY };
  const tenant_id = args.fv_tenant_id;
  const http = async ({ method = 'GET', url, headers = {}, body }) => {
    try {
      const init = { method, headers: { ...headers } };
      if (body !== undefined) {
        init.headers['Content-Type'] = init.headers['Content-Type'] || 'application/json';
        init.body = typeof body === 'string' ? body : JSON.stringify(body);
      }
      const res = await fetch(url, init);
      const txt = await res.text();
      let b; try { b = txt ? JSON.parse(txt) : null; } catch (_e) { b = txt; }
      return { ok: res.status < 400, status: res.status, body: b };
    } catch (e) {
      return { ok: false, status: 0, body: { __error: { url, message: e && e.message } } };
    }
  };
  const sb = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` };

  const r = await http({
    url: `${env.SUPABASE_URL}/rest/v1/wines?tenant_id=eq.${encodeURIComponent(tenant_id)}` +
      `&shopify_variant_id=eq.${encodeURIComponent(args.shopify_variant_id)}` +
      `&select=title,vintage,inventory_available`,
    headers: sb,
  });
  const row = Array.isArray(r.body) && r.body[0];
  const result = !row
    ? { available: true, note: 'not in catalogue cache; checkout will confirm' }
    : { available: !!row.inventory_available, wine: `${row.title || ''} ${row.vintage || ''}`.trim() };
  return { tool_result: JSON.stringify(result) };
