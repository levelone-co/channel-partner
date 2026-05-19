// Voiceflow Function: fn_add_to_cart  (tool: add_to_cart)
// Inputs: shopify_variant_id, quantity (tool args) | fv_tenant_id, user_id,
//   + secrets SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SHOPIFY_STORE_DOMAIN.
// Output var: tool_result. Cart = zero-auth Shopify permalink; lines persist
// per (tenant_id, contact_id) in customer_carts.
export default async function main(args) {
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

  const readCartLines = async () => {
    const r = await http({
      url: `${env.SUPABASE_URL}/rest/v1/customer_carts?tenant_id=eq.${encodeURIComponent(tenant_id)}` +
        `&contact_id=eq.${encodeURIComponent(contact_id)}&select=cart_id`,
      headers: sb,
    });
    const prev = (Array.isArray(r.body) && r.body[0] && r.body[0].cart_id) || '';
    const lines = {};
    for (const part of String(prev).split(',')) {
      const m = part.match(/^(\d+):(\d+)$/);
      if (m) lines[m[1]] = (lines[m[1]] || 0) + parseInt(m[2], 10);
    }
    return lines;
  };
  const commitCart = async (lines) => {
    const entries = Object.keys(lines).filter((k) => lines[k] > 0);
    const spec = entries.map((k) => `${k}:${lines[k]}`).join(',');
    const checkout_url = spec ? `https://${env.SHOPIFY_STORE_DOMAIN}/cart/${spec}?storefront=true` : null;
    await http({
      method: 'POST',
      url: `${env.SUPABASE_URL}/rest/v1/customer_carts?on_conflict=tenant_id,contact_id`,
      headers: { ...sb, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: { tenant_id, contact_id, cart_id: spec, checkout_url, updated_at: new Date().toISOString() },
    });
    if (!entries.length) return { cleared: true, checkout_url: null, via: 'cleared' };
    return { cart: entries.map((k) => ({ variant_id: k, quantity: lines[k] })), checkout_url, via: 'permalink' };
  };

  const qty = Math.max(1, Math.min(24, parseInt(args.quantity, 10) || 1));
  const vid = String(args.shopify_variant_id).replace(/[^0-9]/g, '');
  let result;
  if (!vid) {
    result = { error: 'invalid variant id' };
  } else {
    const lines = await readCartLines();
    lines[vid] = (lines[vid] || 0) + qty;
    result = await commitCart(lines);
  }
  return { outputVars: { tool_result: JSON.stringify(result) } };
}
