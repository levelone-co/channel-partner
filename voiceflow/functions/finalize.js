/**
 * VF Function: finalize — runs AFTER the Agent step. Ports the n8n
 * Log Assistant Turn node + the silent-extraction branch
 * (Extract Entities → Parse Entities → Update GHL Contact).
 *
 * Inputs: fv_tenant_id (bootstrap), built-ins user_id / channel /
 *   last_utterance, and the Agent step result via built-in `last_response`.
 *   Optionally model/usage/stop_reason if the Agent step exposes them.
 *   `path` = 'adapter' | 'widget' for cost attribution (default 'widget').
 *
 * Output: { fv_reply } (informational; the Agent step already spoke it).
 *
 * Paste _http.js (http, sbHeaders) at the top of this Function.
 */
async function main(args) {
  const env = args;
  const tenant_id = args.fv_tenant_id;
  const contact_id = args.user_id;            // built-in
  const channel = args.channel || 'web';
  const message = args.last_utterance;        // built-in
  const reply = args.last_response || '';     // built-in: agent's last reply
  const path = args.path || 'widget';

  // 1. Log Assistant Turn — identical metadata shape to n8n + engine tag.
  await http({
    method: 'POST',
    url: `${env.SUPABASE_URL}/rest/v1/conversations`,
    headers: { ...sbHeaders(env), Prefer: 'return=minimal' },
    body: {
      tenant_id, contact_id, channel, role: 'assistant', content: reply,
      metadata: {
        engine: 'voiceflow',
        path,
        model: args.model || 'claude-haiku-4-5-20251001',
        input_tokens: args.input_tokens || 0,
        output_tokens: args.output_tokens || 0,
        stop_reason: args.stop_reason || null,
        _agent: args._agent || {},
      },
    },
  });

  // 2. Silent extraction — cheap Haiku call on the user's latest message;
  //    write any volunteered contact fields to GHL. Never blocks the reply
  //    (it already happened); mirrors n8n Extract Entities branch.
  try {
    const ex = await http({
      method: 'POST',
      url: 'https://api.anthropic.com/v1/messages',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        system: 'Extract contact details the user shared in their latest message. Return ONLY a JSON object with any of these keys that are present: first_name, last_name, phone, whatsapp, email. Phone/whatsapp in E.164 if you can infer the country (SA numbers like 0821234567 become +27821234567). If none are present return {}. Never guess or infer values that were not stated.',
        messages: [{ role: 'user', content: message }],
      },
    });
    const raw = ex.body && ex.body.content && ex.body.content[0] && ex.body.content[0].text || '{}';
    let p = {};
    try { const m = String(raw).match(/\{[\s\S]*\}/); p = m ? JSON.parse(m[0]) : {}; } catch (_e) { p = {}; }
    const clean = {};
    for (const k of ['first_name', 'last_name', 'phone', 'whatsapp', 'email'])
      if (p[k] && String(p[k]).trim()) clean[k] = String(p[k]).trim();

    if (Object.keys(clean).length) {
      const customFields = [].concat(
        clean.whatsapp ? [{ id: 'cZnCWMR3VsZW0YXXcxGL', value: 'Yes' }] : [],
        [{ id: 'kE3148Mfthnf3UHEPb4N', value: new Date().toISOString().slice(0, 10) }],
      );
      await http({
        method: 'PUT',
        url: `https://services.leadconnectorhq.com/contacts/${contact_id}`,
        headers: { Authorization: `Bearer ${env.GHL_API_TOKEN}`, Version: '2021-07-28' },
        body: Object.assign({},
          clean.first_name ? { firstName: clean.first_name } : {},
          clean.last_name ? { lastName: clean.last_name } : {},
          (clean.phone || clean.whatsapp) ? { phone: clean.phone || clean.whatsapp } : {},
          clean.email ? { email: clean.email } : {},
          { customFields }),
      });
    }
  } catch (_e) { /* extraction is best-effort; never blocks the reply */ }

  return { fv_reply: reply };
}

module.exports = { main };
