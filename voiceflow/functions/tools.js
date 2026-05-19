/**
 * VF tool handlers — one per tool in tools/account-tools.json. Register each
 * on the Agent step (schemas: copy verbatim from tools/account-tools.json)
 * and wire fulfilment to the matching handler. Split into 8 separate VF
 * Functions in the studio; this file is the single source of truth.
 *
 * 5 are 1:1 ports of workflows/sarah-agent-loop.js; 3 consult_* are built
 * from STEP3_N8N_CHANGES.md §3.5 (the JS loop never implemented them).
 *
 * Each handler signature: (input, ctx) where
 *   ctx = { env, tenant_id, contact_id, tenant_slug }
 * Paste _http.js (http, sbHeaders) at the top of each VF Function.
 */
const SHOP_PERMALINK = (shop, spec) =>
  spec ? `https://${shop}/cart/${spec}?storefront=true` : null;

const FIELD_ID = {
  whatsapp_preferred: 'cZnCWMR3VsZW0YXXcxGL',
  return_channels_captured_at: 'kE3148Mfthnf3UHEPb4N',
};

// ---- ports of sarah-agent-loop.js ---------------------------------------

async function search_wines({ query }, ctx) {
  const { env, tenant_id } = ctx;
  const emb = await http({
    method: 'POST',
    url: 'https://api.voyageai.com/v1/embeddings',
    headers: { Authorization: `Bearer ${env.VOYAGE_API_KEY}` },
    body: { model: 'voyage-4-lite', input: [query], input_type: 'query', output_dimension: 512 },
  });
  const vector = emb.body && emb.body.data && emb.body.data[0] && emb.body.data[0].embedding;
  if (!vector) return { error: 'embedding failed', detail: emb.body };
  const r = await http({
    method: 'POST',
    url: `${env.SUPABASE_URL}/rest/v1/rpc/search_wines`,
    headers: sbHeaders(env),
    body: { p_tenant_id: tenant_id, p_query_embedding: vector, p_match_count: 3 },
  });
  return r.ok ? { wines: r.body } : { error: 'search failed', detail: r.body };
}

async function check_stock({ shopify_variant_id }, ctx) {
  const { env, tenant_id } = ctx;
  const r = await http({
    url: `${env.SUPABASE_URL}/rest/v1/wines?tenant_id=eq.${encodeURIComponent(tenant_id)}` +
      `&shopify_variant_id=eq.${encodeURIComponent(shopify_variant_id)}` +
      `&select=title,vintage,inventory_available`,
    headers: sbHeaders(env),
  });
  const row = Array.isArray(r.body) && r.body[0];
  if (!row) return { available: true, note: 'not in catalogue cache; checkout will confirm' };
  return { available: !!row.inventory_available, wine: `${row.title || ''} ${row.vintage || ''}`.trim() };
}

async function readCartLines(ctx) {
  const { env, tenant_id, contact_id } = ctx;
  const r = await http({
    url: `${env.SUPABASE_URL}/rest/v1/customer_carts?tenant_id=eq.${encodeURIComponent(tenant_id)}` +
      `&contact_id=eq.${encodeURIComponent(contact_id)}&select=cart_id`,
    headers: sbHeaders(env),
  });
  const prev = (Array.isArray(r.body) && r.body[0] && r.body[0].cart_id) || '';
  const lines = {};
  for (const part of String(prev).split(',')) {
    const m = part.match(/^(\d+):(\d+)$/);
    if (m) lines[m[1]] = (lines[m[1]] || 0) + parseInt(m[2], 10);
  }
  return lines;
}

async function persistCart(lines, ctx) {
  const { env, tenant_id, contact_id } = ctx;
  const entries = Object.keys(lines).filter((k) => lines[k] > 0);
  const spec = entries.map((k) => `${k}:${lines[k]}`).join(',');
  const checkout_url = SHOP_PERMALINK(env.SHOPIFY_STORE_DOMAIN, spec);
  await http({
    method: 'POST',
    url: `${env.SUPABASE_URL}/rest/v1/customer_carts?on_conflict=tenant_id,contact_id`,
    headers: { ...sbHeaders(env), Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: { tenant_id, contact_id, cart_id: spec, checkout_url, updated_at: new Date().toISOString() },
  });
  return { cart: entries.map((k) => ({ variant_id: k, quantity: lines[k] })), checkout_url };
}

async function commitCart(lines, ctx) {
  const base = await persistCart(lines, ctx);
  const entries = Object.keys(lines).filter((k) => lines[k] > 0);
  if (!entries.length) return { cleared: true, checkout_url: null, via: 'cleared' };
  return { cart: base.cart, checkout_url: base.checkout_url, via: 'permalink' };
}

async function add_to_cart({ shopify_variant_id, quantity }, ctx) {
  const qty = Math.max(1, Math.min(24, parseInt(quantity, 10) || 1));
  const vid = String(shopify_variant_id).replace(/[^0-9]/g, '');
  if (!vid) return { error: 'invalid variant id' };
  const lines = await readCartLines(ctx);
  lines[vid] = (lines[vid] || 0) + qty;
  return commitCart(lines, ctx);
}

async function set_cart({ items }, ctx) {
  const lines = {};
  for (const it of items || []) {
    const vid = String(it.shopify_variant_id || '').replace(/[^0-9]/g, '');
    const q = Math.max(0, Math.min(24, parseInt(it.quantity, 10) || 0));
    if (vid && q > 0) lines[vid] = q;
  }
  return commitCart(lines, ctx);
}

async function capture_return_channels(args, ctx) {
  const { env, contact_id } = ctx;
  const customFields = [];
  if (args.whatsapp) customFields.push({ id: FIELD_ID.whatsapp_preferred, value: 'Yes' });
  customFields.push({ id: FIELD_ID.return_channels_captured_at, value: new Date().toISOString().slice(0, 10) });
  await http({
    method: 'PUT',
    url: `https://services.leadconnectorhq.com/contacts/${contact_id}`,
    headers: { Authorization: `Bearer ${env.GHL_API_TOKEN}`, Version: '2021-07-28' },
    body: {
      firstName: args.first_name || undefined,
      lastName: args.last_name || undefined,
      phone: args.phone || args.whatsapp || undefined,
      email: args.email || undefined,
      customFields,
    },
  });
  return { captured: true };
}

// ---- consult_* (STEP3_N8N_CHANGES.md §3.5) ------------------------------

async function consult_web({ query }, ctx) {
  const { env } = ctx;
  if (!env.TAVILY_API_KEY) {
    // No key configured — degrade gracefully so the agent keeps selling
    // instead of erroring. (Eval report should footnote consult_web as
    // "not exercised — no Tavily key".)
    return { unavailable: true, note: 'web search not configured; answer from catalogue/knowledge instead' };
  }
  const r = await http({
    method: 'POST',
    url: 'https://api.tavily.com/search',
    headers: { 'Content-Type': 'application/json' },
    body: { api_key: env.TAVILY_API_KEY, query, max_results: 3, include_answer: 'basic' },
  });
  if (!r.ok) return { error: 'web search failed', detail: r.body };
  const b = r.body || {};
  return {
    answer: b.answer || null,
    results: (b.results || []).slice(0, 3).map((x) => ({ title: x.title, url: x.url, content: x.content })),
  };
}

async function consult_knowledge_base({ query }, ctx) {
  const { env, tenant_id } = ctx;
  const emb = await http({
    method: 'POST',
    url: 'https://api.voyageai.com/v1/embeddings',
    headers: { Authorization: `Bearer ${env.VOYAGE_API_KEY}` },
    body: { model: 'voyage-4-lite', input: [query], input_type: 'query', output_dimension: 512 },
  });
  const vec = emb.body && emb.body.data && emb.body.data[0] && emb.body.data[0].embedding;
  if (!vec) return { error: 'embedding failed' };
  const r = await http({
    method: 'POST',
    url: `${env.SUPABASE_URL}/rest/v1/rpc/search_knowledge_base`,
    headers: sbHeaders(env),
    body: { p_tenant_id: tenant_id, p_query_embedding: vec, p_match_count: 3 },
  });
  if (!r.ok) return { error: 'kb search failed', detail: r.body };
  return { excerpts: (r.body || []).map((x) => ({ source: x.source, content: x.content })) };
}

async function consult_team({ question }, ctx) {
  const { env, tenant_slug, contact_id } = ctx;
  const t = await http({
    url: `${env.SUPABASE_URL}/rest/v1/tenants?slug=eq.${encodeURIComponent(tenant_slug)}&select=slack_webhook_url`,
    headers: { ...sbHeaders(env), Accept: 'application/vnd.pgrst.object+json' },
  });
  const hook = t.body && t.body.slack_webhook_url;
  if (hook) {
    await http({
      method: 'POST',
      url: hook,
      headers: { 'Content-Type': 'application/json' },
      body: { text: `*Sarah needs help*\nQuestion: ${question}\nContact: ${contact_id}` },
    });
  }
  // Non-blocking: Sarah keeps selling; the reply lands in team_notes later.
  return { content: 'Question posted to team. Continue the conversation; their reply will land in team_notes on a later turn.' };
}

const HANDLERS = {
  search_wines, check_stock, add_to_cart, set_cart, capture_return_channels,
  consult_web, consult_knowledge_base, consult_team,
};

module.exports = { HANDLERS };
