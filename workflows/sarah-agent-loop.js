/**
 * Sarah Agent Loop — n8n Code node body.
 *
 * Replaces the old "Call Claude" HTTP Request node. KEEP THE NODE NAMED
 * "Call Claude" so downstream nodes keep resolving
 * `$('Call Claude').first().json...` — this returns the FINAL Anthropic
 * response object (plus reply_text + _agent), same shape the HTTP node had.
 *
 * Node settings: Language = JavaScript, Mode = "Run Once for All Items".
 *
 * HTTP via this.helpers.httpRequest — the n8n external JS task runner does
 * NOT provide a global `fetch`, but it DOES bridge this.helpers.httpRequest
 * over RPC. Every call is wrapped so the node never throws; on any failure
 * it returns a graceful fallback with the cause in _agent.diag.
 *
 * n8n Variables required:
 *   ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *   VOYAGE_API_KEY, SHOPIFY_STORE_DOMAIN, GHL_API_TOKEN.
 *
 * Cart = a Shopify cart permalink (/cart/{variant}:{qty}). ZERO
 * Shopify auth — no Admin API, no Storefront, no OAuth, no token.
 * Stock is a soft check against the ingested catalogue (Supabase).
 */

const bm = $('Build Messages').first().json;
const system = bm.systemBlocks;
const tenantId = bm.tenant_id;
const contactId = bm.contact_id;

const ANTHROPIC = $vars.ANTHROPIC_API_KEY;
const SB_URL = $vars.SUPABASE_URL;
const SB_KEY = $vars.SUPABASE_SERVICE_ROLE_KEY;
const VOYAGE = $vars.VOYAGE_API_KEY;
const SHOP = $vars.SHOPIFY_STORE_DOMAIN;
const GHL_TOKEN = $vars.GHL_API_TOKEN;

const SHOPIFY_API_VERSION = '2024-10';
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_ITERS = 5;

const FIELD_ID = {
  whatsapp_preferred: 'cZnCWMR3VsZW0YXXcxGL',
  return_channels_captured_at: 'kE3148Mfthnf3UHEPb4N',
};

const helpers = this.helpers;

// Single HTTP primitive. Never throws. Returns { ok, status, body }.
async function http({ method = 'GET', url, headers = {}, body }) {
  try {
    const res = await helpers.httpRequest({
      method,
      url,
      headers,
      body: body !== undefined ? body : undefined,
      json: true, // serialise request object + parse response as JSON
      returnFullResponse: true,
      ignoreHttpStatusErrors: true,
    });
    return { ok: res.statusCode < 400, status: res.statusCode, body: res.body };
  } catch (e) {
    // Structured error so we can actually see what failed (n8n errors are
    // objects; String() on them yields "[object Object]").
    const err = {
      url,
      message: e && e.message,
      description: e && e.description,
      name: e && e.name,
      httpCode: e && (e.httpCode || e.statusCode || e.status),
      cause: e && e.cause && (e.cause.message || String(e.cause)),
      response_snippet:
        e && e.response && e.response.body
          ? String(JSON.stringify(e.response.body)).slice(0, 300)
          : undefined,
    };
    return { ok: false, status: err.httpCode || 0, body: { __error: err } };
  }
}

const sbHeaders = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
};

// --- Shopify cart permalink — ZERO auth. /cart/{variant}:{qty},... ---
// No Admin API, no Storefront, no OAuth, no token. Lines accumulate per
// (tenant, contact) in customer_carts so multiple adds build one cart.

async function search_wines({ query }) {
  const emb = await http({
    method: 'POST',
    url: 'https://api.voyageai.com/v1/embeddings',
    headers: { Authorization: `Bearer ${VOYAGE}` },
    body: { model: 'voyage-4-lite', input: [query], input_type: 'query', output_dimension: 512 },
  });
  const vector = emb.body && emb.body.data && emb.body.data[0] && emb.body.data[0].embedding;
  if (!vector) return { error: 'embedding failed', detail: emb.body };
  const r = await http({
    method: 'POST',
    url: `${SB_URL}/rest/v1/rpc/search_wines`,
    headers: sbHeaders,
    body: { p_tenant_id: tenantId, p_query_embedding: vector, p_match_count: 3 },
  });
  return r.ok ? { wines: r.body } : { error: 'search failed', detail: r.body };
}

async function check_stock({ shopify_variant_id }) {
  // Backed by the ingested catalogue (Supabase), not Shopify — search_wines
  // already only surfaces inventory_available wines, so this is a soft check.
  const r = await http({
    url:
      `${SB_URL}/rest/v1/wines?tenant_id=eq.${encodeURIComponent(tenantId)}` +
      `&shopify_variant_id=eq.${encodeURIComponent(shopify_variant_id)}` +
      `&select=title,vintage,inventory_available`,
    headers: sbHeaders,
  });
  const row = Array.isArray(r.body) && r.body[0];
  if (!row)
    return { available: true, note: 'not in catalogue cache; checkout will confirm' };
  return {
    available: !!row.inventory_available,
    wine: `${row.title || ''} ${row.vintage || ''}`.trim(),
  };
}

// Shared: read current lines, persist a lines map, return permalink.
// `lines` is { variantId: qty }. Empty map => cleared cart (no permalink).
async function readCartLines() {
  const r = await http({
    url:
      `${SB_URL}/rest/v1/customer_carts?tenant_id=eq.${encodeURIComponent(tenantId)}` +
      `&contact_id=eq.${encodeURIComponent(contactId)}&select=cart_id`,
    headers: sbHeaders,
  });
  const prev = (Array.isArray(r.body) && r.body[0] && r.body[0].cart_id) || '';
  const lines = {};
  for (const part of String(prev).split(',')) {
    const m = part.match(/^(\d+):(\d+)$/);
    if (m) lines[m[1]] = (lines[m[1]] || 0) + parseInt(m[2], 10);
  }
  return lines;
}

async function persistCart(lines) {
  const entries = Object.keys(lines).filter((k) => lines[k] > 0);
  const spec = entries.map((k) => `${k}:${lines[k]}`).join(',');
  const checkout_url = spec ? `https://${SHOP}/cart/${spec}?storefront=true` : null;
  await http({
    method: 'POST',
    url: `${SB_URL}/rest/v1/customer_carts?on_conflict=tenant_id,contact_id`,
    headers: { ...sbHeaders, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: {
      tenant_id: tenantId,
      contact_id: contactId,
      cart_id: spec,
      checkout_url,
      updated_at: new Date().toISOString(),
    },
  });
  return {
    cart: entries.map((k) => ({ variant_id: k, quantity: lines[k] })),
    checkout_url, // permalink (backstop)
  };
}

// Commit a lines map: always persist + build the permalink backstop, then
// try the "Shopify Cart" sub-workflow for a real Draft Order. Prefer the
// draft invoice_url; fall back to the permalink if the sub-workflow is
// unset/fails so cart behaviour never regresses.
async function commitCart(lines) {
  const base = await persistCart(lines); // backstop: spec + permalink
  const entries = Object.keys(lines).filter((k) => lines[k] > 0);
  if (!entries.length) return { cleared: true, checkout_url: null, via: 'cleared' };

  const url = $vars.SHOPIFY_CART_WEBHOOK_URL;
  if (url) {
    const r = await http({
      method: 'POST',
      url,
      body: {
        tenant_id: tenantId,
        contact_id: contactId,
        lines: entries.map((k) => ({ variant_id: k, quantity: lines[k] })),
      },
    });
    const out = r.body || {};
    if (r.ok && out.ok && out.invoice_url) {
      return { cart: base.cart, checkout_url: out.invoice_url, via: 'draft_order' };
    }
    return { cart: base.cart, checkout_url: base.checkout_url, via: 'permalink_backstop', draft_error: out };
  }
  return { cart: base.cart, checkout_url: base.checkout_url, via: 'permalink_only' };
}

async function add_to_cart({ shopify_variant_id, quantity }) {
  const qty = Math.max(1, Math.min(24, parseInt(quantity, 10) || 1));
  const vid = String(shopify_variant_id).replace(/[^0-9]/g, '');
  if (!vid) return { error: 'invalid variant id' };
  const lines = await readCartLines();
  lines[vid] = (lines[vid] || 0) + qty;
  return commitCart(lines);
}

// Full control: replace the ENTIRE cart with exactly `items`
// (add/remove/replace/quantity-change all in one). items: [] clears it.
async function set_cart({ items }) {
  const lines = {};
  for (const it of items || []) {
    const vid = String(it.shopify_variant_id || '').replace(/[^0-9]/g, '');
    const q = Math.max(0, Math.min(24, parseInt(it.quantity, 10) || 0));
    if (vid && q > 0) lines[vid] = q;
  }
  return commitCart(lines);
}

async function capture_return_channels(args) {
  const customFields = [];
  if (args.whatsapp) customFields.push({ id: FIELD_ID.whatsapp_preferred, value: 'Yes' });
  customFields.push({
    id: FIELD_ID.return_channels_captured_at,
    value: new Date().toISOString().slice(0, 10),
  });
  await http({
    method: 'PUT',
    url: `https://services.leadconnectorhq.com/contacts/${contactId}`,
    headers: { Authorization: `Bearer ${GHL_TOKEN}`, Version: '2021-07-28' },
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

const HANDLERS = { search_wines, check_stock, add_to_cart, set_cart, capture_return_channels };

// ---- tool schemas (kept in sync with tools/account-tools.json) ------------
const tools = [
  {
    name: 'search_wines',
    description:
      'Search the wine catalogue by intent. Returns matches incl. shopify_variant_id for check_stock/add_to_cart.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'check_stock',
    description: 'Check live stock for a wine VARIANT before adding to cart.',
    input_schema: {
      type: 'object',
      properties: { shopify_variant_id: { type: 'string' } },
      required: ['shopify_variant_id'],
    },
  },
  {
    name: 'add_to_cart',
    description:
      "Incrementally add a wine variant to the customer's prepared cart link; returns a checkout_url that loads the cart when opened. Use for 'add another', 'also add'. Only after explicit confirmation.",
    input_schema: {
      type: 'object',
      properties: {
        shopify_variant_id: { type: 'string' },
        quantity: { type: 'integer', minimum: 1, maximum: 24 },
      },
      required: ['shopify_variant_id', 'quantity'],
    },
  },
  {
    name: 'set_cart',
    description:
      "Replace the customer's ENTIRE prepared cart with exactly these items in one call. Use for remove/replace/clear/change-quantity ('remove everything and add 2 Chenin', 'make it 3 of the Shiraz only', 'clear the cart'). Pass items: [] to empty it. Returns the updated checkout_url.",
    input_schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              shopify_variant_id: { type: 'string' },
              quantity: { type: 'integer', minimum: 1, maximum: 24 },
            },
            required: ['shopify_variant_id', 'quantity'],
          },
        },
      },
      required: ['items'],
    },
  },
  {
    name: 'capture_return_channels',
    description:
      'Backup capture for contact info the customer shared and your reply acknowledges. Never solicit.',
    input_schema: {
      type: 'object',
      properties: {
        first_name: { type: 'string' },
        last_name: { type: 'string' },
        phone: { type: 'string' },
        whatsapp: { type: 'string' },
        email: { type: 'string' },
      },
    },
  },
];

// ---- the loop -------------------------------------------------------------

function fallback(text, diag) {
  return [
    {
      json: {
        model: MODEL,
        stop_reason: 'end_turn',
        content: [{ type: 'text', text }],
        reply_text: text,
        usage: {},
        _agent: { error: true, diag: diag || null },
      },
    },
  ];
}

const ENV = {
  has_httpRequest: !!(helpers && helpers.httpRequest),
  has_anthropic_key: !!ANTHROPIC,
  has_sb_url: !!SB_URL,
  has_voyage: !!VOYAGE,
  has_shop_domain: !!SHOP,
  bm_keys: bm ? Object.keys(bm) : null,
  messages_len: Array.isArray(bm && bm.messages) ? bm.messages.length : 'n/a',
};

if (!helpers || !helpers.httpRequest) {
  return fallback("Sorry — I'm having a moment. A human will be with you shortly.", {
    stage: 'no_httpRequest',
    env: ENV,
  });
}

async function callClaude(withTools) {
  const r = await http({
    method: 'POST',
    url: 'https://api.anthropic.com/v1/messages',
    headers: { 'x-api-key': ANTHROPIC, 'anthropic-version': '2023-06-01' },
    body: withTools
      ? { model: MODEL, max_tokens: 1024, system, messages, tools }
      : { model: MODEL, max_tokens: 1024, system, messages },
  });
  return r;
}

let messages = Array.isArray(bm.messages) ? bm.messages.slice() : [];
const toolLog = [];

try {
  for (let iter = 0; iter < MAX_ITERS; iter++) {
    const r = await callClaude(true);
    const resp = r.body;

    if (!r.ok || !resp || resp.type === 'error' || !resp.content) {
      return fallback("Sorry — I'm having a moment. A human will be with you shortly.", {
        stage: 'anthropic_error',
        status: r.status,
        anthropic_response: resp,
        env: ENV,
      });
    }

    if (resp.stop_reason !== 'tool_use') {
      resp._agent = { tool_log: toolLog, iterations: iter + 1 };
      resp.reply_text =
        (Array.isArray(resp.content) && (resp.content.find((b) => b.type === 'text') || {}).text) ||
        '';
      return [{ json: resp }];
    }

    messages.push({ role: 'assistant', content: resp.content });

    const results = [];
    for (const block of resp.content) {
      if (block.type !== 'tool_use') continue;
      let result;
      try {
        const fn = HANDLERS[block.name];
        result = fn ? await fn(block.input || {}) : { error: `unknown tool ${block.name}` };
      } catch (e) {
        result = { error: String((e && (e.message || e)) || e) };
      }
      toolLog.push({ name: block.name, input: block.input, result });
      results.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result),
      });
    }
    messages.push({ role: 'user', content: results });
  }

  const fr = await callClaude(false);
  if (fr.ok && fr.body && fr.body.content) {
    const finalResp = fr.body;
    finalResp._agent = { tool_log: toolLog, iterations: MAX_ITERS, capped: true };
    finalResp.reply_text =
      (Array.isArray(finalResp.content) &&
        (finalResp.content.find((b) => b.type === 'text') || {}).text) ||
      '';
    return [{ json: finalResp }];
  }
  return fallback('Let me get a colleague to help with that — one moment.', {
    stage: 'iteration_cap',
    env: ENV,
  });
} catch (e) {
  return fallback("Sorry — I'm having a moment. A human will be with you shortly.", {
    stage: 'exception',
    error: String((e && (e.stack || e.message)) || e),
    env: ENV,
  });
}
