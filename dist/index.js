import { calculateCost, createAssistantMessageEventStream, } from "@earendil-works/pi-ai";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { DefaultAzureCredential } from "@azure/identity";
// =============================================================================
// Token Provider
// =============================================================================
/** Azure AI Foundry scope for Entra ID tokens */
const AZURE_AI_SCOPE = "https://ai.azure.com/.default";
/** Cached token — refreshed when within 5 min of expiry */
let cachedToken = null;
async function getIdentityToken() {
    const now = Date.now();
    const expiryBuffer = 5 * 60 * 1000; // 5 minutes
    if (cachedToken && cachedToken.expiresOnTimestamp - now > expiryBuffer) {
        return cachedToken.token;
    }
    const credential = new DefaultAzureCredential();
    cachedToken = await credential.getToken(AZURE_AI_SCOPE);
    if (!cachedToken)
        throw new Error("[Azure Foundry] Failed to acquire identity token");
    return cachedToken.token;
}
/**
 * Returns a token getter function appropriate for the configured auth type.
 * For api-key: always returns the static key.
 * For azure-identity: fetches/caches an Entra ID token via DefaultAzureCredential.
 */
function makeTokenGetter(auth) {
    if (auth.type === "api-key") {
        return () => Promise.resolve(auth.apiKey);
    }
    return getIdentityToken;
}
function loadConfig() {
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
    throw new Error(`azure-foundry.config.json not found. Checked:\n` +
        candidates.map((p) => `  ${p}`).join("\n") +
        `\n\nCreate one in your project root or at ~/.pi/azure-foundry.config.json`);
}
const MODEL_DEFAULTS = {
    // Claude family
    "claude-sonnet-4-5": { contextWindow: 200000, maxTokens: 16384, reasoning: true, input: ["text", "image"] },
    "claude-sonnet-4-6": { contextWindow: 200000, maxTokens: 16384, reasoning: true, input: ["text", "image"] },
    "claude-haiku-4-5": { contextWindow: 200000, maxTokens: 16384, reasoning: false, input: ["text", "image"] },
    "claude-opus-4-5": { contextWindow: 200000, maxTokens: 32000, reasoning: true, input: ["text", "image"] },
    // GPT family
    "gpt-5-mini": { contextWindow: 400000, maxTokens: 128000, reasoning: true, input: ["text", "image"], openaiTokenLimit: "max_completion_tokens", thinking: { mode: "effort", efforts: ["minimal", "low", "medium", "high"] }, sendEffort: true, defaultEffort: "medium" },
    "gpt-5.4-nano": { contextWindow: 128000, maxTokens: 16384, reasoning: false, input: ["text", "image"], openaiTokenLimit: "max_completion_tokens" },
    "gpt-4o": { contextWindow: 128000, maxTokens: 4096, reasoning: false, input: ["text", "image"] },
    "gpt-4o-mini": { contextWindow: 128000, maxTokens: 4096, reasoning: false, input: ["text", "image"] },
    // Kimi family — K2.5/K2.6 are older non-reasoning defaults kept for backwards compat;
    // K2.7-Code is the current Azure Foundry deployment with full reasoning + vision.
    "Kimi-K2.5": { contextWindow: 131072, maxTokens: 8192, reasoning: false, input: ["text"] },
    "Kimi-K2.6": { contextWindow: 131072, maxTokens: 8192, reasoning: false, input: ["text"] },
    "Kimi-K2.7-Code": { contextWindow: 262144, maxTokens: 262144, reasoning: true, input: ["text", "image"], },
    "kimi-k2.7-code": { contextWindow: 262144, maxTokens: 262144, reasoning: true, input: ["text", "image"], },
    // DeepSeek V4 family — Azure Foundry deployments ship 1M context / 128K output
    // (distinct from upstream catalog which reports 384K output for direct API)
    "DeepSeek-V4-Flash": { contextWindow: 1000000, maxTokens: 128000, reasoning: true, input: ["text"], thinking: { mode: "effort", efforts: ["high", "max"] }, sendEffort: true, defaultEffort: "high" },
    "deepseek-v4-flash": { contextWindow: 1000000, maxTokens: 128000, reasoning: true, input: ["text"], thinking: { mode: "effort", efforts: ["high", "max"] }, sendEffort: true, defaultEffort: "high" },
    "DeepSeek-V4-Pro": { contextWindow: 1000000, maxTokens: 128000, reasoning: true, input: ["text"], thinking: { mode: "effort", efforts: ["high", "max"] }, sendEffort: true, defaultEffort: "high" },
    "deepseek-v4-pro": { contextWindow: 1000000, maxTokens: 128000, reasoning: true, input: ["text"], thinking: { mode: "effort", efforts: ["high", "max"] }, sendEffort: true, defaultEffort: "high" },
    // XAI Grok family — Azure Foundry reports 200K context, 128K max output
    "grok-4.6": { contextWindow: 200000, maxTokens: 128000, reasoning: true, input: ["text", "image"], },
    "grok-4-6": { contextWindow: 200000, maxTokens: 128000, reasoning: true, input: ["text", "image"], },
    "grok-4.6-medium": { contextWindow: 200000, maxTokens: 128000, reasoning: true, input: ["text", "image"], },
};
// Normalised alias index for flexible deployment-name matching (case/separator-insensitive).
// Keys are lower-cased, separator-folded variants pointing at canonical MODEL_DEFAULTS keys.
const MODEL_ALIASES = (() => {
    const aliases = {};
    for (const key of Object.keys(MODEL_DEFAULTS)) {
        const norm = key.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        aliases[norm] = key;
        aliases[norm.replace(/-/g, "")] = key;
        aliases[norm.replace(/-/g, "_")] = key;
    }
    // Explicit cross-punctuation aliases for families that appear under many shapes on Foundry
    aliases["deepseekv4flash"] = "DeepSeek-V4-Flash";
    aliases["deepseek-v4-flash"] = "DeepSeek-V4-Flash";
    aliases["deepseek_v4_flash"] = "DeepSeek-V4-Flash";
    aliases["deepseekv4pro"] = "DeepSeek-V4-Pro";
    aliases["deepseek-v4-pro"] = "DeepSeek-V4-Pro";
    aliases["deepseek_v4_pro"] = "DeepSeek-V4-Pro";
    aliases["kimik27code"] = "Kimi-K2.7-Code";
    aliases["kimi-k2-7-code"] = "Kimi-K2.7-Code";
    aliases["kimi_k2_7_code"] = "Kimi-K2.7-Code";
    aliases["kimi-k27-code"] = "Kimi-K2.7-Code";
    aliases["grok46"] = "grok-4.6";
    aliases["grok4-6"] = "grok-4.6";
    aliases["grok_4_6"] = "grok-4.6";
    aliases["gpt5mini"] = "gpt-5-mini";
    aliases["gpt-5-mini"] = "gpt-5-mini";
    aliases["gpt_5_mini"] = "gpt-5-mini";
    return aliases;
})();
function normalizeModelKey(name) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
function lookupModelDefaults(modelName) {
    // 1) exact
    if (MODEL_DEFAULTS[modelName])
        return MODEL_DEFAULTS[modelName];
    // 2) normalised alias
    const norm = normalizeModelKey(modelName);
    const aliasKey = MODEL_ALIASES[norm] ?? MODEL_ALIASES[norm.replace(/-/g, "")];
    if (aliasKey && MODEL_DEFAULTS[aliasKey])
        return MODEL_DEFAULTS[aliasKey];
    // 3) case-insensitive scan
    const lower = modelName.toLowerCase();
    for (const [k, v] of Object.entries(MODEL_DEFAULTS)) {
        if (k.toLowerCase() === lower)
            return v;
    }
    // 4) substring fallback for Foundry deployment ids that embed model family
    //    e.g. deployment "my-deepseek-v4-flash-eastus" should still resolve
    for (const [k, v] of Object.entries(MODEL_DEFAULTS)) {
        const kn = normalizeModelKey(k);
        if (norm.includes(kn) || kn.includes(norm))
            return v;
    }
    return undefined;
}
const FALLBACK = { contextWindow: 128000, maxTokens: 4096, reasoning: false, input: ["text"] };
const apiRouteMap = new Map();
const effortPolicyMap = new Map();
/** Infer OpenAI-compat token limit from model name when not explicitly configured */
function inferOpenAITokenLimit(modelName) {
    const d = lookupModelDefaults(modelName);
    if (d?.openaiTokenLimit)
        return d.openaiTokenLimit;
    // GPT-5 and o-series models reject max_tokens on Azure/OpenAI chat completions
    if (/^(gpt-5|o[1-9])([-.]|$)/i.test(modelName))
        return "max_completion_tokens";
    return "max_tokens";
}
function resolveApiRoute(d) {
    if (d.modelPublisher === "Anthropic")
        return { kind: "anthropic-messages" };
    const modelName = d.modelName ?? d.name;
    return { kind: "openai-chat-completions", tokenLimit: inferOpenAITokenLimit(modelName) };
}
function describeApiRoute(route) {
    if (route.kind === "anthropic-messages")
        return "anthropic-messages";
    return `openai-chat-completions (${route.tokenLimit})`;
}
const providerAuthMap = new Map();
function deploymentToModel(d) {
    const modelName = d.modelName ?? d.name;
    // Probe both modelName and deployment name for robustness (deployments may be aliased)
    const defaults = lookupModelDefaults(modelName) ?? lookupModelDefaults(d.name) ?? FALLBACK;
    apiRouteMap.set(d.name, resolveApiRoute(d));
    effortPolicyMap.set(d.name, {
        send: defaults.sendEffort === true,
        values: defaults.thinking?.efforts ?? [],
        defaultEffort: defaults.defaultEffort ?? defaults.thinking?.efforts?.[Math.floor((defaults.thinking?.efforts?.length ?? 1) / 2)] ?? "medium",
    });
    return {
        id: d.name,
        name: d.modelName ?? d.name,
        reasoning: defaults.reasoning,
        input: defaults.input,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: defaults.contextWindow,
        maxTokens: defaults.maxTokens,
        ...(defaults.thinking ? { thinking: defaults.thinking } : {}),
    };
}
// =============================================================================
// SSE Stream Parser
// =============================================================================
async function* parseSSE(reader) {
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
        const { done, value } = await reader.read();
        if (done)
            break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith("data: ")) {
                const data = trimmed.slice(6);
                if (data === "[DONE]")
                    return;
                yield data;
            }
        }
    }
}
// =============================================================================
// OpenAI-format message conversion  (for OpenAI / MoonshotAI / etc.)
// =============================================================================
function toOpenAIMessages(systemPrompt, messages) {
    const out = [];
    if (systemPrompt)
        out.push({ role: "system", content: systemPrompt });
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.role === "user") {
            if (typeof msg.content === "string") {
                out.push({ role: "user", content: msg.content });
            }
            else {
                out.push({ role: "user", content: msg.content.map((c) => c.type === "text" ? { type: "text", text: c.text } :
                        c.type === "image" ? { type: "image_url", image_url: { url: `data:${c.mimeType};base64,${c.data}` } } :
                            { type: "text", text: "" }) });
            }
        }
        else if (msg.role === "assistant") {
            const entry = { role: "assistant" };
            const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
            const tcs = msg.content.filter((b) => b.type === "toolCall").map((b) => ({
                id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.arguments) },
            }));
            if (text)
                entry.content = text;
            if (tcs.length)
                entry.tool_calls = tcs;
            out.push(entry);
        }
        else if (msg.role === "toolResult") {
            const m = msg;
            out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content.filter((c) => c.type === "text").map((c) => c.text).join("\n") });
        }
    }
    return out;
}
function toOpenAITools(tools) {
    return tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
}
// =============================================================================
// Anthropic-format message conversion
// =============================================================================
function toAnthropicMessages(messages) {
    const out = [];
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.role === "user") {
            if (typeof msg.content === "string") {
                out.push({ role: "user", content: msg.content });
            }
            else {
                out.push({ role: "user", content: msg.content.map((c) => c.type === "text" ? { type: "text", text: c.text } :
                        c.type === "image" ? { type: "image", source: { type: "base64", media_type: c.mimeType, data: c.data } } :
                            { type: "text", text: "" }) });
            }
        }
        else if (msg.role === "assistant") {
            const blocks = [];
            for (const b of msg.content) {
                if (b.type === "text" && b.text.trim())
                    blocks.push({ type: "text", text: b.text });
                if (b.type === "thinking")
                    blocks.push({ type: "thinking", thinking: b.thinking, signature: b.thinkingSignature ?? "" });
                if (b.type === "toolCall")
                    blocks.push({ type: "tool_use", id: b.id, name: b.name, input: b.arguments });
            }
            if (blocks.length)
                out.push({ role: "assistant", content: blocks });
        }
        else if (msg.role === "toolResult") {
            const m = msg;
            const text = m.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
            // Anthropic tool results go inside a user message
            out.push({ role: "user", content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: text, is_error: m.isError }] });
        }
    }
    return out;
}
function toAnthropicTools(tools) {
    return tools.map((t) => ({
        name: t.name, description: t.description,
        input_schema: { type: "object", properties: t.parameters.properties ?? {}, required: t.parameters.required ?? [] },
    }));
}
// =============================================================================
// OpenAI-compatible streaming (OpenAI, MoonshotAI, etc.)
// =============================================================================
function streamOpenAI(model, context, options, output, stream, baseHost, auth, route) {
    return (async () => {
        const url = `${baseHost}/openai/deployments/${model.id}/chat/completions?api-version=2024-10-21`;
        const openAIMessages = toOpenAIMessages(context.systemPrompt, context.messages);
        // Cap the wire request so input + completion never exceeds the context window.
        // Kimi-K2.7-Code reports maxTokens == contextWindow (262144); requesting the
        // full budget plus any input 400s. Estimate input at ~4 chars/token.
        const requested = options?.maxTokens ?? model.maxTokens;
        let maxOutput = requested;
        if (model.contextWindow) {
            const inputEstimate = Math.ceil(JSON.stringify(openAIMessages).length / 4);
            const headroom = model.contextWindow - inputEstimate - 256;
            if (headroom > 0)
                maxOutput = Math.min(requested, headroom);
            else
                maxOutput = Math.min(requested, Math.max(1024, model.contextWindow - 256));
        }
        const body = {
            messages: openAIMessages,
            [route.tokenLimit]: maxOutput,
            stream: true,
            stream_options: { include_usage: true },
        };
        if (context.tools?.length)
            body.tools = toOpenAITools(context.tools);
        // Reasoning effort: this Foundry endpoint defaults to NO reasoning when the
        // param is absent (mirrors the Playground's "Reasoning Effort: none" default),
        // so an explicit effort is required to get thinking out of DeepSeek V4.
        // Pi/OMP passes the user's effort dial as options.reasoning (Effort) and
        // fast-path opt-outs as options.disableReasoning.
        {
            // Foundry quirk map (verified live per family):
            // - DeepSeek V4: no param = no reasoning (Playground "none" default).
            //   Send one of [high, max]; "none" disables (200 OK).
            // - gpt-5-mini: effort steers depth 160 -> 840 completion tokens
            //   across minimal..high; "none" accepted.
            // - Kimi-K2.7-Code: reasons by default; param unneeded, and "none"
            //   leaks chain-of-thought as visible text. Send nothing.
            // - grok-4.6: ignores "high", 400s on "none". Send nothing.
            const policy = effortPolicyMap.get(model.id);
            if (policy?.send) {
                if (options?.disableReasoning) {
                    body.reasoning_effort = "none";
                }
                else {
                    const requestedEffort = options?.reasoning;
                    body.reasoning_effort =
                        requestedEffort && policy.values.includes(requestedEffort)
                            ? requestedEffort
                            : policy.defaultEffort;
                }
            }
        }
        const token = await auth.getToken();
        // OpenAI-compat route: api-key auth uses the "api-key" header;
        // Entra ID (azure-identity) uses "Authorization: Bearer".
        const authHeaders = auth.type === "api-key"
            ? { "api-key": token }
            : { "Authorization": `Bearer ${token}` };
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
        if (!response.body)
            throw new Error("No response body");
        stream.push({ type: "start", partial: output });
        const tcJsonBufs = new Map();
        const tcContentIdx = new Map();
        const reader = response.body.getReader();
        for await (const data of parseSSE(reader)) {
            let chunk;
            try {
                chunk = JSON.parse(data);
            }
            catch {
                continue;
            }
            if (chunk.usage) {
                output.usage.input = chunk.usage.prompt_tokens ?? 0;
                output.usage.output = chunk.usage.completion_tokens ?? 0;
                output.usage.totalTokens = chunk.usage.total_tokens ?? 0;
                calculateCost(model, output.usage);
            }
            const choice = chunk.choices?.[0];
            if (!choice?.delta)
                continue;
            const delta = choice.delta;
            // Reasoning / thinking deltas (DeepSeek `reasoning_content`, Kimi, Grok)
            const reasoningDelta = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
            if (typeof reasoningDelta === "string" && reasoningDelta.length > 0) {
                let idx = output.content.findIndex((b) => b.type === "thinking");
                if (idx === -1) {
                    output.content.push({ type: "thinking", thinking: "", thinkingSignature: "" });
                    idx = output.content.length - 1;
                    stream.push({ type: "thinking_start", contentIndex: idx, partial: output });
                }
                const block = output.content[idx];
                if (block.type === "thinking") {
                    block.thinking += reasoningDelta;
                    stream.push({ type: "thinking_delta", contentIndex: idx, delta: reasoningDelta, partial: output });
                }
            }
            if (typeof delta.content === "string" && delta.content.length > 0) {
                // Microsoft Foundry serves some DeepSeek reasoners (notably R1) with thinking
                // inline in content inside <think>...</think> tags rather than a dedicated
                // reasoning_content delta. Split complete pairs out into thinking blocks so
                // Pi/OMP renders them as thinking instead of visible tag soup.
                // (V4-Flash/Pro currently emit neither; this is a no-op for them.)
                let remainder = delta.content;
                const thinkRe = /<think>([\s\S]*?)<\/think>/;
                let m;
                while ((m = thinkRe.exec(remainder)) !== null) {
                    const before = remainder.slice(0, m.index);
                    if (before) {
                        let idx = output.content.findIndex((b) => b.type === "text");
                        if (idx === -1) {
                            output.content.push({ type: "text", text: "" });
                            idx = output.content.length - 1;
                            stream.push({ type: "text_start", contentIndex: idx, partial: output });
                        }
                        const block = output.content[idx];
                        if (block.type === "text") {
                            block.text += before;
                            stream.push({ type: "text_delta", contentIndex: idx, delta: before, partial: output });
                        }
                    }
                    const inner = m[1];
                    if (inner) {
                        let idx = output.content.findIndex((b) => b.type === "thinking");
                        if (idx === -1) {
                            output.content.push({ type: "thinking", thinking: "", thinkingSignature: "" });
                            idx = output.content.length - 1;
                            stream.push({ type: "thinking_start", contentIndex: idx, partial: output });
                        }
                        const block = output.content[idx];
                        if (block.type === "thinking") {
                            block.thinking += inner;
                            stream.push({ type: "thinking_delta", contentIndex: idx, delta: inner, partial: output });
                        }
                    }
                    remainder = remainder.slice(m.index + m[0].length);
                }
                if (remainder) {
                    let idx = output.content.findIndex((b) => b.type === "text");
                    if (idx === -1) {
                        output.content.push({ type: "text", text: "" });
                        idx = output.content.length - 1;
                        stream.push({ type: "text_start", contentIndex: idx, partial: output });
                    }
                    const block = output.content[idx];
                    if (block.type === "text") {
                        block.text += remainder;
                        stream.push({ type: "text_delta", contentIndex: idx, delta: remainder, partial: output });
                    }
                }
            }
            if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                    const tci = tc.index ?? 0;
                    if (tc.id) {
                        output.content.push({ type: "toolCall", id: tc.id, name: tc.function?.name ?? "", arguments: {} });
                        const ci = output.content.length - 1;
                        tcContentIdx.set(tci, ci);
                        tcJsonBufs.set(tci, "");
                        stream.push({ type: "toolcall_start", contentIndex: ci, partial: output });
                    }
                    if (tc.function?.arguments) {
                        const ci = tcContentIdx.get(tci);
                        if (ci === undefined)
                            continue;
                        const buf = (tcJsonBufs.get(tci) ?? "") + tc.function.arguments;
                        tcJsonBufs.set(tci, buf);
                        const block = output.content[ci];
                        if (block.type === "toolCall") {
                            try {
                                block.arguments = JSON.parse(buf);
                            }
                            catch { }
                        }
                        stream.push({ type: "toolcall_delta", contentIndex: ci, delta: tc.function.arguments, partial: output });
                    }
                }
            }
            if (choice.finish_reason === "stop")
                output.stopReason = "stop";
            else if (choice.finish_reason === "length")
                output.stopReason = "length";
            else if (choice.finish_reason === "tool_calls")
                output.stopReason = "toolUse";
        }
        // Finalize blocks
        for (let i = 0; i < output.content.length; i++) {
            const b = output.content[i];
            if (b.type === "text")
                stream.push({ type: "text_end", contentIndex: i, content: b.text, partial: output });
            else if (b.type === "thinking")
                stream.push({ type: "thinking_end", contentIndex: i, content: b.thinking, partial: output });
        }
        for (const [tci, ci] of tcContentIdx) {
            const b = output.content[ci];
            if (b.type === "toolCall") {
                try {
                    b.arguments = JSON.parse(tcJsonBufs.get(tci) ?? "{}");
                }
                catch { }
                stream.push({ type: "toolcall_end", contentIndex: ci, toolCall: b, partial: output });
            }
        }
    })();
}
// =============================================================================
// Anthropic Messages API streaming
// =============================================================================
function streamAnthropic(model, context, options, output, stream, baseHost, auth) {
    return (async () => {
        const url = `${baseHost}/anthropic/v1/messages`;
        const body = {
            model: model.id,
            messages: toAnthropicMessages(context.messages),
            max_tokens: options?.maxTokens ?? model.maxTokens,
            stream: true,
        };
        if (context.systemPrompt)
            body.system = context.systemPrompt;
        if (context.tools?.length)
            body.tools = toAnthropicTools(context.tools);
        const token = await auth.getToken();
        // Anthropic route on Azure Foundry always uses "Authorization: Bearer"
        // regardless of auth type — api-key values are valid Bearer tokens here.
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
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
        if (!response.body)
            throw new Error("No response body");
        stream.push({ type: "start", partial: output });
        // Anthropic SSE events: message_start, content_block_start, content_block_delta, content_block_stop, message_delta, message_stop
        const blockIndices = new Map(); // anthropic block index → output.content index
        const tcJsonBufs = new Map();
        const reader = response.body.getReader();
        for await (const data of parseSSE(reader)) {
            let event;
            try {
                event = JSON.parse(data);
            }
            catch {
                continue;
            }
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
                }
                else if (cb.type === "thinking") {
                    output.content.push({ type: "thinking", thinking: "", thinkingSignature: "" });
                    blockIndices.set(anthropicIdx, output.content.length - 1);
                    stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
                }
                else if (cb.type === "tool_use") {
                    output.content.push({ type: "toolCall", id: cb.id, name: cb.name, arguments: {} });
                    const ci = output.content.length - 1;
                    blockIndices.set(anthropicIdx, ci);
                    tcJsonBufs.set(anthropicIdx, "");
                    stream.push({ type: "toolcall_start", contentIndex: ci, partial: output });
                }
            }
            if (event.type === "content_block_delta") {
                const ci = blockIndices.get(event.index);
                if (ci === undefined)
                    continue;
                const block = output.content[ci];
                const d = event.delta;
                if (d.type === "text_delta" && block.type === "text") {
                    block.text += d.text;
                    stream.push({ type: "text_delta", contentIndex: ci, delta: d.text, partial: output });
                }
                else if (d.type === "thinking_delta" && block.type === "thinking") {
                    block.thinking += d.thinking;
                    stream.push({ type: "thinking_delta", contentIndex: ci, delta: d.thinking, partial: output });
                }
                else if (d.type === "signature_delta" && block.type === "thinking") {
                    block.thinkingSignature = (block.thinkingSignature ?? "") + d.signature;
                }
                else if (d.type === "input_json_delta" && block.type === "toolCall") {
                    const buf = (tcJsonBufs.get(event.index) ?? "") + d.partial_json;
                    tcJsonBufs.set(event.index, buf);
                    try {
                        block.arguments = JSON.parse(buf);
                    }
                    catch { }
                    stream.push({ type: "toolcall_delta", contentIndex: ci, delta: d.partial_json, partial: output });
                }
            }
            if (event.type === "content_block_stop") {
                const ci = blockIndices.get(event.index);
                if (ci === undefined)
                    continue;
                const block = output.content[ci];
                if (block.type === "text")
                    stream.push({ type: "text_end", contentIndex: ci, content: block.text, partial: output });
                else if (block.type === "thinking")
                    stream.push({ type: "thinking_end", contentIndex: ci, content: block.thinking, partial: output });
                else if (block.type === "toolCall") {
                    try {
                        block.arguments = JSON.parse(tcJsonBufs.get(event.index) ?? "{}");
                    }
                    catch { }
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
                if (sr === "end_turn" || sr === "stop_sequence")
                    output.stopReason = "stop";
                else if (sr === "max_tokens")
                    output.stopReason = "length";
                else if (sr === "tool_use")
                    output.stopReason = "toolUse";
            }
        }
    })();
}
// =============================================================================
// Unified streamSimple — routes based on publisher
// =============================================================================
function streamAzureFoundry(model, context, options) {
    const stream = createAssistantMessageEventStream();
    (async () => {
        const output = {
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
            const auth = providerAuthMap.get(model.provider)
                ?? { type: "api-key", getToken: () => Promise.resolve(options?.apiKey ?? "") };
            if (route.kind === "anthropic-messages") {
                await streamAnthropic(model, context, options, output, stream, baseHost, auth);
            }
            else {
                await streamOpenAI(model, context, options, output, stream, baseHost, auth, route);
            }
            stream.push({ type: "done", reason: output.stopReason, message: output });
            stream.end();
        }
        catch (error) {
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
export default async function (pi) {
    const config = loadConfig();
    const endpoint = `https://${config.resourceId}.services.ai.azure.com/api/projects/${config.projectId}`;
    // Discover deployments
    const url = `${endpoint}/deployments?api-version=v1`;
    console.log(`[Azure Foundry] Fetching deployments from: ${url}`);
    const getToken = makeTokenGetter(config.auth);
    console.log(`[Azure Foundry] Auth: ${config.auth.type}`);
    const token = await getToken();
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) {
        const b = await response.text().catch(() => "");
        throw new Error(`Azure Foundry API ${response.status}: ${b.slice(0, 200)}`);
    }
    const data = (await response.json());
    const deployments = (data.value ?? []).filter((d) => d.capabilities?.chat_completion === "true");
    if (deployments.length === 0)
        throw new Error("No chat-capable deployments found");
    const models = deployments.map(deploymentToModel);
    const summary = deployments.map((d) => {
        const route = apiRouteMap.get(d.name);
        return `${d.name} (${d.modelPublisher}, ${describeApiRoute(route)})`;
    }).join(", ");
    console.log(`[Azure Foundry] Found ${deployments.length} deployment(s): ${summary}`);
    for (const d of deployments) {
        const modelName = d.modelName ?? d.name;
        if (MODEL_DEFAULTS[modelName])
            continue;
        const route = apiRouteMap.get(d.name);
        console.log(`[Azure Foundry] ${d.name}: no explicit defaults for "${modelName}" — using ${describeApiRoute(route)}`);
    }
    const providerId = "azure-foundry";
    // Store the auth context so streamAzureFoundry can build the right headers per-request.
    providerAuthMap.set(providerId, { type: config.auth.type, getToken });
    pi.registerProvider(providerId, {
        name: "Azure Foundry",
        baseUrl: endpoint,
        // For api-key auth, store the real key. For azure-identity, pass a sentinel
        // so pi's required-field validation passes — tokens are always fetched at
        // request time via providerAuthMap and this value is never used.
        apiKey: config.auth.type === "api-key" ? config.auth.apiKey : "azure-identity",
        api: "azure-foundry",
        streamSimple: streamAzureFoundry,
        models,
    });
    console.log(`[Azure Foundry] ✓ Registered ${deployments.length} model(s)`);
}
//# sourceMappingURL=index.js.map