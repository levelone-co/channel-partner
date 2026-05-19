// Voiceflow Function: fn_consult_web  (tool: consult_web)
// Inputs: query (tool arg) | + secret TAVILY_API_KEY. Degrades gracefully
//   if the key is absent. Output var: tool_result.
export default async function main(args) {
  const env = args;
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

  let result;
  if (!env.TAVILY_API_KEY) {
    result = { unavailable: true, note: 'web search not configured; answer from catalogue/knowledge instead' };
  } else {
    const r = await http({
      method: 'POST',
      url: 'https://api.tavily.com/search',
      headers: { 'Content-Type': 'application/json' },
      body: { api_key: env.TAVILY_API_KEY, query: args.query, max_results: 3, include_answer: 'basic' },
    });
    if (!r.ok) {
      result = { error: 'web search failed', detail: r.body };
    } else {
      const b = r.body || {};
      result = {
        answer: b.answer || null,
        results: (b.results || []).slice(0, 3).map((x) => ({ title: x.title, url: x.url, content: x.content })),
      };
    }
  }
  return { outputVars: { tool_result: JSON.stringify(result) } };
}
