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
 *   VOYAGE_API_KEY, SHOPIFY_STORE_DOMAIN, GHL_API_TOKEN, and ONE of:
 *     SHOPIFY_ADMIN_TOKEN  (preferred — the atkn_… App automation token
 *                           a store "Develop apps" Custom App issues), OR
 *     SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (only for Partner apps).
 *
 * Cart/stock use the Shopify ADMIN API (Draft Orders). Store-level
 * custom apps authenticate with the static Admin token, NOT
 * client_credentials (Shopify -> "application_cannot_be_found").
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
const SHOPIFY_CLIENT_ID = $vars.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = $vars.SHOPIFY_CLIENT_SECRET;
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

// --- Shopify Admin API (Draft Orders) — reuses the proven client_credentials
// auth the ingest script uses. No Storefront token needed. ---
let _adminToken = null;
let _adminTokenDiag = null;
async function adminToken() {
  if (_adminToken) return _adminToken;

  // Optional override: a static Admin API access token, if ever set.
  const STATIC = $vars.SHOPIFY_ADMIN_TOKEN;
  if (STATIC) {
    _adminToken = STATIC;
    _adminTokenDiag = { source: 'static_SHOPIFY_ADMIN_TOKEN' };
    return _adminToken;
  }

  // client_credentials — credentials go in the URL QUERY STRING (proven
  // working in Postman), NOT the body. Returns a short-lived shpua_ token
  // (expires_in ~86400s). We mint fresh per execution; no cross-run cache.
  try {
    const qs =
      `grant_type=client_credentials` +
      `&client_id=${encodeURIComponent(SHOPIFY_CLIENT_ID || '')}` +
      `&client_secret=${encodeURIComponent(SHOPIFY_CLIENT_SECRET || '')}`;
    const res = await helpers.httpRequest({
      method: 'POST',
      url: `https://${SHOP}/admin/oauth/access_token?${qs}`,
      returnFullResponse: true,
      ignoreHttpStatusErrors: true,
    });
    let b = res.body;
    if (typeof b === 'string') {
      try { b = JSON.parse(b); } catch (_e) { /* keep string */ }
    }
    _adminToken = b && b.access_token;
    _adminTokenDiag = {
      source: 'client_credentials_query',
      status: res.statusCode,
      scope: b && b.scope,
      token_prefix: _adminToken ? String(_adminToken).slice(0, 6) : null,
      body: _adminToken ? undefined : typeof b === 'string' ? String(b).slice(0, 300) : b,
      shop: SHOP,
      has_client_id: !!SHOPIFY_CLIENT_ID,
      has_client_secret: !!SHOPIFY_CLIENT_SECRET,
    };
  } catch (e) {
    _adminTokenDiag = { error: String((e && (e.message || e)) || e) };
  }
  return _adminToken;
}

async function adminApi(method, path, body) {
  const token = await adminToken();
  if (!token)
    return { ok: false, status: 0, body: { __error: 'admin token mint failed', mint: _adminTokenDiag } };
  return http({
    method,
    url: `https://${SHOP}/admin/api/${SHOPIFY_API_VERSION}${path}`,
    headers: { 'X-Shopify-Access-Token': token },
    body,
  });
}

// ---- tool implementations -------------------------------------------------

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
  const r = await adminApi('GET', `/variants/${shopify_variant_id}.json`);
  const v = r.body && r.body.variant;
  if (!v) return { error: 'variant not found', status: r.status, detail: r.body };
  const qty = typeof v.inventory_quantity === 'number' ? v.inventory_quantity : null;
  const available = v.inventory_policy === 'continue' || (qty === null ? true : qty > 0);
  return { available, quantity_available: qty, wine: v.title || '' };
}

async function add_to_cart({ shopify_variant_id, quantity }) {
  const qty = Math.max(1, Math.min(24, parseInt(quantity, 10) || 1));
  const vid = parseInt(shopify_variant_id, 10);

  const existing = await http({
    url:
      `${SB_URL}/rest/v1/customer_carts?tenant_id=eq.${encodeURIComponent(tenantId)}` +
      `&contact_id=eq.${encodeURIComponent(contactId)}&select=cart_id,checkout_url`,
    headers: sbHeaders,
  });
  const rows = Array.isArray(existing.body) ? existing.body : [];
  const draftId = rows.length && rows[0].cart_id ? rows[0].cart_id : null;

  let draft, resp;
  if (draftId) {
    // Append the new line to the existing draft order.
    const cur = await adminApi('GET', `/draft_orders/${draftId}.json`);
    const lines = ((cur.body && cur.body.draft_order && cur.body.draft_order.line_items) || []).map(
      (li) => ({ variant_id: li.variant_id, quantity: li.quantity })
    );
    lines.push({ variant_id: vid, quantity: qty });
    resp = await adminApi('PUT', `/draft_orders/${draftId}.json`, {
      draft_order: { id: draftId, line_items: lines },
    });
    draft = resp.body && resp.body.draft_order;
  }
  if (!draft) {
    resp = await adminApi('POST', `/draft_orders.json`, {
      draft_order: { line_items: [{ variant_id: vid, quantity: qty }] },
    });
    draft = resp.body && resp.body.draft_order;
  }
  if (!draft || !draft.invoice_url) {
    return {
      error: 'draft order failed',
      shop_domain: SHOP || null,
      status: resp && resp.status,
      detail: resp && resp.body,
    };
  }

  await http({
    method: 'POST',
    url: `${SB_URL}/rest/v1/customer_carts?on_conflict=tenant_id,contact_id`,
    headers: { ...sbHeaders, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: {
      tenant_id: tenantId,
      contact_id: contactId,
      cart_id: String(draft.id),
      checkout_url: draft.invoice_url,
      updated_at: new Date().toISOString(),
    },
  });

  return { added: { quantity: qty }, checkout_url: draft.invoice_url };
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

const HANDLERS = { search_wines, check_stock, add_to_cart, capture_return_channels };

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
      "Add a wine variant to the customer's cart; returns a checkout_url. Only after explicit confirmation. Calling this is the ONLY way an item is actually in the cart.",
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
  has_shopify_client_creds: !!(SHOPIFY_CLIENT_ID && SHOPIFY_CLIENT_SECRET),
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
