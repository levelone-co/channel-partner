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
 * Outputs (VF variables): vf_system, vf_messages, vf_tenant_id,
 *   vf_contact_id, vf_channel, vf_retrieved_wine_ids, vf_message.
 *
 * Paste _http.js (http, sbHeaders) at the top of this Function.
 */
async function main(args) {
  const env = args; // VF injects secrets as args; map as needed
  const tenant_slug = args.tenant_slug || 'level_24_wines';
  const contact_id = args.contact_id;
  const channel = args.channel || 'web';
  const message = args.message; // wire from request.payload in the flow

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

  // 5. Voyage embed + search_wines RPC
  const emb = await http({
    method: 'POST',
    url: 'https://api.voyageai.com/v1/embeddings',
    headers: { Authorization: `Bearer ${env.VOYAGE_API_KEY}` },
    body: { model: 'voyage-4-lite', input: [message], input_type: 'query', output_dimension: 512 },
  });
  const vec = emb.body && emb.body.data && emb.body.data[0] && emb.body.data[0].embedding;
  const wRes = vec ? await http({
    method: 'POST',
    url: `${env.SUPABASE_URL}/rest/v1/rpc/search_wines`,
    headers: sbHeaders(env),
    body: { p_tenant_id: tenant_id, p_query_embedding: vec, p_match_count: 3 },
  }) : { body: [] };
  const wines = Array.isArray(wRes.body) ? wRes.body : [];

  const wineBlock = wines.length
    ? '## Available wines for this conversation\n' + wines.map((w, i) => {
        const head = `${i + 1}. **${w.title}** — ${[w.varietal, w.vintage].filter(Boolean).join(' ')}` +
          (w.price ? `, R${w.price}` : '') +
          (w.shopify_variant_id ? ` [variant_id: ${w.shopify_variant_id} — use this for check_stock/add_to_cart; never say it aloud]` : '');
        const body = w.description ? `\n   ${w.description}` : '';
        const pair = w.pairings ? `\n   Pairings: ${w.pairings}.` : '';
        const award = w.awards ? ` Awards: ${w.awards}.` : '';
        return head + body + pair + award;
      }).join('\n')
    : '';

  // System: cached layered prompt + contact ctx, then uncached wine block.
  const systemBlocks = [
    { type: 'text', text: stablePrompt + contactBlock, cache_control: { type: 'ephemeral' } },
  ];
  if (wineBlock) systemBlocks.push({ type: 'text', text: wineBlock });

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
  const vf_system_text = systemBlocks.map((b) => b.text).join('\n\n');

  return {
    vf_system: systemBlocks,
    vf_system_text,
    vf_messages: messages,
    vf_tenant_id: tenant_id,
    vf_contact_id: contact_id,
    vf_channel: channel,
    vf_retrieved_wine_ids: wines.map((w) => w.id),
    vf_message: message,
  };
}

module.exports = { main };
