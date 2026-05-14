# n8n workflow changes for Steps 3 + 3.5

This file is the click-by-click change log for `ai-conversation-core.json` in the n8n UI. Make these changes in the running workflow, verify, then export back to `workflows/ai-conversation-core.json` and commit.

> **Approach**: build incrementally. Land Step 3 (channel routing + silent extraction) and verify before adding Step 3.5 (consultation tools). The workflow file in the repo today represents the end of Step 2 — the diff below is what gets layered on.

> **Convention reminders** from the build so far:
> - All Supabase HTTP nodes carry headers `apikey` + `Authorization: Bearer` + `Accept: application/vnd.pgrst.object+json` (for single-row endpoints).
> - All multi-row HTTP nodes have `executeOnce: true` to prevent the per-item cascade we hit in Step 2.
> - Variables are referenced via `{{ $vars.X }}`, not `{{ $env.X }}`.
> - Body Parameters mode is more reliable than JSON Body mode when expressions are needed.

---

## Step 3 — Channel routing + silent extraction

### A. `Extract` node — add channel normalisation

Open the existing `Extract` (Set) node. Add two new assignments alongside the existing ones:

| Name | Value | Type |
|---|---|---|
| `channel_ghl` | `{{ $json.body.channel }}` | String |
| `channel` | *(replace existing)* `{{ ({SMS:'sms', Email:'email', WhatsApp:'whatsapp', Live_Chat:'web', FB:'whatsapp', IG:'whatsapp'}[$json.body.channel] || 'web') }}` | String |

The original `channel` assignment becomes the normalised value used by behavioural-training's length rules. `channel_ghl` preserves the GHL string (`SMS` / `WhatsApp` / etc.) for the outbound `Send via GHL` node.

### B. New node: `Get Contact` — after `Get Tenant`

Insert a new HTTP Request node between `Get Tenant` and `Get Prompt`.

- **Method**: GET
- **URL**: `{{ $vars.SUPABASE_URL }}/rest/v1/rpc/ghl_get_contact`  *(see note)*
- *OR — simpler initially* — call GHL directly:
  - URL: `https://services.leadconnectorhq.com/contacts/{{ $('Extract').first().json.contact_id }}`
  - Headers:
    - `Authorization: Bearer {{ $vars.GHL_API_TOKEN }}`
    - `Version: 2021-07-28`
- **executeOnce: true**
- **alwaysOutputData: true** (so a missing contact doesn't blow up the chain)
- **On Error**: Continue regular output

Output shape (from GHL): `{contact: {id, firstName, lastName, email, phone, customFields: [{id, value}, ...]}}`. Downstream `Build Messages` will pull what it needs from this.

### C. Update `Build Messages` Code node — fold contact context

In the `Build Messages` Code, after the existing `rows(...)` helper and prompt assembly, add this block before the `userMsg` is built:

```js
// Pull contact context from Get Contact (if present).
const contactItems = $('Get Contact').all().map(i => i.json).filter(Boolean);
const contact = contactItems[0]?.contact || {};
const customFields = contact.customFields || [];
const findField = (id) => (customFields.find(f => f.id === id) || {}).value;

// GHL field IDs — populate these from your GHL custom-fields page.
const FIELD_ID = {
  whatsapp_preferred: '<PASTE_FIELD_ID>',
  return_channels_captured_at: '<PASTE_FIELD_ID>',
  last_wines_discussed: '<PASTE_FIELD_ID>',
  team_notes: '<PASTE_FIELD_ID>',
};

const contactContext = [];
if (contact.firstName) contactContext.push(`Customer first name: ${contact.firstName}`);
if (findField(FIELD_ID.whatsapp_preferred) === 'Yes') contactContext.push('WhatsApp is the preferred channel.');
if (findField(FIELD_ID.last_wines_discussed)) contactContext.push(`Previously discussed: ${findField(FIELD_ID.last_wines_discussed)}`);
const teamNotesRaw = findField(FIELD_ID.team_notes);
if (teamNotesRaw) {
  try {
    const notes = JSON.parse(teamNotesRaw);
    if (Array.isArray(notes) && notes.length) {
      contactContext.push(`Team notes received during this conversation that you should fold into your response: ${notes.map(n => `- ${n}`).join('\n')}`);
    }
  } catch (_e) { /* not JSON yet */ }
}
const contactBlock = contactContext.length ? `\n\n## Contact context\n${contactContext.join('\n')}` : '';

// Then in the systemBlocks definition, change:
//   text: stablePrompt
// to:
//   text: stablePrompt + contactBlock
```

The contact context lives inside the cached portion of the system prompt (it changes rarely per conversation), keeping cache hit rates high.

### D. New node: `Send via GHL` — after `Log Assistant Turn`

Insert an HTTP Request node between `Log Assistant Turn` and the existing `Respond`. (Also wire from `Log Error` → `Send via GHL` → `Respond Fallback` so error fallbacks reach the customer's actual channel, not just the webhook caller.)

- **Method**: POST
- **URL**: `https://services.leadconnectorhq.com/conversations/messages`
- **Headers**:
  - `Authorization: Bearer {{ $vars.GHL_API_TOKEN }}`
  - `Version: 2021-07-28`
  - `Content-Type: application/json`
- **Body** (Body Parameters mode):
  - `type` (Expression): `{{ $('Extract').first().json.channel_ghl }}`
  - `contactId` (Expression): `{{ $('Extract').first().json.contact_id }}`
  - `message` (Expression): `{{ $('Call Claude').first().json.content[0].text }}`
- **executeOnce: true**
- **On Error**: Continue (using error output) — wire to a small note-the-failure path that still hits `Respond` so the webhook caller gets a 200.

### E. New parallel branch: `Extract Entities` — passive silent capture

This is a **separate branch off the `Extract` node**, running alongside the main Sarah pipeline. Add three nodes:

#### E.1 `Extract Entities` — HTTP Request → Anthropic

- Method: POST
- URL: `https://api.anthropic.com/v1/messages`
- Headers:
  - `x-api-key: {{ $vars.ANTHROPIC_API_KEY }}`
  - `anthropic-version: 2023-06-01`
  - `Content-Type: application/json`
- Body (JSON, with leading `=` if field is in Expression mode):
  ```
  ={
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 200,
    "system": "Extract any of the following that the user shared in their latest message: first_name, last_name, phone (E.164 format if possible), whatsapp (only if different from phone), email. Return ONLY a JSON object with the present fields. If none are present, return {}. Never guess.",
    "messages": [{ "role": "user", "content": {{ JSON.stringify($('Extract').first().json.message) }} }]
  }
  ```
- **executeOnce: true**
- **On Error**: Continue (using error output) — extraction failures must not block Sarah's reply.

#### E.2 `Parse Entities` — Code node

```js
const raw = $json.content?.[0]?.text || '{}';
let parsed = {};
try { parsed = JSON.parse(raw); } catch (_e) {}
const hasAny = Object.keys(parsed).some(k => parsed[k]);
return [{ json: { ...parsed, _has_any: hasAny } }];
```

#### E.3 `Update GHL Contact (extraction)` — HTTP Request

Only fires when `_has_any` is true. Add an IF node upstream that filters on `{{ $json._has_any }} === true`, OR set the HTTP node to skip on empty body.

- Method: PUT
- URL: `https://services.leadconnectorhq.com/contacts/{{ $('Extract').first().json.contact_id }}`
- Headers: same as `Send via GHL`
- Body (Body Parameters):
  - `firstName` (Expression): `{{ $json.first_name }}`
  - `lastName` (Expression): `{{ $json.last_name }}`
  - `phone` (Expression): `{{ $json.phone }}`
  - `email` (Expression): `{{ $json.email }}`
  - `customFields` (Expression): see below for the nested array shape — GHL expects an array of `{id, value}` objects

For the customFields:

```
{{ (() => {
  const out = [];
  if ($json.whatsapp) out.push({ id: '<WHATSAPP_PREFERRED_FIELD_ID>', value: 'Yes' });
  if (Object.keys($json).some(k => $json[k] && k !== '_has_any')) {
    out.push({ id: '<RETURN_CHANNELS_CAPTURED_AT_FIELD_ID>', value: new Date().toISOString().slice(0, 10) });
  }
  return out;
})() }}
```

#### E.4 Wire into existing chain

- `Extract` → `Extract Entities` (in parallel with the existing path to `Get Tenant`).
- `Extract Entities` → `Parse Entities` → IF (`_has_any` true) → `Update GHL Contact (extraction)`.
- The branch terminates after `Update GHL Contact (extraction)`. No need to merge back into the main chain — the workflow continues to `Respond` via the main path, and the extraction branch runs in parallel.

### F. Existing `Get Prompt` — add the data-capture prompt

In the `Get Prompt` node's query parameters, update the `name` filter to include the new prompt:

```
name = in.(10-behavioural-training-sale,15-conversational-data-capture-sale,20-domain-knowledge-wine,30-profile-account,40-playbook-account)
```

And in `Build Messages`' `promptOrder`:

```js
const promptOrder = [
  '10-behavioural-training-sale',
  '15-conversational-data-capture-sale',
  '20-domain-knowledge-wine',
  '30-profile-account',
  '40-playbook-account',
];
```

### G. Update `Call Claude` body — add `tools`

In the `Call Claude` HTTP node's JSON Body, add a `tools` array. Pull the full array from `tools/account-tools.json` in the repo and paste as the value of `tools`. For Step 3 verification you only need `capture_return_channels` active; the other six (`search_wines`, `check_stock`, `add_to_cart`, `consult_web`, `consult_knowledge_base`, `consult_team`) can be present but will get implemented in subsequent steps.

```
={
  "model": "claude-haiku-4-5-20251001",
  "max_tokens": 1024,
  "system": {{ JSON.stringify($('Build Messages').first().json.systemBlocks) }},
  "messages": {{ JSON.stringify($('Build Messages').first().json.messages) }},
  "tools": <paste tools array from tools/account-tools.json>
}
```

### H. Add the tool-loop after `Call Claude`

This is the bigger structural change. After `Call Claude`, route on `stop_reason`:

1. **`Switch on stop_reason`** node — branches:
   - `end_turn` → `Log Assistant Turn` (existing path)
   - `tool_use` → tool dispatch chain

2. **Tool dispatch chain**:
   - `Code: extract tool call` node — pulls the first `tool_use` block from `$json.content` and returns `{tool_name, tool_input, tool_use_id}`.
   - `Switch on tool_name` node — branches to one HTTP handler per tool:
     - `capture_return_channels` → `Update GHL Contact (tool)` — same shape as the extraction one above, but using `tool_input` values.
     - (`search_wines`, `check_stock`, `add_to_cart` — leave as no-op for Step 3; they get implemented in Step 4.)
     - (`consult_web`, `consult_knowledge_base`, `consult_team` — leave as no-op for Step 3; they get implemented in Step 3.5.)
   - Each handler outputs `{tool_use_id, content: <result text>}`.

3. **Loop back to `Call Claude`**: a `Code: append tool result` node builds the next `messages` array (existing messages + `assistant` turn with the tool_use + `user` turn with `tool_result`), then re-fires `Call Claude`. Cap at 4 iterations using a counter you initialise in `Build Messages` (`return [{ json: { ..., _tool_iter: 0 } }];`) and increment per loop.

n8n doesn't natively support cyclical workflows. Three viable patterns:
- **(Easiest)**: replicate the Claude HTTP node N times in series (Call Claude, Call Claude 2, Call Claude 3, Call Claude 4), with the tool-loop between each. Inelegant but works.
- **(Better)**: use n8n's "Wait" + sub-workflow pattern. The main workflow calls a sub-workflow `claude-with-tools` recursively.
- **(Best)**: implement the tool loop entirely in a single Code node that calls Anthropic directly via `fetch`. Bypasses n8n's node-level Claude integration but gives full control.

For Phase 0 demo with one capture tool, go with the easiest pattern (3 series Claude calls is enough — the loop almost never exceeds 2 iterations in practice).

### I. After all changes, export the workflow

n8n → workflow → `⋯` → **Download**. Save as `workflows/ai-conversation-core.json` (overwrite). Validate the JSON locally with `python3 -c "import json; json.load(open('workflows/ai-conversation-core.json'))"`. Commit.

---

## Step 3.5 — Consultation tools

Once Step 3 verifies, layer the three consultation tools into the existing tool-dispatch chain.

### A. `consult_web` handler

In the `Switch on tool_name` node, add a `consult_web` branch leading to an HTTP Request node:

- Method: POST
- URL: `https://api.tavily.com/search`
- Headers: `Content-Type: application/json`
- Body (JSON):
  ```
  ={
    "api_key": {{ JSON.stringify($vars.TAVILY_API_KEY) }},
    "query": {{ JSON.stringify($json.tool_input.query) }},
    "max_results": 3,
    "include_answer": "basic"
  }
  ```
- Output a `tool_result` shaped item: `{tool_use_id, content: <stringified results>}`.

### B. `consult_knowledge_base` handler

Three-node chain in the branch:

1. **HTTP: Voyage embed** — POST to `https://api.voyageai.com/v1/embeddings` with `{model: 'voyage-4-lite', input: [tool_input.query], input_type: 'query', output_dimension: 512}` (same shape as the main Voyage Embed node).
2. **HTTP: Supabase RPC** — POST to `{{ $vars.SUPABASE_URL }}/rest/v1/rpc/search_knowledge_base` with `{p_tenant_id, p_query_embedding, p_match_count: 3}`. Same auth headers as the wines RPC.
3. **Code: format result** — build a `tool_result` block from the top-3 KB excerpts.

### C. `consult_team` handler

Two-step branch:

1. **HTTP: Get Slack URL** — GET `{{ $vars.SUPABASE_URL }}/rest/v1/tenants?slug=eq.{{ $('Extract').first().json.tenant_slug }}&select=slack_webhook_url` with the single-object Accept header. Returns `{slack_webhook_url}`.
2. **HTTP: POST to Slack** — POST to the URL from step 1, body:
   ```json
   {
     "text": "*Sarah needs help*\nQuestion: <tool_input.question>\nContact: <contact_id>\nLink to GHL conversation: <build the link>"
   }
   ```
3. **Code: tool_result** — return `{tool_use_id, content: 'Question posted to team. Continue the conversation; their reply will land in team_notes on a later turn.'}`.

Sarah's next reply uses this `content` as confirmation; her prompt training tells her not to stall.

### D. Resumption workflow `team-reply.json`

A new, separate n8n workflow with **Webhook trigger** at path `team-reply`. Body shape (from GHL Internal Note creation event):

```json
{
  "tenant_slug": "level_24_wines",
  "contact_id": "{{contact.id}}",
  "team_reply": "{{note.body}}"
}
```

Steps:

1. Look up the current `team_notes` field on the GHL contact (HTTP GET).
2. Append the new reply to the array (parse JSON, push, re-stringify; or initialise `[]` if blank).
3. PUT the updated `team_notes` back to the contact via GHL's custom-fields update.
4. Respond 200.

That's it — the main `ai-conversation-core` workflow picks up the new note via its `Get Contact` node on the customer's next inbound message, and `Build Messages` formats it into the system context as instructed in `10-behavioural-training-sale.md`.

### E. Test all three tools

Per SETUP.md §8.6. The Tavily search and KB lookup should land synchronously; the team consult should post to Slack and continue the conversation without stalling.

---

## Verification: workflow JSON validity

After every export back to `workflows/ai-conversation-core.json`:

```bash
python3 -c "import json; w=json.load(open('workflows/ai-conversation-core.json')); print(f'{len(w[\"nodes\"])} nodes, {len(w[\"connections\"])} connection sources')"
```

Compare node count to expectations (Step 3 done ≈ 18–20 nodes; Step 3.5 done ≈ 28–32 nodes).
