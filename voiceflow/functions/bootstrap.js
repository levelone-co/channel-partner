// ⚠ PASTE-READY BODY ONLY. The Voiceflow function creator already
// supplies:  export default async function main(args) { ... }
// Paste everything below BETWEEN its braces. Do NOT add
// `export default`, an outer function, or `module.exports`.

/**
 * VF Function: bootstrap — the n8n prelude (Get Tenant → Get Contact →
 * Get Prompt → Get History → Voyage Embed → Search Wines → Build Messages →
 * Log User Turn), ported 1:1 from workflows/ai-conversation-core.json so the
 * VF engine is fed an IDENTICAL system prompt + messages array as n8n.
 *
 * Inputs (VF user-state variables, set by workflows/vf-adapter.json, or
 * defaulted for the native widget path):
 *   tenant_slug (default 'level_24_wines'), contact_id, channel ('web'),
 *   and the user's message (request.payload).
 *
 * Outputs (VF variables, fv_ prefix — vf_ is reserved by Voiceflow):
 *   fv_system, fv_system_text, fv_messages, fv_tenant_id,
 *   fv_retrieved_wine_ids. Contact/message come from built-ins.
 *
 * http + sbHeaders are inlined below (VF Functions can't import modules).
 */
  const SUPABASE_URL = args.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = args.SUPABASE_SERVICE_ROLE_KEY;
  const VOYAGE_API_KEY = args.VOYAGE_API_KEY;
  const GHL_API_TOKEN = args.GHL_API_TOKEN;
  const env = { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VOYAGE_API_KEY, GHL_API_TOKEN };
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
  const sbHeaders = (e) => ({ apikey: e.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${e.SUPABASE_SERVICE_ROLE_KEY}` });
  const tenant_slug = args.tenant_slug || 'level_24_wines';
  const contact_id = args.user_id;          // built-in: VF userID = contact id
  const channel = args.channel || 'voice';  // widget path is voice; adapter overrides
  const message = args.last_utterance;      // built-in: user's last utterance

  // GHL custom-field IDs — same as n8n Build Messages.
  const FIELD_ID = {
    whatsapp_preferred: 'cZnCWMR3VsZW0YXXcxGL',
    last_wines_discussed: 'fjnOTKILzjC3VCeS6bpw',
    team_notes: 'MOQaRVRvj1KiHEzIlmuU',
  };

  // 1. Tenant id
  const tRes = await http({
    url: `${env.SUPABASE_URL}/rest/v1/tenants?slug=eq.${encodeURIComponent(tenant_slug)}&select=id`,
    headers: { ...sbHeaders(env), Accept: 'application/vnd.pgrst.object+json' },
  });
  const tenant_id = tRes.body && tRes.body.id;

  // 2. Contact (GHL) — silent context
  const cRes = await http({
    url: `https://services.leadconnectorhq.com/contacts/${contact_id}`,
    headers: { Authorization: `Bearer ${env.GHL_API_TOKEN}`, Version: '2021-07-28' },
  });
  const contact = (cRes.body && cRes.body.contact) || {};
  const cf = contact.customFields || [];
  const gf = (id) => (cf.find((f) => f.id === id) || {}).value;

  // 3. Prompts (ordered) — concatenated identically to n8n
  const pRes = await http({
    url: `${env.SUPABASE_URL}/rest/v1/prompts?tenant_id=eq.${tenant_id}` +
      `&name=in.(10-behavioural-training-sale,15-conversational-data-capture-sale,20-domain-knowledge-wine,30-profile-account,40-playbook-account)` +
      `&select=name,content&order=name.asc`,
    headers: sbHeaders(env),
  });
  const byName = Object.fromEntries((pRes.body || []).map((p) => [p.name, p.content]));
  const order = ['10-behavioural-training-sale', '15-conversational-data-capture-sale',
    '20-domain-knowledge-wine', '30-profile-account', '40-playbook-account'];
  const stablePrompt = order.map((n) => byName[n]).filter(Boolean).join('\n\n---\n\n');

  // contact context block (silent — never call attention to it)
  const isPlaceholder = (s) => !s || /^(guest|visitor|unknown|anonymous)/i.test(String(s).trim());
  const ctx = [];
  if (!isPlaceholder(contact.firstName)) ctx.push(`Customer first name: ${contact.firstName}`);
  if (contact.email && !/visitor|guest/i.test(contact.email)) ctx.push(`Email on record: ${contact.email}`);
  if (contact.phone) ctx.push(`Phone on record: ${contact.phone}`);
  if (gf(FIELD_ID.whatsapp_preferred) === 'Yes') ctx.push('Customer prefers WhatsApp.');
  if (gf(FIELD_ID.last_wines_discussed)) ctx.push(`Previously discussed: ${gf(FIELD_ID.last_wines_discussed)}`);
  const tn = gf(FIELD_ID.team_notes);
  if (tn) {
    try {
      const notes = JSON.parse(tn);
      if (Array.isArray(notes) && notes.length)
        ctx.push(`Team notes received during this conversation that you should fold into your response:\n${notes.map((n) => `- ${n}`).join('\n')}`);
    } catch (_e) { /* not JSON yet */ }
  }
  const contactBlock = ctx.length ? `\n\n## Contact context\n${ctx.join('\n')}` : '';

  // 4. History (last 20, chronological, drop logged fallback/outage turns)
  const hRes = await http({
    url: `${env.SUPABASE_URL}/rest/v1/conversations?tenant_id=eq.${tenant_id}` +
      `&contact_id=eq.${encodeURIComponent(contact_id)}&role=in.(user,assistant)` +
      `&select=role,content,metadata&order=created_at.desc&limit=20`,
    headers: sbHeaders(env),
  });
  const history = (hRes.body || []).slice().reverse().filter((r) => {
    if (r.role !== 'assistant') return true;
    let md = r.metadata;
    if (typeof md === 'string') { try { md = JSON.parse(md); } catch (_e) { md = {}; } }
    if (md && md._agent && md._agent.error === true) return false;
    if (typeof r.content === 'string' && /^sorry\s*[—-]\s*i'?m having a moment/i.test(r.content)) return false;
    return true;
  }).map((r) => ({ role: r.role, content: r.content }));

  // 5. NO launch-time RAG. In the VF Operator architecture the agent does
  //    retrieval on demand via the fn_search_wines TOOL (the n8n engine
  //    instead injects a per-turn retrieved block — different mechanism,
  //    same grounding). Running an embed here on an empty launch message
  //    was wasteful and wrong, so it's removed (cost + correctness).
  const wines = [];

  // VF-specific operator addendum — enforces what n8n gets from its
  // per-turn retrieved-context block + channel routing. Kept OUT of the
  // shared Supabase prompts (those are cross-engine IP).
  const vfAddendum = [
    '## Voice + grounding rules (this channel)',
    '- You are on VOICE. Reply in ONE short spoken sentence. No lists, no',
    '  markdown, no URLs read aloud. Be warm and decisive, then stop.',
    '- NEVER name, describe, price, or recommend a wine unless it was',
    '  returned by fn_search_wines in THIS conversation. If you have not',
    '  searched yet for what they want, call fn_search_wines FIRST. Never',
    '  use outside wine knowledge for what we sell or invent vintages/prices.',
    '- Cart: to add/remove/replace/clear you MUST call fn_add_to_cart or',
    '  fn_set_cart in the same turn, using the shopify_variant_id from a',
    '  fn_search_wines result. Only state cart contents the tool just',
    "  returned. Don't claim anything was added without the tool call.",
    '- On voice you cannot read a checkout link aloud — after a successful',
    '  cart tool call, say it is ready and offer to text or email the link;',
    "  do not recite the URL.",
  ].join('\n');

  const systemBlocks = [
    { type: 'text', text: stablePrompt + contactBlock + '\n\n' + vfAddendum,
      cache_control: { type: 'ephemeral' } },
  ];

  const userMsg = { role: 'user', content: `[channel: ${channel}]\n${message}` };
  const messages = [...history, userMsg];

  // 6. Log User Turn
  await http({
    method: 'POST',
    url: `${env.SUPABASE_URL}/rest/v1/conversations`,
    headers: { ...sbHeaders(env), Prefer: 'return=minimal' },
    body: {
      tenant_id, contact_id, channel, role: 'user', content: message,
      metadata: { engine: 'voiceflow', retrieved_wine_ids: wines.map((w) => w.id) },
    },
  });

  // Flattened plain-text system for Voiceflow's Agent step (which does not
  // take Anthropic content-blocks/cache_control). Losing cache_control is a
  // minor cost difference — record it as a documented eval caveat.
  const fv_system_text = systemBlocks.map((b) => b.text).join('\n\n');

  return {
    fv_system: systemBlocks,
    fv_system_text,
    fv_messages: messages,
    fv_tenant_id: tenant_id,
    fv_contact_id: contact_id,
    fv_channel: channel,
    fv_retrieved_wine_ids: wines.map((w) => w.id),
    fv_message: message,
  };
