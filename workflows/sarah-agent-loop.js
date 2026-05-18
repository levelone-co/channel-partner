/**
 * Sarah Agent Loop — n8n Code node body.
 *
 * Replaces the old "Call Claude" HTTP Request node. KEEP THE NODE NAMED
 * "Call Claude" so downstream nodes (Log Assistant Turn, Send via GHL,
 * Respond) keep resolving `$('Call Claude').first().json.content[0].text`
 * etc. — this node returns the FINAL Anthropic response object, exact same
 * shape the HTTP node produced.
 *
 * Node settings: Language = JavaScript, Mode = "Run Once for All Items".
 * It catches everything and always returns a valid Anthropic-shaped object,
 * so the workflow never hard-fails here (the old error branch becomes a
 * harmless no-op).
 *
 * n8n Variables required:
 *   ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *   VOYAGE_API_KEY, SHOPIFY_STORE_DOMAIN, SHOPIFY_STOREFRONT_TOKEN,
 *   GHL_API_TOKEN
 */

const bm = $('Build Messages').first().json;
const system = bm.systemBlocks;
const tenantId = bm.tenant_id;
const contactId = bm.contact_id;

const ANTHROPIC = $vars.ANTHROPIC_API_KEY;
const SB_URL = $vars.SUPABASE_URL;
const SB_KEY = $vars.SUPABASE_SERVICE_ROLE_KEY;
const VOYAGE = $vars.VOYAGE_API_KEY;
const SHOP = $vars.SHOPIFY_STORE_DOMAIN;          // e.g. level-24-co.myshopify.com
const SF_TOKEN = $vars.SHOPIFY_STOREFRONT_TOKEN;  // shpss_...
const GHL_TOKEN = $vars.GHL_API_TOKEN;

const SHOPIFY_API_VERSION = '2024-10';
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_ITERS = 5;

// GHL custom-field IDs (Level 24 demo sub-account).
const FIELD_ID = {
  whatsapp_preferred: 'cZnCWMR3VsZW0YXXcxGL',
  return_channels_captured_at: 'kE3148Mfthnf3UHEPb4N',
};

const sb = (path, opts = {}) =>
  fetch(`${SB_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });

const storefront = (query, variables) =>
  fetch(`https://${SHOP}/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'X-Shopify-Storefront-Access-Token': SF_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  }).then((r) => r.json());

const variantGid = (id) =>
  String(id).startsWith('gid://') ? String(id) : `gid://shopify/ProductVariant/${id}`;

// ---- tool implementations -------------------------------------------------

async function search_wines({ query }) {
  const emb = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${VOYAGE}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'voyage-4-lite',
      input: [query],
      input_type: 'query',
      output_dimension: 512,
    }),
  }).then((r) => r.json());
  const vector = emb?.data?.[0]?.embedding;
  if (!vector) return { error: 'embedding failed' };
  const rows = await sb('rpc/search_wines', {
    method: 'POST',
    body: JSON.stringify({
      p_tenant_id: tenantId,
      p_query_embedding: vector,
      p_match_count: 3,
    }),
  }).then((r) => r.json());
  return { wines: rows };
}

async function check_stock({ shopify_variant_id }) {
  const data = await storefront(
    `query($id: ID!) { node(id: $id) { ... on ProductVariant {
       availableForSale quantityAvailable title product { title } } } }`,
    { id: variantGid(shopify_variant_id) }
  );
  const v = data?.data?.node;
  if (!v) return { error: 'variant not found', raw: data?.errors || null };
  return {
    available: v.availableForSale,
    quantity_available: v.quantityAvailable,
    wine: `${v.product?.title || ''} ${v.title || ''}`.trim(),
  };
}

async function add_to_cart({ shopify_variant_id, quantity }) {
  const qty = Math.max(1, Math.min(24, parseInt(quantity, 10) || 1));
  const line = { merchandiseId: variantGid(shopify_variant_id), quantity: qty };

  // Existing cart for this contact?
  const existing = await sb(
    `customer_carts?tenant_id=eq.${encodeURIComponent(tenantId)}` +
      `&contact_id=eq.${encodeURIComponent(contactId)}&select=cart_id,checkout_url`
  ).then((r) => r.json());
  const haveCart = Array.isArray(existing) && existing.length && existing[0].cart_id;

  let cart, errs;
  if (haveCart) {
    const d = await storefront(
      `mutation($cartId: ID!, $lines: [CartLineInput!]!) {
         cartLinesAdd(cartId: $cartId, lines: $lines) {
           cart { id checkoutUrl } userErrors { message } } }`,
      { cartId: existing[0].cart_id, lines: [line] }
    );
    cart = d?.data?.cartLinesAdd?.cart;
    errs = d?.data?.cartLinesAdd?.userErrors;
  }
  if (!cart) {
    const d = await storefront(
      `mutation($lines: [CartLineInput!]!) {
         cartCreate(input: { lines: $lines }) {
           cart { id checkoutUrl } userErrors { message } } }`,
      { lines: [line] }
    );
    cart = d?.data?.cartCreate?.cart;
    errs = d?.data?.cartCreate?.userErrors;
  }
  if (!cart) return { error: 'cart operation failed', userErrors: errs || null };

  await sb('customer_carts?on_conflict=tenant_id,contact_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      tenant_id: tenantId,
      contact_id: contactId,
      cart_id: cart.id,
      checkout_url: cart.checkoutUrl,
      updated_at: new Date().toISOString(),
    }),
  });

  return { added: { quantity: qty }, checkout_url: cart.checkoutUrl };
}

async function capture_return_channels(args) {
  const customFields = [];
  if (args.whatsapp) customFields.push({ id: FIELD_ID.whatsapp_preferred, value: 'Yes' });
  customFields.push({
    id: FIELD_ID.return_channels_captured_at,
    value: new Date().toISOString().slice(0, 10),
  });
  const body = {
    firstName: args.first_name || undefined,
    lastName: args.last_name || undefined,
    phone: args.phone || args.whatsapp || undefined,
    email: args.email || undefined,
    customFields,
  };
  await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${GHL_TOKEN}`,
      Version: '2021-07-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return { captured: true };
}

const HANDLERS = { search_wines, check_stock, add_to_cart, capture_return_channels };

// ---- tool schemas (kept in sync with tools/account-tools.json) ------------
const tools = [
  {
    name: 'search_wines',
    description:
      'Search the wine catalogue by intent or attribute. Returns top matches with title, varietal, vintage, price, pairings, awards, plus shopify_variant_id for use with check_stock/add_to_cart.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'check_stock',
    description:
      'Check live stock for a specific wine VARIANT (a vintage) before adding to cart. Use the shopify_variant_id from the retrieved-context block or search_wines.',
    input_schema: {
      type: 'object',
      properties: { shopify_variant_id: { type: 'string' } },
      required: ['shopify_variant_id'],
    },
  },
  {
    name: 'add_to_cart',
    description:
      "Add a wine variant to the customer's cart. Returns a checkout_url to share. Only call after explicit customer confirmation. Calling this is the ONLY way an item is actually in the cart — never claim it otherwise.",
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
      'Backup capture for contact info the customer explicitly shared and that your reply acknowledges. The always-on extraction pipeline already captures silently — only use this when your reply itself refers to it. Never solicit.',
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

function fallback(text) {
  return [
    {
      json: {
        model: MODEL,
        stop_reason: 'end_turn',
        content: [{ type: 'text', text }],
        usage: {},
        _agent: { error: true },
      },
    },
  ];
}

let messages = Array.isArray(bm.messages) ? bm.messages.slice() : [];
const toolLog = [];

try {
  for (let iter = 0; iter < MAX_ITERS; iter++) {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 1024, system, messages, tools }),
    }).then((r) => r.json());

    if (resp.type === 'error' || !resp.content) {
      return fallback("Sorry — I'm having a moment. A human will be with you shortly.");
    }

    if (resp.stop_reason !== 'tool_use') {
      resp._agent = { tool_log: toolLog, iterations: iter + 1 };
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
        result = { error: String(e && e.message ? e.message : e) };
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
  // Hit the iteration cap — ask once more without tools for a clean closing turn.
  const finalResp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 1024, system, messages }),
  }).then((r) => r.json());
  if (finalResp.content) {
    finalResp._agent = { tool_log: toolLog, iterations: MAX_ITERS, capped: true };
    return [{ json: finalResp }];
  }
  return fallback("Let me get a colleague to help with that — one moment.");
} catch (e) {
  return fallback("Sorry — I'm having a moment. A human will be with you shortly.");
}
