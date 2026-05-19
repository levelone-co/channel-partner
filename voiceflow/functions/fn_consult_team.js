// Voiceflow Function: fn_consult_team  (tool: consult_team)
// Non-blocking: posts to the tenant's Slack webhook and returns immediately.
// Sarah keeps selling; the team reply lands in team_notes on a later turn.
// Inputs: question (tool arg) | tenant_slug, user_id, + secrets
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Output var: tool_result.
export default async function main(args) {
  const env = args;
  const tenant_slug = args.tenant_slug || 'level_24_wines';
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

  const t = await http({
    url: `${env.SUPABASE_URL}/rest/v1/tenants?slug=eq.${encodeURIComponent(tenant_slug)}&select=slack_webhook_url`,
    headers: { ...sb, Accept: 'application/vnd.pgrst.object+json' },
  });
  const hook = t.body && t.body.slack_webhook_url;
  if (hook) {
    await http({
      method: 'POST',
      url: hook,
      headers: { 'Content-Type': 'application/json' },
      body: { text: `*Sarah needs help*\nQuestion: ${args.question}\nContact: ${contact_id}` },
    });
  }
  const result = { content: 'Question posted to team. Continue the conversation; their reply will land in team_notes on a later turn.' };
  return { outputVars: { tool_result: JSON.stringify(result) } };
}
