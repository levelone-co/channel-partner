// ⚠ PASTE-READY BODY ONLY. The Voiceflow function creator already
// supplies:  export default async function main(args) { ... }
// Paste everything below BETWEEN its braces. Do NOT add
// `export default`, an outer function, or `module.exports`.

// Voiceflow Function: fn_consult_knowledge_base  (tool: consult_knowledge_base)
// Inputs: query (tool arg) | fv_tenant_id, + secrets SUPABASE_URL,
//   SUPABASE_SERVICE_ROLE_KEY, VOYAGE_API_KEY. Output var: tool_result.
  const env = args;
  const tenant_id = args.fv_tenant_id;
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

  let result;
  const emb = await http({
    method: 'POST',
    url: 'https://api.voyageai.com/v1/embeddings',
    headers: { Authorization: `Bearer ${env.VOYAGE_API_KEY}` },
    body: { model: 'voyage-4-lite', input: [args.query], input_type: 'query', output_dimension: 512 },
  });
  const vec = emb.body && emb.body.data && emb.body.data[0] && emb.body.data[0].embedding;
  if (!vec) {
    result = { error: 'embedding failed' };
  } else {
    const r = await http({
      method: 'POST',
      url: `${env.SUPABASE_URL}/rest/v1/rpc/search_knowledge_base`,
      headers: sb,
      body: { p_tenant_id: tenant_id, p_query_embedding: vec, p_match_count: 3 },
    });
    result = r.ok
      ? { excerpts: (r.body || []).map((x) => ({ source: x.source, content: x.content })) }
      : { error: 'kb search failed', detail: r.body };
  }
  return { outputVars: { tool_result: JSON.stringify(result) } };
