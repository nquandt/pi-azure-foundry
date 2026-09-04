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
  type ModelCost,
  calculateCost,
  clampThinkingLevel,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";
import { MISTRAL_MODELS } from "@earendil-works/pi-ai/providers/mistral.models";
import { FIREWORKS_MODELS } from "@earendil-works/pi-ai/providers/fireworks.models";
import { HUGGINGFACE_MODELS } from "@earendil-works/pi-ai/providers/huggingface.models";
import { ZAI_MODELS } from "@earendil-works/pi-ai/providers/zai.models";
import { MINIMAX_MODELS } from "@earendil-works/pi-ai/providers/minimax.models";
import { DEEPSEEK_MODELS } from "@earendil-works/pi-ai/providers/deepseek.models";
import { XAI_MODELS } from "@earendil-works/pi-ai/providers/xai.models";
import { MOONSHOTAI_MODELS } from "@earendil-works/pi-ai/providers/moonshotai.models";
import { MOONSHOTAI_CN_MODELS } from "@earendil-works/pi-ai/providers/moonshotai-cn.models";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
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

type OpenAITokenLimitParam = "max_tokens" | "max_completion_tokens";

interface ModelConfigOverride {
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  cost?: ModelCost;
  openaiTokenLimit?: OpenAITokenLimitParam;
  /**
   * pi thinking level → wire `reasoning_effort` value. `null` means the level is
   * not offered; a string for `off` is sent when reasoning is disabled (e.g.
   * "none"); an absent/`null` `off` sends nothing when reasoning is disabled.
   */
  thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
  /** Whether to send `reasoning_effort` on the OpenAI-compatible route at all. */
  supportsReasoningEffort?: boolean;
}

interface Config {
  resourceId: string;
  projectId: string;
  auth: AuthConfig;
  models?: Record<string, ModelConfigOverride>;
  /**
   * Optional gateway base URL (e.g. an Azure API Management front door such as
   * https://my-gw.azure-api.net/foundry). When set, chat requests are sent to
   * this host instead of the Foundry endpoint. Deployment discovery still uses
   * the Foundry endpoint. The same route paths are appended in both cases.
   */
  gatewayUrl?: string;
  /**
   * Optional extra HTTP headers sent on every chat request (e.g. an APIM
   * subscription key). Auth headers set by the extension always take precedence.
   */
  headers?: Record<string, string>;
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

interface ResolvedModelDetails {
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: ModelCost;
  thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
  openaiTokenLimit?: OpenAITokenLimitParam;
  /** Send `reasoning_effort` on the OpenAI-compatible route (catalog compat default: true). */
  supportsReasoningEffort: boolean;
  /** Model needs `reasoning_content` on replayed assistant turns (DeepSeek). */
  requiresReasoningContent: boolean;
  source: "config" | "catalog" | "fallback";
}

const ZERO_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const FALLBACK: ResolvedModelDetails = {
  contextWindow: 128000,
  maxTokens: 4096,
  reasoning: false,
  input: ["text"],
  cost: ZERO_COST,
  supportsReasoningEffort: true,
  requiresReasoningContent: false,
  source: "fallback",
};

/** Lower-case a model/catalog name so Azure and pi-ai ids can be matched. */
function normalizeModelName(name: string): string {
  return name.toLowerCase();
}

/** Build a map from normalized model id to pi-ai's built-in model metadata. */
function buildKnownModelCatalog(): Map<string, Model<Api>> {
  const catalog = new Map<string, Model<Api>>();
  const providerCatalogs = [
    ANTHROPIC_MODELS,
    OPENAI_MODELS,
    MISTRAL_MODELS,
    FIREWORKS_MODELS,
    HUGGINGFACE_MODELS,
    ZAI_MODELS,
    MINIMAX_MODELS,
    DEEPSEEK_MODELS,
    XAI_MODELS,
    MOONSHOTAI_MODELS,
    MOONSHOTAI_CN_MODELS,
  ];
  for (const models of providerCatalogs) {
    for (const model of Object.values(models)) {
      const key = normalizeModelName(model.id);
      if (catalog.has(key)) continue;
      catalog.set(key, model as Model<Api>);
    }
  }
  return catalog;
}

/**
 * Resolve model details in precedence order:
 *   1. User override in azure-foundry.config.json (exact Azure modelName)
 *   2. pi-ai built-in model catalog (normalized id match)
 *   3. Conservative fallback defaults
 */
function resolveModelDetails(
  modelName: string,
  catalog: Map<string, Model<Api>>,
  overrides: Record<string, ModelConfigOverride> | undefined,
): ResolvedModelDetails {
  const override = overrides?.[modelName];
  const catalogModel = catalog.get(normalizeModelName(modelName));

  // Start with catalog metadata, or the conservative fallback if unknown.
  const base: ResolvedModelDetails = catalogModel
    ? (() => {
        const compat = (catalogModel as any).compat ?? {};
        const compatMaxTokensField = compat.maxTokensField;
        return {
          supportsReasoningEffort: compat.supportsReasoningEffort !== false,
          requiresReasoningContent: compat.requiresReasoningContentOnAssistantMessages === true,
          contextWindow: catalogModel.contextWindow,
          maxTokens: catalogModel.maxTokens,
          reasoning: catalogModel.reasoning,
          input: catalogModel.input,
          cost: catalogModel.cost,
          thinkingLevelMap: catalogModel.thinkingLevelMap,
          openaiTokenLimit:
            compatMaxTokensField === "max_tokens" || compatMaxTokensField === "max_completion_tokens"
              ? compatMaxTokensField
              : undefined,
          source: "catalog",
        };
      })()
    : FALLBACK;

  if (!override) return base;

  // Apply only the override keys that are present.
  return {
    ...base,
    ...override,
    cost: {
      ...base.cost,
      ...override.cost // spreading undefined in JS is fine
    },
    source: "config",
  };
}

/** Per-deployment API route resolved at discovery time */
interface OpenAIReasoningPolicy {
  /** Model reasons and accepts `reasoning_effort`. */
  enabled: boolean;
  thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
  /** Replay `reasoning_content` on assistant turns (DeepSeek requires it). */
  replayReasoningContent: boolean;
}

type ApiRoute =
  | { kind: "anthropic-messages" }
  | { kind: "openai-chat-completions"; tokenLimit: OpenAITokenLimitParam; reasoning: OpenAIReasoningPolicy };

const apiRouteMap = new Map<string, ApiRoute>();

/** Infer OpenAI-compat token limit from resolved metadata or model name patterns. */
function inferOpenAITokenLimit(modelName: string, resolved: ResolvedModelDetails): OpenAITokenLimitParam {
  if (resolved.openaiTokenLimit) return resolved.openaiTokenLimit;
  // GPT-5 and o-series models reject max_tokens on Azure/OpenAI chat completions
  if (/^(gpt-5|o[1-9])([-.]|$)/i.test(modelName)) return "max_completion_tokens";
  return "max_tokens";
}

function resolveApiRoute(d: Deployment, resolved: ResolvedModelDetails): ApiRoute {
  if (d.modelPublisher === "Anthropic") return { kind: "anthropic-messages" };
  const modelName = d.modelName ?? d.name;
  return {
    kind: "openai-chat-completions",
    tokenLimit: inferOpenAITokenLimit(modelName, resolved),
    reasoning: {
      enabled: resolved.reasoning && resolved.supportsReasoningEffort,
      thinkingLevelMap: resolved.thinkingLevelMap,
      replayReasoningContent: resolved.requiresReasoningContent,
    },
  };
}

/**
 * Resolve the wire `reasoning_effort` for a request, or undefined to omit it.
 *
 * Foundry defaults to no reasoning when the field is absent, and families
 * disagree on which values they accept. The catalog's thinkingLevelMap encodes
 * that: pi's level is clamped to a supported one, then mapped to the wire
 * value. For "off", a string mapping (e.g. "none") is sent; null/absent sends
 * nothing, which matters for models that reject "none".
 */
function resolveReasoningEffort(policy: OpenAIReasoningPolicy, requested: SimpleStreamOptions["reasoning"]): string | undefined {
  if (!policy.enabled) return undefined;
  const map = policy.thinkingLevelMap;
  const probe = { reasoning: true, thinkingLevelMap: map } as Model<Api>;
  const level = requested ? clampThinkingLevel(probe, requested) : "off";
  const mapped = map?.[level];
  if (level === "off") return typeof mapped === "string" ? mapped : undefined;
  if (mapped === null) return undefined;
  return mapped ?? level;
}

function describeApiRoute(route: ApiRoute): string {
  if (route.kind === "anthropic-messages") return "anthropic-messages";
  return `openai-chat-completions (${route.tokenLimit})`;
}

/** Auth context per-provider, keyed by provider id */
interface ProviderAuth {
  type: AuthConfig["type"];
  getToken: () => Promise<string>;
  /** Host to send chat requests to. Defaults to the Foundry endpoint origin. */
  gatewayUrl?: string;
  /** Extra headers applied to every chat request, below the auth headers. */
  headers: Record<string, string>;
}
const providerAuthMap = new Map<string, ProviderAuth>();

function deploymentToModel(
  d: Deployment,
  catalog: Map<string, Model<Api>>,
  overrides: Record<string, ModelConfigOverride> | undefined,
) {
  const modelName = d.modelName ?? d.name;
  const details = resolveModelDetails(modelName, catalog, overrides);
  apiRouteMap.set(d.name, resolveApiRoute(d, details));

  const model = {
    id: d.name,
    name: modelName,
    reasoning: details.reasoning,
    input: details.input,
    cost: details.cost,
    contextWindow: details.contextWindow,
    maxTokens: details.maxTokens,
    thinkingLevelMap: details.thinkingLevelMap,
  };

  if (details.source === "fallback") {
    console.log(`[Azure Foundry] ${d.name}: no metadata for "${modelName}" — using fallback defaults`);
  } else if (details.source === "config") {
    console.log(`[Azure Foundry] ${d.name}: using config override for "${modelName}"`);
  }

  return model;
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
// Shared conversion helpers
// =============================================================================

/**
 * pi passes systemPrompt as a string. Some pi forks (OMP) pass a string array.
 * Collapse to one string so neither route forwards a shape the API rejects.
 */
function normalizeSystemPrompt(sp: unknown): string | undefined {
  if (Array.isArray(sp)) { const joined = sp.filter((x) => typeof x === "string" && x).join("\n"); return joined || undefined; }
  return typeof sp === "string" && sp ? sp : undefined;
}

/** Some hosts put bare strings inside user content arrays; treat them as text blocks. */
function asTextIfString(c: unknown): { type: "text"; text: string } | undefined {
  return typeof c === "string" ? { type: "text", text: c } : undefined;
}

// =============================================================================
// OpenAI-format message conversion  (for OpenAI / MoonshotAI / etc.)
// =============================================================================

function toOpenAIMessages(
  systemPrompt: string | string[] | undefined, messages: Message[], opts: { replayReasoningContent?: boolean } = {},
): unknown[] {
  const out: unknown[] = [];
  const sys = normalizeSystemPrompt(systemPrompt);
  if (sys) out.push({ role: "system", content: sys });

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        out.push({ role: "user", content: msg.content });
      } else {
        out.push({ role: "user", content: msg.content.map((c) =>
          asTextIfString(c) ??
          (c.type === "text"  ? { type: "text", text: (c as TextContent).text } :
          c.type === "image" ? { type: "image_url", image_url: { url: `data:${(c as ImageContent).mimeType};base64,${(c as ImageContent).data}` } } :
          { type: "text", text: "" })
        )});
      }
    } else if (msg.role === "assistant") {
      const entry: Record<string, unknown> = { role: "assistant" };
      const text = msg.content.filter((b) => b.type === "text").map((b) => (b as TextContent).text).join("\n");
      const tcs = msg.content.filter((b) => b.type === "toolCall").map((b) => ({
        id: (b as any).id, type: "function", function: { name: (b as any).name, arguments: JSON.stringify((b as any).arguments) },
      }));
      // Always a string: Azure rejects a null/absent content on an assistant
      // turn, which a tool-call-only turn would otherwise produce.
      entry.content = text;
      if (tcs.length) entry.tool_calls = tcs;
      // DeepSeek rejects replayed assistant turns without reasoning_content
      // once thinking is on; an empty string is accepted.
      if (opts.replayReasoningContent) {
        entry.reasoning_content = msg.content.filter((b) => b.type === "thinking").map((b) => (b as ThinkingContent).thinking).join("\n");
      }
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
          asTextIfString(c) ??
          (c.type === "text" ? { type: "text", text: (c as TextContent).text } :
          c.type === "image" ? { type: "image", source: { type: "base64", media_type: (c as ImageContent).mimeType, data: (c as ImageContent).data } } :
          { type: "text", text: "" })
        )});
      }
    } else if (msg.role === "assistant") {
      const blocks: unknown[] = [];
      for (const b of msg.content) {
        if (b.type === "text" && (b as TextContent).text.trim()) blocks.push({ type: "text", text: (b as TextContent).text });
        // Anthropic rejects a thinking block with empty text, and one with a
        // missing signature. Replay only blocks that have both.
        if (b.type === "thinking") {
          const t = b as ThinkingContent;
          if (t.thinking.trim() && t.thinkingSignature) blocks.push({ type: "thinking", thinking: t.thinking, signature: t.thinkingSignature });
        }
        if (b.type === "toolCall") blocks.push({ type: "tool_use", id: (b as any).id, name: (b as any).name, input: (b as any).arguments });
      }
      if (blocks.length) out.push({ role: "assistant", content: blocks });
    } else if (msg.role === "toolResult") {
      const m = msg as ToolResultMessage;
      const text = m.content.filter((c): c is TextContent => c.type === "text").map((c) => c.text).join("\n");
      // Anthropic tool results go inside a user message, and every result for a
      // turn must sit in the single user message that follows it. Merge
      // consecutive results into one message instead of emitting one each.
      const block = { type: "tool_result", tool_use_id: m.toolCallId, content: text, is_error: m.isError };
      const prev = out[out.length - 1] as { role?: string; content?: unknown[] } | undefined;
      const prevIsResults = prev?.role === "user" && Array.isArray(prev.content) && prev.content.length > 0
        && prev.content.every((c) => (c as { type?: string }).type === "tool_result");
      if (prevIsResults) prev!.content!.push(block);
      else out.push({ role: "user", content: [block] });
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
    const url = `${auth.gatewayUrl ?? baseHost}/openai/deployments/${model.id}/chat/completions?api-version=2024-10-21`;
    const body: Record<string, unknown> = {
      messages: toOpenAIMessages(context.systemPrompt, transformMessages(context.messages, model), { replayReasoningContent: route.reasoning.replayReasoningContent }),
      stream: true,
      stream_options: { include_usage: true },
    };
    // Only send an output cap when the caller asks for one, as pi-ai's own
    // OpenAI provider does. Some catalog maxTokens values equal the context
    // window (Kimi), and Azure rejects input + max_tokens > window with a 400.
    if (options?.maxTokens) body[route.tokenLimit] = options.maxTokens;
    const effort = resolveReasoningEffort(route.reasoning, options?.reasoning);
    if (effort !== undefined) body.reasoning_effort = effort;
    if (context.tools?.length) body.tools = toOpenAITools(context.tools);

    const token = await auth.getToken();
    // OpenAI-compat route: api-key auth uses the "api-key" header;
    // Entra ID (azure-identity) uses "Authorization: Bearer".
    const authHeaders: Record<string, string> =
      auth.type === "api-key"
        ? { "api-key": token }
        : { "Authorization": `Bearer ${token}` };
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth.headers, ...authHeaders },
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

      // Reasoning deltas: DeepSeek/Kimi use `reasoning_content`, other
      // OpenAI-compatible endpoints use `reasoning` or `reasoning_text`.
      // Surface them as a thinking block, same as pi-ai's own OpenAI provider.
      const reasoningDelta = [delta.reasoning_content, delta.reasoning, delta.reasoning_text]
        .find((r): r is string => typeof r === "string" && r.length > 0);
      if (reasoningDelta) {
        let idx = output.content.findIndex((b) => b.type === "thinking");
        if (idx === -1) { output.content.push({ type: "thinking", thinking: "" } as ThinkingContent); idx = output.content.length - 1; stream.push({ type: "thinking_start", contentIndex: idx, partial: output }); }
        const block = output.content[idx]; if (block.type === "thinking") { (block as ThinkingContent).thinking += reasoningDelta; stream.push({ type: "thinking_delta", contentIndex: idx, delta: reasoningDelta, partial: output }); }
      }

      if (typeof delta.content === "string" && delta.content.length > 0) {
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
    for (let i = 0; i < output.content.length; i++) {
      const b = output.content[i];
      if (b.type === "text") stream.push({ type: "text_end", contentIndex: i, content: (b as TextContent).text, partial: output });
      else if (b.type === "thinking") stream.push({ type: "thinking_end", contentIndex: i, content: (b as ThinkingContent).thinking, partial: output });
    }
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
    const url = `${auth.gatewayUrl ?? baseHost}/anthropic/v1/messages`;
    const body: Record<string, unknown> = {
      model: model.id,
      messages: toAnthropicMessages(transformMessages(context.messages, model)),
      max_tokens: options?.maxTokens ?? model.maxTokens,
      stream: true,
    };
    const sys = normalizeSystemPrompt(context.systemPrompt);
    if (sys) body.system = sys;
    if (context.tools?.length) body.tools = toAnthropicTools(context.tools);

    const token = await auth.getToken();
    // Anthropic route on Azure Foundry always uses "Authorization: Bearer"
    // regardless of auth type — api-key values are valid Bearer tokens here.
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...auth.headers,
        "Authorization": `Bearer ${token}`,
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
      const route = apiRouteMap.get(model.id) ?? { kind: "openai-chat-completions", tokenLimit: "max_tokens", reasoning: { enabled: false, replayReasoningContent: false } };
      // Resolve auth: use registered provider auth, fall back to api-key from options.
      const auth: ProviderAuth = providerAuthMap.get(model.provider)
        ?? { type: "api-key", getToken: () => Promise.resolve(options?.apiKey ?? ""), headers: {} };

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

  const catalog = buildKnownModelCatalog();
  const models = deployments.map((d) => deploymentToModel(d, catalog, config.models));

  const summary = deployments.map((d) => {
    const route = apiRouteMap.get(d.name)!;
    return `${d.name} (${d.modelPublisher}, ${describeApiRoute(route)})`;
  }).join(", ");
  console.log(`[Azure Foundry] Found ${deployments.length} deployment(s): ${summary}`);

  const providerId = "azure-foundry";
  // Store the auth context so streamAzureFoundry can build the right headers per-request.
  const gatewayUrl = config.gatewayUrl?.replace(/\/+$/, "") || undefined;
  if (gatewayUrl) console.log(`[Azure Foundry] Chat requests routed through gateway: ${gatewayUrl}`);
  const headers = config.headers ?? {};
  if (Object.keys(headers).length) console.log(`[Azure Foundry] Extra request headers: ${Object.keys(headers).join(", ")}`);
  providerAuthMap.set(providerId, { type: config.auth.type, getToken, gatewayUrl, headers });

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

// Exported for tests only.
export { toOpenAIMessages, toAnthropicMessages };
