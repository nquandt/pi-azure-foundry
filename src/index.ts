/**
 * Azure Foundry Extension
 *
 * Discovers models from Azure AI Foundry Deployments API and registers them with pi.
 * Routes to the correct API based on model publisher:
 *   - Anthropic → native Messages API at /anthropic/v1/messages
 *   - OpenAI/others → OpenAI-compat at /openai/deployments/{id}/chat/completions
 *
 * Config: ./azure-foundry.config.json
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type Api,
  type Message,
  type Tool,
  type TextContent,
  type ImageContent,
  type ThinkingContent,
  type ToolResultMessage,
  calculateCost,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { DefaultAzureCredential, type AccessToken } from "@azure/identity";

// =============================================================================
// Config & Types
// =============================================================================

type AuthConfig =
  | { type: "api-key"; apiKey: string }
  | { type: "azure-identity" };

interface Config {
  resourceId: string;
  projectId: string;
  auth: AuthConfig;
  /** Optional APIM gateway URL to route streaming requests through (e.g. https://your-gw.azure-api.net/resource-path) */
  apimGatewayUrl?: string;
}

// =============================================================================
// Token Provider
// =============================================================================

/** Azure AI Foundry scope for Entra ID tokens */
const AZURE_AI_SCOPE = "https://ai.azure.com/.default";

/** Cached token — refreshed when within 5 min of expiry */
let cachedToken: AccessToken | null = null;

async function getIdentityToken(): Promise<string> {
  const now = Date.now();
  const expiryBuffer = 5 * 60 * 1000; // 5 minutes
  if (cachedToken && cachedToken.expiresOnTimestamp - now > expiryBuffer) {
    return cachedToken.token;
  }
  const credential = new DefaultAzureCredential();
  cachedToken = await credential.getToken(AZURE_AI_SCOPE);
  if (!cachedToken) throw new Error("[Azure Foundry] Failed to acquire identity token");
  return cachedToken.token;
}

/**
 * Returns a token getter function appropriate for the configured auth type.
 * For api-key: always returns the static key.
 * For azure-identity: fetches/caches an Entra ID token via DefaultAzureCredential.
 */
function makeTokenGetter(auth: AuthConfig): () => Promise<string> {
  if (auth.type === "api-key") {
    return () => Promise.resolve(auth.apiKey);
  }
  return getIdentityToken;
}

interface Deployment {
  name: string;
  modelName?: string;
  modelPublisher?: string;
  capabilities?: Record<string, string>;
}

function loadConfig(): Config {
  // Search order: project root → ~/.pi/azure-foundry.config.json
  const candidates = [
    resolve(process.cwd(), "azure-foundry.config.json"),
    resolve(homedir(), ".pi", "azure-foundry.config.json"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      console.log(`[Azure Foundry] Loading config from: ${p}`);
      return JSON.parse(readFileSync(p, "utf-8"));
    }
  }
  throw new Error(
    `azure-foundry.config.json not found. Checked:\n` +
    candidates.map((p) => `  ${p}`).join("\n") +
    `\n\nCreate one in your project root or at ~/.pi/azure-foundry.config.json`
  );
}

// =============================================================================
// Deployment → Model mapping
// =============================================================================

type OpenAITokenLimitParam = "max_tokens" | "max_completion_tokens";

interface ModelDefaults {
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: ("text" | "image")[];
  /** OpenAI-compat token limit field; newer GPT-5/o-series models require max_completion_tokens */
  openaiTokenLimit?: OpenAITokenLimitParam;
}

const MODEL_DEFAULTS: Record<string, ModelDefaults> = {
  "claude-sonnet-4-5":  { contextWindow: 200000, maxTokens: 16384, reasoning: true,  input: ["text", "image"] },
  "claude-sonnet-4-6":  { contextWindow: 200000, maxTokens: 16384, reasoning: true,  input: ["text", "image"] },
  "claude-haiku-4-5":   { contextWindow: 200000, maxTokens: 16384, reasoning: false, input: ["text", "image"] },
  "claude-opus-4-5":    { contextWindow: 200000, maxTokens: 32000, reasoning: true,  input: ["text", "image"] },
  "gpt-5.4-nano":       { contextWindow: 128000, maxTokens: 16384, reasoning: false, input: ["text", "image"], openaiTokenLimit: "max_completion_tokens" },
  "gpt-4o":             { contextWindow: 128000, maxTokens: 4096,  reasoning: false, input: ["text", "image"] },
  "gpt-4o-mini":        { contextWindow: 128000, maxTokens: 4096,  reasoning: false, input: ["text", "image"] },
  "Kimi-K2.5":          { contextWindow: 131072, maxTokens: 8192,  reasoning: false, input: ["text"] },
  "Kimi-K2.6":          { contextWindow: 131072, maxTokens: 8192,  reasoning: false, input: ["text"] },
};
const FALLBACK: ModelDefaults = { contextWindow: 128000, maxTokens: 4096, reasoning: false, input: ["text"] };

/** Per-deployment API route resolved at discovery time */
type ApiRoute =
  | { kind: "anthropic-messages" }
  | { kind: "openai-chat-completions"; tokenLimit: OpenAITokenLimitParam };

const apiRouteMap = new Map<string, ApiRoute>();

/** Infer OpenAI-compat token limit from model name when not explicitly configured */
function inferOpenAITokenLimit(modelName: string): OpenAITokenLimitParam {
  if (MODEL_DEFAULTS[modelName]?.openaiTokenLimit) return MODEL_DEFAULTS[modelName].openaiTokenLimit!;
  // GPT-5 and o-series models reject max_tokens on Azure/OpenAI chat completions
  if (/^(gpt-5|o[1-9])([-.]|$)/i.test(modelName)) return "max_completion_tokens";
  return "max_tokens";
}

function resolveApiRoute(d: Deployment): ApiRoute {
  if (d.modelPublisher === "Anthropic") return { kind: "anthropic-messages" };
  const modelName = d.modelName ?? d.name;
  return { kind: "openai-chat-completions", tokenLimit: inferOpenAITokenLimit(modelName) };
}

function describeApiRoute(route: ApiRoute): string {
  if (route.kind === "anthropic-messages") return "anthropic-messages";
  return `openai-chat-completions (${route.tokenLimit})`;
}

/** Auth context per-provider, keyed by provider id */
interface ProviderAuth {
  type: AuthConfig["type"];
  getToken: () => Promise<string>;
}
const providerAuthMap = new Map<string, ProviderAuth>();

/** APIM gateway URL override — if set, streaming requests route through it instead of the Foundry API */
let APIM_GATEWAY_URL = "";

/** Custom HTTP headers injected into every streaming request. Set via PI_AZURE_POST_HEADERS env var.
 *  Format: "HeaderName:value1,HeaderName2:value2" */
function parseCustomHeaders(): Record<string, string> {
  const raw = process.env.PI_AZURE_POST_HEADERS;
  if (!raw) return {};

  const headers: Record<string, string> = {};
  const pairs = raw.split(",");

  for (const pair of pairs) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) throw new Error(
      `[Azure Foundry] PI_AZURE_POST_HEADERS: invalid format "${trimmed}" — expected "Header:Value"`
    );
    const name = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    if (!name || !value) throw new Error(
      `[Azure Foundry] PI_AZURE_POST_HEADERS: header "${trimmed}" has empty name or value`
    );
    const lc = name.toLowerCase();
    const builtIn = new Set(["authorization", "content-type", "anthropic-version"]);
    if (builtIn.has(lc)) throw new Error(
      `[Azure Foundry] PI_AZURE_POST_HEADERS: "${name}" collides with a built-in header that this extension sets`
    );
    headers[name] = value;
  }

  const summary = Object.entries(headers)
    .map(([k, v]) => `${k}:${v.slice(0, 20)}${v.length > 20 ? "…" : ""}`)
    .join(", ");
  console.log(`[Azure Foundry] PI_AZURE_POST_HEADERS: ${Object.keys(headers).length} header(s) — ${summary}`);

  return headers;
}

function deploymentToModel(d: Deployment) {
  const modelName = d.modelName ?? d.name;
  const defaults = MODEL_DEFAULTS[modelName] ?? FALLBACK;
  apiRouteMap.set(d.name, resolveApiRoute(d));
  return {
    id: d.name,
    name: d.modelName ?? d.name,
    reasoning: defaults.reasoning,
    input: defaults.input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: defaults.contextWindow,
    maxTokens: defaults.maxTokens,
  };
}

// =============================================================================
// SSE Stream Parser
// =============================================================================

async function* parseSSE(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data: ")) {
        const data = trimmed.slice(6);
        if (data === "[DONE]") return;
        yield data;
      }
    }
  }
}

// =============================================================================
// OpenAI-format message conversion  (for OpenAI / MoonshotAI / etc.)
// =============================================================================

function toOpenAIMessages(systemPrompt: string | undefined, messages: Message[]): unknown[] {
  const out: unknown[] = [];
  if (systemPrompt) out.push({ role: "system", content: systemPrompt });

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        out.push({ role: "user", content: msg.content });
      } else {
        out.push({ role: "user", content: msg.content.map((c) =>
          c.type === "text"  ? { type: "text", text: (c as TextContent).text } :
          c.type === "image" ? { type: "image_url", image_url: { url: `data:${(c as ImageContent).mimeType};base64,${(c as ImageContent).data}` } } :
          { type: "text", text: "" }
        )});
      }
    } else if (msg.role === "assistant") {
      const entry: Record<string, unknown> = { role: "assistant" };
      const text = msg.content.filter((b) => b.type === "text").map((b) => (b as TextContent).text).join("\n");
      const tcs = msg.content.filter((b) => b.type === "toolCall").map((b) => ({
        id: (b as any).id, type: "function", function: { name: (b as any).name, arguments: JSON.stringify((b as any).arguments) },
      }));
      if (text) entry.content = text;
      if (tcs.length) entry.tool_calls = tcs;
      out.push(entry);
    } else if (msg.role === "toolResult") {
      const m = msg as ToolResultMessage;
      out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content.filter((c): c is TextContent => c.type === "text").map((c) => c.text).join("\n") });
    }
  }
  return out;
}

function toOpenAITools(tools: Tool[]): unknown[] {
  return tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

// =============================================================================
// Anthropic-format message conversion
// =============================================================================

function toAnthropicMessages(messages: Message[]): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        out.push({ role: "user", content: msg.content });
      } else {
        out.push({ role: "user", content: msg.content.map((c) =>
          c.type === "text" ? { type: "text", text: (c as TextContent).text } :
          c.type === "image" ? { type: "image", source: { type: "base64", media_type: (c as ImageContent).mimeType, data: (c as ImageContent).data } } :
          { type: "text", text: "" }
        )});
      }
    } else if (msg.role === "assistant") {
      const blocks: unknown[] = [];
      for (const b of msg.content) {
        if (b.type === "text" && (b as TextContent).text.trim()) blocks.push({ type: "text", text: (b as TextContent).text });
        if (b.type === "thinking") blocks.push({ type: "thinking", thinking: (b as ThinkingContent).thinking, signature: (b as ThinkingContent).thinkingSignature ?? "" });
        if (b.type === "toolCall") blocks.push({ type: "tool_use", id: (b as any).id, name: (b as any).name, input: (b as any).arguments });
      }
      if (blocks.length) out.push({ role: "assistant", content: blocks });
    } else if (msg.role === "toolResult") {
      const m = msg as ToolResultMessage;
      const text = m.content.filter((c): c is TextContent => c.type === "text").map((c) => c.text).join("\n");
      // Anthropic tool results go inside a user message
      out.push({ role: "user", content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: text, is_error: m.isError }] });
    }
  }
  return out;
}

function toAnthropicTools(tools: Tool[]): unknown[] {
  return tools.map((t) => ({
    name: t.name, description: t.description,
    input_schema: { type: "object", properties: (t.parameters as any).properties ?? {}, required: (t.parameters as any).required ?? [] },
  }));
}

// =============================================================================
// OpenAI-compatible streaming (OpenAI, MoonshotAI, etc.)
// =============================================================================

function streamOpenAI(
  model: Model<Api>, context: Context, options: SimpleStreamOptions | undefined,
  output: AssistantMessage, stream: ReturnType<typeof createAssistantMessageEventStream>,
  baseHost: string, auth: ProviderAuth, route: Extract<ApiRoute, { kind: "openai-chat-completions" }>,
): Promise<void> {
  return (async () => {
    const url = `${APIM_GATEWAY_URL || baseHost}/openai/deployments/${model.id}/chat/completions?api-version=2024-10-21`;
    const maxOutput = options?.maxTokens ?? model.maxTokens;
    const body: Record<string, unknown> = {
      messages: toOpenAIMessages(context.systemPrompt, context.messages),
      [route.tokenLimit]: maxOutput,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (context.tools?.length) body.tools = toOpenAITools(context.tools);

    const token = await auth.getToken();
    // OpenAI-compat route: api-key auth uses the "api-key" header;
    // Entra ID (azure-identity) uses "Authorization: Bearer".
    const customHeaders = parseCustomHeaders();
    const authHeaders: Record<string, string> =
      auth.type === "api-key"
        ? { "api-key": token, ...customHeaders }
        : { "Authorization": `Bearer ${token}`, ...customHeaders };
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify(body),
      signal: options?.signal,
    });
    if (!response.ok) {
      const t = await response.text().catch(() => "");
      throw new Error(`Azure Foundry ${response.status}: ${t.slice(0, 500)}`);
    }
    if (!response.body) throw new Error("No response body");

    stream.push({ type: "start", partial: output });

    const tcJsonBufs = new Map<number, string>();
    const tcContentIdx = new Map<number, number>();
    const reader = response.body.getReader();

    for await (const data of parseSSE(reader)) {
      let chunk: any;
      try { chunk = JSON.parse(data); } catch { continue; }

      if (chunk.usage) {
        output.usage.input = chunk.usage.prompt_tokens ?? 0;
        output.usage.output = chunk.usage.completion_tokens ?? 0;
        output.usage.totalTokens = chunk.usage.total_tokens ?? 0;
        calculateCost(model, output.usage);
      }

      const choice = chunk.choices?.[0];
      if (!choice?.delta) continue;
      const delta = choice.delta;

      if (typeof delta.content === "string") {
        let idx = output.content.findIndex((b) => b.type === "text");
        if (idx === -1) { output.content.push({ type: "text", text: "" }); idx = output.content.length - 1; stream.push({ type: "text_start", contentIndex: idx, partial: output }); }
        const block = output.content[idx]; if (block.type === "text") { block.text += delta.content; stream.push({ type: "text_delta", contentIndex: idx, delta: delta.content, partial: output }); }
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const tci = tc.index ?? 0;
          if (tc.id) {
            output.content.push({ type: "toolCall", id: tc.id, name: tc.function?.name ?? "", arguments: {} });
            const ci = output.content.length - 1; tcContentIdx.set(tci, ci); tcJsonBufs.set(tci, "");
            stream.push({ type: "toolcall_start", contentIndex: ci, partial: output });
          }
          if (tc.function?.arguments) {
            const ci = tcContentIdx.get(tci); if (ci === undefined) continue;
            const buf = (tcJsonBufs.get(tci) ?? "") + tc.function.arguments; tcJsonBufs.set(tci, buf);
            const block = output.content[ci]; if (block.type === "toolCall") { try { block.arguments = JSON.parse(buf); } catch {} }
            stream.push({ type: "toolcall_delta", contentIndex: ci, delta: tc.function.arguments, partial: output });
          }
        }
      }

      if (choice.finish_reason === "stop") output.stopReason = "stop";
      else if (choice.finish_reason === "length") output.stopReason = "length";
      else if (choice.finish_reason === "tool_calls") output.stopReason = "toolUse";
    }

    // Finalize blocks
    for (let i = 0; i < output.content.length; i++) { if (output.content[i].type === "text") stream.push({ type: "text_end", contentIndex: i, content: (output.content[i] as TextContent).text, partial: output }); }
    for (const [tci, ci] of tcContentIdx) { const b = output.content[ci]; if (b.type === "toolCall") { try { b.arguments = JSON.parse(tcJsonBufs.get(tci) ?? "{}"); } catch {} stream.push({ type: "toolcall_end", contentIndex: ci, toolCall: b, partial: output }); } }
  })();
}

// =============================================================================
// Anthropic Messages API streaming
// =============================================================================

function streamAnthropic(
  model: Model<Api>, context: Context, options: SimpleStreamOptions | undefined,
  output: AssistantMessage, stream: ReturnType<typeof createAssistantMessageEventStream>,
  baseHost: string, auth: ProviderAuth,
): Promise<void> {
  return (async () => {
    const url = APIM_GATEWAY_URL
      ? `${APIM_GATEWAY_URL}/anthropic/v1/messages`
      : `${baseHost}/anthropic/v1/messages`;
    const body: Record<string, unknown> = {
      model: model.id,
      messages: toAnthropicMessages(context.messages),
      max_tokens: options?.maxTokens ?? model.maxTokens,
      stream: true,
    };
    if (context.systemPrompt) body.system = context.systemPrompt;
    if (context.tools?.length) body.tools = toAnthropicTools(context.tools);

    const token = await auth.getToken();
    // Anthropic route on Azure Foundry always uses "Authorization: Bearer"
    // regardless of auth type — api-key values are valid Bearer tokens here.
    const customHeaders = parseCustomHeaders();
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
        ...customHeaders,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    });
    if (!response.ok) {
      const t = await response.text().catch(() => "");
      throw new Error(`Azure Foundry ${response.status}: ${t.slice(0, 500)}`);
    }
    if (!response.body) throw new Error("No response body");

    stream.push({ type: "start", partial: output });

    // Anthropic SSE events: message_start, content_block_start, content_block_delta, content_block_stop, message_delta, message_stop
    const blockIndices = new Map<number, number>(); // anthropic block index → output.content index
    const tcJsonBufs = new Map<number, string>();
    const reader = response.body.getReader();

    for await (const data of parseSSE(reader)) {
      let event: any;
      try { event = JSON.parse(data); } catch { continue; }

      if (event.type === "message_start" && event.message?.usage) {
        output.usage.input = event.message.usage.input_tokens ?? 0;
        output.usage.cacheRead = event.message.usage.cache_read_input_tokens ?? 0;
        output.usage.cacheWrite = event.message.usage.cache_creation_input_tokens ?? 0;
      }

      if (event.type === "content_block_start") {
        const cb = event.content_block;
        const anthropicIdx = event.index;
        if (cb.type === "text") {
          output.content.push({ type: "text", text: "" });
          const ci = output.content.length - 1;
          blockIndices.set(anthropicIdx, ci);
          stream.push({ type: "text_start", contentIndex: ci, partial: output });
        } else if (cb.type === "thinking") {
          output.content.push({ type: "thinking", thinking: "", thinkingSignature: "" } as ThinkingContent);
          blockIndices.set(anthropicIdx, output.content.length - 1);
          stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
        } else if (cb.type === "tool_use") {
          output.content.push({ type: "toolCall", id: cb.id, name: cb.name, arguments: {} });
          const ci = output.content.length - 1;
          blockIndices.set(anthropicIdx, ci);
          tcJsonBufs.set(anthropicIdx, "");
          stream.push({ type: "toolcall_start", contentIndex: ci, partial: output });
        }
      }

      if (event.type === "content_block_delta") {
        const ci = blockIndices.get(event.index);
        if (ci === undefined) continue;
        const block = output.content[ci];
        const d = event.delta;

        if (d.type === "text_delta" && block.type === "text") {
          block.text += d.text;
          stream.push({ type: "text_delta", contentIndex: ci, delta: d.text, partial: output });
        } else if (d.type === "thinking_delta" && block.type === "thinking") {
          (block as ThinkingContent).thinking += d.thinking;
          stream.push({ type: "thinking_delta", contentIndex: ci, delta: d.thinking, partial: output });
        } else if (d.type === "signature_delta" && block.type === "thinking") {
          (block as ThinkingContent).thinkingSignature = ((block as ThinkingContent).thinkingSignature ?? "") + d.signature;
        } else if (d.type === "input_json_delta" && block.type === "toolCall") {
          const buf = (tcJsonBufs.get(event.index) ?? "") + d.partial_json;
          tcJsonBufs.set(event.index, buf);
          try { block.arguments = JSON.parse(buf); } catch {}
          stream.push({ type: "toolcall_delta", contentIndex: ci, delta: d.partial_json, partial: output });
        }
      }

      if (event.type === "content_block_stop") {
        const ci = blockIndices.get(event.index);
        if (ci === undefined) continue;
        const block = output.content[ci];
        if (block.type === "text") stream.push({ type: "text_end", contentIndex: ci, content: block.text, partial: output });
        else if (block.type === "thinking") stream.push({ type: "thinking_end", contentIndex: ci, content: (block as ThinkingContent).thinking, partial: output });
        else if (block.type === "toolCall") {
          try { block.arguments = JSON.parse(tcJsonBufs.get(event.index) ?? "{}"); } catch {}
          stream.push({ type: "toolcall_end", contentIndex: ci, toolCall: block, partial: output });
        }
      }

      if (event.type === "message_delta") {
        if (event.usage) {
          output.usage.output = event.usage.output_tokens ?? 0;
          output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
          calculateCost(model, output.usage);
        }
        const sr = event.delta?.stop_reason;
        if (sr === "end_turn" || sr === "stop_sequence") output.stopReason = "stop";
        else if (sr === "max_tokens") output.stopReason = "length";
        else if (sr === "tool_use") output.stopReason = "toolUse";
      }
    }
  })();
}

// =============================================================================
// Unified streamSimple — routes based on publisher
// =============================================================================

function streamAzureFoundry(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    try {
      const baseHost = new URL(model.baseUrl).origin;
      const route = apiRouteMap.get(model.id) ?? { kind: "openai-chat-completions", tokenLimit: "max_tokens" };
      // Resolve auth: use registered provider auth, fall back to api-key from options.
      const auth: ProviderAuth = providerAuthMap.get(model.provider)
        ?? { type: "api-key", getToken: () => Promise.resolve(options?.apiKey ?? "") };

      if (route.kind === "anthropic-messages") {
        await streamAnthropic(model, context, options, output, stream, baseHost, auth);
      } else {
        await streamOpenAI(model, context, options, output, stream, baseHost, auth, route);
      }

      stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default async function (pi: ExtensionAPI) {
  const config = loadConfig();
  const endpoint = `https://${config.resourceId}.services.ai.azure.com/api/projects/${config.projectId}`;

  // Discover deployments
  const url = `${endpoint}/deployments?api-version=v1`;
  console.log(`[Azure Foundry] Fetching deployments from: ${url}`);

  const getToken = makeTokenGetter(config.auth);
  console.log(`[Azure Foundry] Auth: ${config.auth.type}`);

  const token = await getToken();
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) { const b = await response.text().catch(() => ""); throw new Error(`Azure Foundry API ${response.status}: ${b.slice(0, 200)}`); }

  const data = (await response.json()) as { value?: Deployment[] };
  const deployments = (data.value ?? []).filter((d) => d.capabilities?.chat_completion === "true");
  if (deployments.length === 0) throw new Error("No chat-capable deployments found");

  const models = deployments.map(deploymentToModel);

  const summary = deployments.map((d) => {
    const route = apiRouteMap.get(d.name)!;
    return `${d.name} (${d.modelPublisher}, ${describeApiRoute(route)})`;
  }).join(", ");
  console.log(`[Azure Foundry] Found ${deployments.length} deployment(s): ${summary}`);

  for (const d of deployments) {
    const modelName = d.modelName ?? d.name;
    if (MODEL_DEFAULTS[modelName]) continue;
    const route = apiRouteMap.get(d.name)!;
    console.log(`[Azure Foundry] ${d.name}: no explicit defaults for "${modelName}" — using ${describeApiRoute(route)}`);
  }

  const providerId = "azure-foundry";
  // Store the auth context so streamAzureFoundry can build the right headers per-request.
  providerAuthMap.set(providerId, { type: config.auth.type, getToken });

  // Support APIM gateway override — if set in config, route streaming through it
  if (config.apimGatewayUrl) {
    APIM_GATEWAY_URL = config.apimGatewayUrl.replace(/\/$/, "");
    console.log(`[Azure Foundry] APIM gateway enabled: ${APIM_GATEWAY_URL}`);
  }

  pi.registerProvider(providerId, {
    name: "Azure Foundry",
    baseUrl: endpoint,
    // For api-key auth, store the real key. For azure-identity, pass a sentinel
    // so pi's required-field validation passes — tokens are always fetched at
    // request time via providerAuthMap and this value is never used.
    apiKey: config.auth.type === "api-key" ? config.auth.apiKey : "azure-identity",
    api: "azure-foundry" as Api,
    streamSimple: streamAzureFoundry,
    models,
  });

  console.log(`[Azure Foundry] ✓ Registered ${deployments.length} model(s)`);
}
