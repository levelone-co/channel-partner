// ⚠ PASTE-READY BODY ONLY. The Voiceflow function creator already
// supplies:  export default async function main(args) { ... }
// Paste everything below BETWEEN its braces. Do NOT add
// `export default`, an outer function, or `module.exports`.

// Voiceflow Function: fn_capture_return_channels  (tool: capture_return_channels)
// Backup acknowledgment path — never solicits. Inputs: first_name,
//   last_name, phone, whatsapp, email (tool args) | user_id, + secret
//   GHL_API_TOKEN. Output var: tool_result.
  const GHL_API_TOKEN = args.GHL_API_TOKEN;
  const env = { GHL_API_TOKEN };
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

  const FIELD_ID = {
    whatsapp_preferred: 'cZnCWMR3VsZW0YXXcxGL',
    return_channels_captured_at: 'kE3148Mfthnf3UHEPb4N',
  };
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
  return { tool_result: JSON.stringify({ captured: true }) };
