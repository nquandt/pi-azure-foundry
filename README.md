# pi-azure-foundry

A [pi](https://pi.dev) extension that connects to your [Azure AI Foundry](https://ai.azure.com) project, auto-discovers your chat deployments, and registers them as models in pi.

Supports both **API key** and **Azure identity** (Managed Identity, Azure CLI, service principal, etc.) authentication.

## Requirements

- A pi installation (`npm install -g @earendil-works/pi-coding-agent`)
- An Azure AI Foundry project with one or more chat-capable deployments

---

## Installation

### Global (works in any project)

```bash
pi install npm:@nquandt/pi-azure-foundry
```

### Try without installing

```bash
pi -e npm:@nquandt/pi-azure-foundry
```

---

## Configuration

Create an `azure-foundry.config.json` file. The extension looks in two places, in order:

1. `<current working directory>/azure-foundry.config.json` — project-specific
2. `~/.pi/azure-foundry.config.json` — global fallback

The global location is recommended for most users since it works across all projects.

### Finding your resource and project IDs

Both values come from your Azure AI Foundry project URL:

```
https://ai.azure.com/build/overview?wsid=/subscriptions/.../resourceGroups/.../providers/Microsoft.MachineLearningServices/workspaces/YOUR-PROJECT
```

Or from the Azure portal — your **resource name** is the Azure AI Services resource name, and your **project name** is the Foundry project name. They are often the same value.

### API key auth

```json
{
  "resourceId": "my-resource-eastus2",
  "projectId": "my-project-eastus2",
  "auth": {
    "type": "api-key",
    "apiKey": "your-api-key-here"
  }
}
```

Get your API key from the Azure AI Foundry portal under **Settings → API keys**.

### Azure identity auth

```json
{
  "resourceId": "my-resource-eastus2",
  "projectId": "my-project-eastus2",
  "auth": {
    "type": "azure-identity"
  }
}
```

No key needed. Uses [`DefaultAzureCredential`](https://learn.microsoft.com/en-us/javascript/api/@azure/identity/defaultazurecredential) which automatically tries, in order:

| Method | How to set up |
|---|---|
| Environment variables | Set `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID` |
| Workload identity | Configured automatically in AKS |
| Managed identity | Configured automatically on Azure VMs / App Service / Container Apps |
| Azure CLI | Run `az login` |
| Azure Developer CLI | Run `azd auth login` |
| Visual Studio Code | Sign in via the Azure extension |

For local development, `az login` is the easiest option.

### Gateway and extra headers (optional)

If your organization fronts Azure AI Foundry with an API Management gateway, set `gatewayUrl`. Chat requests then go to that host with the same route paths (`/openai/deployments/...` and `/anthropic/v1/messages`). Deployment discovery still uses the Foundry endpoint directly.

Use `headers` to send extra HTTP headers on every chat request, for example an APIM subscription key. The extension's own auth headers always take precedence over these.

```json
{
  "resourceId": "my-resource-eastus2",
  "projectId": "my-project-eastus2",
  "auth": { "type": "azure-identity" },
  "gatewayUrl": "https://my-gateway.azure-api.net/foundry",
  "headers": {
    "Ocp-Apim-Subscription-Key": "your-subscription-key"
  }
}
```

---

## Usage

Once installed and configured, start pi normally. On startup you'll see:

```
[Azure Foundry] Loading config from: /Users/you/.pi/azure-foundry.config.json
[Azure Foundry] Auth: api-key
[Azure Foundry] Fetching deployments from: https://my-resource.services.ai.azure.com/...
[Azure Foundry] Found 3 deployment(s): claude-sonnet (Anthropic), gpt-4o (Microsoft), ...
[Azure Foundry] ✓ Registered 3 model(s)
```

Your deployments will appear in the pi model picker under the **Azure Foundry** provider.

---

## How it works

- **Deployment discovery** — on startup the extension calls the Foundry deployments API and filters to chat-capable deployments. No model list to maintain manually.
- **Metadata resolution** — model details (context window, max output tokens, reasoning support, vision support, and per-token pricing) are resolved by matching the Azure catalog model name against [pi-ai](https://npmjs.com/package/@earendil-works/pi-ai)'s built-in model providers. The match is case-insensitive, so `Kimi-K2.7-Code` resolves to pi-ai's `kimi-k2.7-code`.
- **Config overrides** — you can pin or override details for any catalog model via the optional `models` property in `azure-foundry.config.json`. This takes precedence over the pi-ai catalog lookup and is useful for custom deployments, negotiated pricing, or models not yet in pi-ai. See the example below.
- **Routing** — Anthropic deployments are routed to `/anthropic/v1/messages` (native Messages API with tool use and extended thinking). All other deployments use `/openai/deployments/{id}/chat/completions` (OpenAI-compatible). Newer GPT-5/o-series models use `max_completion_tokens` instead of `max_tokens`; this is inferred from model name or set explicitly in `models` config overrides.
- **History repair** — before each request the conversation is passed through pi-ai's `transformMessages`, the same pre-pass pi's built-in providers use. Aborted turns with unanswered tool calls get a synthetic error result, and empty assistant turns are dropped, so an interrupted session keeps working.
- **Reasoning control** — Azure Foundry defaults to *no* reasoning on the OpenAI-compatible route unless `reasoning_effort` is sent, and model families disagree on which values they accept. The extension maps pi's thinking level through the catalog's per-model `thinkingLevelMap`: the level is clamped to one the model supports, then sent as `reasoning_effort`. When thinking is off, a model whose map says `off → "none"` gets `"none"`; any other model gets no field at all, which avoids a 400 on models that reject `"none"`. Models the catalog marks as not accepting `reasoning_effort` (Kimi) never receive it and reason by default. Override `thinkingLevelMap` or `supportsReasoningEffort` per model in the `models` config if a deployment behaves differently.
- **Reasoning output** — on the OpenAI-compatible route, `reasoning_content` / `reasoning` / `reasoning_text` deltas (DeepSeek, Kimi, and similar) are surfaced as thinking blocks in pi. DeepSeek also gets `reasoning_content` replayed on prior assistant turns, which it requires once thinking is on.
- **Output cap** — on the OpenAI-compatible route no `max_tokens` / `max_completion_tokens` is sent unless the caller sets one, matching pi's built-in OpenAI provider. Some catalog `maxTokens` values equal the full context window (Kimi), and Azure rejects `input + max_tokens > window` with a 400. The Anthropic route always sends `max_tokens` because that API requires it.
- **History repair** — before each request the conversation is passed through pi-ai's `transformMessages`, the same pre-pass pi's built-in providers use. Aborted turns with unanswered tool calls get a synthetic error result, and empty assistant turns are dropped, so an interrupted session keeps working.
- **Reasoning output** — on the OpenAI-compatible route, `reasoning_content` / `reasoning` deltas (DeepSeek, Kimi, and similar) are surfaced as thinking blocks in pi.
- **Auth headers** — API key auth sends `api-key: <key>` on the OpenAI route and `Authorization: Bearer <key>` on the Anthropic route. Azure identity sends `Authorization: Bearer <entra-token>` on both. Tokens are cached and refreshed automatically 5 minutes before expiry.

---

## Supported models

The extension auto-discovers whatever is deployed in your Foundry project. Known models are resolved through [pi-ai](https://npmjs.com/package/@earendil-works/pi-ai)'s built-in provider catalogs (Anthropic, OpenAI, MoonshotAI, Mistral, DeepSeek, xAI, and their regional variants).

Any deployment whose catalog model name can't be matched falls back to conservative defaults (128K context / 4K output / text-only / no reasoning / no cost). To override or plug a gap, add an entry under the `models` key in `azure-foundry.config.json`.

### Overriding model details

The `models` section lets you override any subset of the resolved metadata for a specific Azure catalog model. The key must match the **Azure model name** exactly (e.g. `Kimi-K2.7-Code`). Any omitted fields are kept from the pi-ai catalog or fallback defaults.

```json
{
  "resourceId": "my-resource-eastus2",
  "projectId": "my-project-eastus2",
  "auth": {
    "type": "api-key",
    "apiKey": "your-api-key-here"
  },
  "models": {
    "Kimi-K2.7-Code": {
      "contextWindow": 262144,
      "maxTokens": 32768,
      "reasoning": true,
      "input": ["text", "image"],
      "cost": {
        "input": 0.95,
        "output": 4.0,
        "cacheRead": 0.19,
        "cacheWrite": 0
      },
      "openaiTokenLimit": "max_tokens",
      "supportsReasoningEffort": false
    },
    "grok-4.6": {
      "thinkingLevelMap": { "off": null, "low": "low", "medium": "medium", "high": "high" }
    }
  }
}
```

Supported override fields:

| Field | Type | Purpose |
|---|---|---|
| `contextWindow` | number | Model context window in tokens |
| `maxTokens` | number | Maximum output tokens per request |
| `reasoning` | boolean | Whether the model emits reasoning/thinking content |
| `input` | `["text"]`, `["text", "image"]`, etc. | Supported input modalities |
| `cost` | `{ input, output, cacheRead?, cacheWrite? }` | Per-1M-token pricing in USD |
| `openaiTokenLimit` | `"max_tokens"` or `"max_completion_tokens"` | Which field pi sends for the output token limit |
| `thinkingLevelMap` | `{ off?, minimal?, low?, medium?, high?, xhigh?, max? }` → string or `null` | pi thinking level → wire `reasoning_effort`. `null` hides a level. A string under `off` (e.g. `"none"`) is sent when thinking is off; `null`/absent sends nothing |
| `supportsReasoningEffort` | boolean | Set `false` for models that reject or ignore `reasoning_effort` (the field is then never sent) |

Common use-cases include fixing stale data in the `pi-ai` catalog, setting custom parameters configured in Foundry (e.g. `maxTokens`), or ensuring cost estimates reflect special pricing from a negotiated arrangement with Microsoft Azure.

```json
"models": {
  "Kimi-K2.7-Code": {
    "maxTokens": 32768
  }
}
```

---

## Development

### Testing

`npm test` builds the extension and runs two offline suites. No Azure account is needed.

- `test/converters.test.mjs` — message conversion for both routes: interrupted turns, unanswered tool calls, empty thinking blocks, tool-call-only turns, and multi-tool turns.
- `test/extension.test.mjs` — loads the built extension with a fake pi host and a mocked `fetch`. It covers deployment discovery, catalog / override / fallback metadata resolution, route selection and token-limit field, gateway URL and header precedence, SSE parsing across chunk boundaries, streaming of text, reasoning, and tool calls on both routes, usage and cost, and error handling.

CI runs both suites on Node 22 and 24 for every pull request.

Before each release the extension is also checked against a live Azure AI Foundry project through pi in non-interactive mode. The last check ran on pi 0.78.0 against seven deployments (Claude, GPT, Kimi, and DeepSeek) and covered a plain reply plus a tool-call round trip on both the Anthropic and the OpenAI-compatible route:

```bash
pi -ne -e ./dist/index.js -p --no-session --model azure-foundry/<deployment> "Reply with exactly the word OK."
```

```bash
git clone https://github.com/nquandt/pi-azure-foundry
cd pi-azure-foundry
npm install
npm run build

# Test against your own config
cp azure-foundry.config.example.json azure-foundry.config.json
# edit azure-foundry.config.json with your real values
pi -e .
```

```bash
npm run dev       # watch mode
npm run type-check  # type check without building
```

---

## License

MIT
