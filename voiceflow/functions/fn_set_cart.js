// ⚠ PASTE-READY BODY ONLY. The Voiceflow function creator already
// supplies:  export default async function main(args) { ... }
// Paste everything below BETWEEN its braces. Do NOT add
// `export default`, an outer function, or `module.exports`.

// Voiceflow Function: fn_set_cart  (tool: set_cart)
// Replace the ENTIRE cart with exactly `items` (items:[] clears it).
// Inputs: items (tool arg; array or JSON string) | fv_tenant_id, user_id,
//   + secrets SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SHOPIFY_STORE_DOMAIN.
// Output var: tool_result.
  const env = args;
  const tenant_id = args.fv_tenant_id;
  const contact_id = args.user_id;
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

  // Voiceflow may pass complex tool args as a JSON string — normalise.
  let items = args.items;
  if (typeof items === 'string') { try { items = JSON.parse(items); } catch (_e) { items = []; } }
  if (!Array.isArray(items)) items = [];

  const lines = {};
  for (const it of items) {
    const vid = String((it && it.shopify_variant_id) || '').replace(/[^0-9]/g, '');
    const q = Math.max(0, Math.min(24, parseInt(it && it.quantity, 10) || 0));
    if (vid && q > 0) lines[vid] = q;
  }
  const entries = Object.keys(lines).filter((k) => lines[k] > 0);
  const spec = entries.map((k) => `${k}:${lines[k]}`).join(',');
  const checkout_url = spec ? `https://${env.SHOPIFY_STORE_DOMAIN}/cart/${spec}?storefront=true` : null;
  await http({
    method: 'POST',
    url: `${env.SUPABASE_URL}/rest/v1/customer_carts?on_conflict=tenant_id,contact_id`,
    headers: { ...sb, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: { tenant_id, contact_id, cart_id: spec, checkout_url, updated_at: new Date().toISOString() },
  });
  const result = !entries.length
    ? { cleared: true, checkout_url: null, via: 'cleared' }
    : { cart: entries.map((k) => ({ variant_id: k, quantity: lines[k] })), checkout_url, via: 'permalink' };
  return { outputVars: { tool_result: JSON.stringify(result) } };
