/**
 * Offline end-to-end tests for the extension.
 *
 * Run: npm test
 *
 * Loads the built extension with a fake pi host and a mocked global fetch.
 * Covers deployment discovery, model metadata resolution (catalog, override,
 * fallback), route selection, gateway URL and header handling, SSE parsing
 * across chunk boundaries, and streaming on both routes.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n        ${detail}`}`);
  if (!ok) failures++;
}

// --- test config in a temp cwd ---------------------------------------------

const dir = mkdtempSync(join(tmpdir(), "pi-azure-foundry-"));
const config = {
  resourceId: "res",
  projectId: "proj",
  auth: { type: "api-key", apiKey: "KEY" },
  gatewayUrl: "https://gw.example.net/foundry/",
  headers: { "Ocp-Apim-Subscription-Key": "SUB", "api-key": "SHOULD-NOT-WIN" },
  models: { "my-custom-llm": { contextWindow: 9999, maxTokens: 777, cost: { input: 1, output: 2 } } },
};
writeFileSync(join(dir, "azure-foundry.config.json"), JSON.stringify(config));
process.chdir(dir);

const FOUNDRY = "https://res.services.ai.azure.com/api/projects/proj";

// --- mocked fetch ------------------------------------------------------------

const requests = [];
let nextChat = null; // { status, sse: string[] } for the next chat request

function sseBody(lines) {
  // Encode as one byte stream, split at awkward boundaries to exercise parseSSE.
  const text = lines.map((l) => `data: ${l}\n\n`).join("");
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(ctrl) {
      let i = 0;
      while (i < bytes.length) { const n = Math.min(7, bytes.length - i); ctrl.enqueue(bytes.slice(i, i + n)); i += n; }
      ctrl.close();
    },
  });
}

globalThis.fetch = async (url, init = {}) => {
  requests.push({ url: String(url), init });
  if (String(url).startsWith(`${FOUNDRY}/deployments`)) {
    return new Response(JSON.stringify({ value: [
      { name: "claude-haiku-4-5", modelName: "claude-haiku-4-5", modelPublisher: "Anthropic", capabilities: { chat_completion: "true" } },
      { name: "gpt-5-mini", modelName: "gpt-5-mini", modelPublisher: "OpenAI", capabilities: { chat_completion: "true" } },
      { name: "DeepSeek-V4-Flash", modelName: "DeepSeek-V4-Flash", modelPublisher: "DeepSeek", capabilities: { chat_completion: "true" } },
      { name: "Kimi-K2.6", modelName: "Kimi-K2.6", modelPublisher: "MoonshotAI", capabilities: { chat_completion: "true" } },
      { name: "gpt-5.4-nano", modelName: "gpt-5.4-nano", modelPublisher: "OpenAI", capabilities: { chat_completion: "true" } },
      { name: "my-custom-llm", modelName: "my-custom-llm", modelPublisher: "Contoso", capabilities: { chat_completion: "true" } },
      { name: "embed", modelName: "text-embedding-3-small", modelPublisher: "OpenAI", capabilities: { embeddings: "true" } },
    ] }), { status: 200 });
  }
  const { status = 200, sse = [] } = nextChat ?? {};
  if (status !== 200) return new Response("boom", { status });
  return new Response(sseBody(sse.map((o) => (typeof o === "string" ? o : JSON.stringify(o)))), { status: 200 });
};

// --- load the extension with a fake pi -------------------------------------

const { default: register } = await import("../dist/index.js");
let provider;
await register({ registerProvider: (_id, p) => { provider = p; } });

const models = Object.fromEntries(provider.models.map((m) => [m.id, m]));
const asModel = (id) => ({ ...models[id], provider: "azure-foundry", api: "azure-foundry", baseUrl: provider.baseUrl });

async function run(id, context, options) {
  const events = [];
  const stream = provider.streamSimple(asModel(id), context, options);
  for await (const ev of stream) events.push(ev);
  return { events, message: events.at(-1)?.message ?? events.at(-1)?.error };
}

console.log("discovery and metadata resolution");
{
  check("discovery hits the Foundry endpoint, not the gateway", requests[0].url.startsWith(FOUNDRY), requests[0].url);
  check("non-chat deployments are skipped", !models.embed && provider.models.length === 6, Object.keys(models).join(","));
  check("catalog: gpt-5-mini is a reasoning model with cost", models["gpt-5-mini"].reasoning === true && models["gpt-5-mini"].cost.input > 0, JSON.stringify(models["gpt-5-mini"]));
  check("catalog: case-insensitive match for DeepSeek-V4-Flash", models["DeepSeek-V4-Flash"].contextWindow > 128000, JSON.stringify(models["DeepSeek-V4-Flash"]));
  const c = models["my-custom-llm"];
  check("override: fields applied over fallback", c.contextWindow === 9999 && c.maxTokens === 777 && c.cost.input === 1 && c.cost.output === 2, JSON.stringify(c));
  check("override: unspecified cost fields kept from base", c.cost.cacheRead === 0 && c.cost.cacheWrite === 0, JSON.stringify(c.cost));
  check("provider apiKey is the configured key", provider.apiKey === "KEY", provider.apiKey);
  check("thinkingLevelMap passed through to pi", !!models["DeepSeek-V4-Flash"].thinkingLevelMap, JSON.stringify(models["DeepSeek-V4-Flash"]));
}

console.log("openai route: reasoning_effort and output cap policy");
{
  async function bodyFor(id, options) {
    nextChat = { sse: [{ choices: [{ delta: { content: "x" }, finish_reason: "stop" }] }, "[DONE]"] };
    const before = requests.length;
    await run(id, { messages: [{ role: "user", content: "q" }, { role: "assistant", content: [{ type: "text", text: "a" }], stopReason: "stop", provider: "azure-foundry", api: "azure-foundry", model: id }, { role: "user", content: "q2" }] }, options);
    return JSON.parse(requests[before].init.body);
  }
  let b = await bodyFor("DeepSeek-V4-Flash", {});
  check("deepseek off: reasoning_effort omitted (Foundry default is none)", b.reasoning_effort === undefined, JSON.stringify(b));
  check("no output cap sent unless requested", b.max_tokens === undefined && b.max_completion_tokens === undefined, JSON.stringify(Object.keys(b)));
  check("deepseek: reasoning_content replayed on assistant turns", b.messages.find((m) => m.role === "assistant").reasoning_content === "", JSON.stringify(b.messages));
  b = await bodyFor("DeepSeek-V4-Flash", { reasoning: "medium" });
  check("deepseek medium: clamped to a supported level (high)", b.reasoning_effort === "high", JSON.stringify(b.reasoning_effort));
  b = await bodyFor("DeepSeek-V4-Flash", { reasoning: "low", maxTokens: 500 });
  check("deepseek low: sent as low", b.reasoning_effort === "low", JSON.stringify(b.reasoning_effort));
  check("requested cap sent as max_tokens", b.max_tokens === 500, JSON.stringify(b));
  b = await bodyFor("Kimi-K2.6", { reasoning: "high" });
  check("kimi: never sends reasoning_effort (catalog: unsupported)", b.reasoning_effort === undefined, JSON.stringify(b));
  check("kimi: no reasoning_content on replay", b.messages.find((m) => m.role === "assistant").reasoning_content === undefined, JSON.stringify(b.messages));
  b = await bodyFor("gpt-5.4-nano", {});
  check("gpt-5.4-nano off: sends 'none' (catalog off→none)", b.reasoning_effort === "none", JSON.stringify(b.reasoning_effort));
  b = await bodyFor("gpt-5.4-nano", { reasoning: "xhigh", maxTokens: 50 });
  check("gpt-5.4-nano xhigh: sent, cap uses max_completion_tokens", b.reasoning_effort === "xhigh" && b.max_completion_tokens === 50 && b.max_tokens === undefined, JSON.stringify(b));
  b = await bodyFor("gpt-5-mini", {});
  check("gpt-5-mini off: nothing sent (catalog off→null)", b.reasoning_effort === undefined, JSON.stringify(b.reasoning_effort));
  b = await bodyFor("my-custom-llm", { reasoning: "high" });
  check("fallback (non-reasoning) model: nothing sent", b.reasoning_effort === undefined, JSON.stringify(b.reasoning_effort));
}

console.log("openai route: request shape, gateway, headers");
{
  nextChat = { sse: [
    { choices: [{ delta: { reasoning_content: "think" } }] },
    { choices: [{ delta: { reasoning_content: "ing" } }] },
    { choices: [{ delta: { content: "Hel" } }] },
    { choices: [{ delta: { content: "lo" } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: "{\"pa" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "th\":\"a\"}" } }] }, finish_reason: "tool_calls" }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    "[DONE]",
  ] };
  const before = requests.length;
  const ctx = {
    systemPrompt: "sys",
    messages: [
      { role: "user", content: "read a" },
      { role: "assistant", content: [{ type: "toolCall", id: "aborted_call", name: "read", arguments: {} }], stopReason: "aborted", provider: "azure-foundry", api: "azure-foundry", model: "gpt-5-mini" },
      { role: "user", content: "again" },
      { role: "assistant", content: [{ type: "toolCall", id: "unanswered", name: "read", arguments: {} }], stopReason: "toolUse", provider: "azure-foundry", api: "azure-foundry", model: "gpt-5-mini" },
      { role: "user", content: "and again" },
    ],
    tools: [{ name: "read", description: "read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }],
  };
  const { events, message } = await run("gpt-5-mini", ctx, { maxTokens: 100 });
  const req = requests[before];
  const body = JSON.parse(req.init.body);
  check("url routed through gateway with trailing slash stripped", req.url === "https://gw.example.net/foundry/openai/deployments/gpt-5-mini/chat/completions?api-version=2024-10-21", req.url);
  check("gpt-5 uses max_completion_tokens", body.max_completion_tokens === 100 && body.max_tokens === undefined, JSON.stringify(Object.keys(body)));
  check("custom header sent", req.init.headers["Ocp-Apim-Subscription-Key"] === "SUB", JSON.stringify(req.init.headers));
  check("auth header wins over custom header", req.init.headers["api-key"] === "KEY", JSON.stringify(req.init.headers));
  check("system prompt first", body.messages[0].role === "system" && body.messages[0].content === "sys", JSON.stringify(body.messages[0]));
  check("aborted assistant turn is dropped entirely", !JSON.stringify(body.messages).includes("aborted_call"), JSON.stringify(body.messages));
  const synth = body.messages.findIndex((m) => m.role === "tool" && m.tool_call_id === "unanswered");
  const callIdx = body.messages.findIndex((m) => m.role === "assistant" && m.tool_calls?.some((c) => c.id === "unanswered"));
  check("unanswered tool call gets a synthetic result right after it", synth === callIdx + 1, JSON.stringify(body.messages));
  check("assistant content is a string", body.messages.filter((m) => m.role === "assistant").every((m) => typeof m.content === "string"), JSON.stringify(body.messages));
  check("tools converted to function tools", body.tools?.[0]?.type === "function" && body.tools[0].function.name === "read", JSON.stringify(body.tools));

  const thinking = message.content.find((b) => b.type === "thinking");
  const text = message.content.find((b) => b.type === "text");
  const tc = message.content.find((b) => b.type === "toolCall");
  check("reasoning_content deltas become a thinking block", thinking?.thinking === "thinking", JSON.stringify(thinking));
  check("text assembled across SSE chunk boundaries", text?.text === "Hello", JSON.stringify(text));
  check("tool call arguments assembled and parsed", tc?.id === "call_1" && tc.arguments.path === "a", JSON.stringify(tc));
  check("stopReason toolUse", message.stopReason === "toolUse", message.stopReason);
  check("usage recorded and cost computed", message.usage.input === 10 && message.usage.output === 5 && message.usage.cost.total > 0, JSON.stringify(message.usage));
  const types = events.map((e) => e.type);
  check("event order: start, thinking, text, toolcall, done", ["start", "thinking_start", "text_start", "toolcall_start", "done"].every((t) => types.includes(t)) && types.at(-1) === "done" && types.includes("thinking_end") && types.includes("text_end") && types.includes("toolcall_end"), types.join(","));
}

console.log("openai route: non-gpt-5 model uses max_tokens");
{
  nextChat = { sse: [{ choices: [{ delta: { content: "391" }, finish_reason: "stop" }] }, "[DONE]"] };
  const before = requests.length;
  const { message } = await run("DeepSeek-V4-Flash", { messages: [{ role: "user", content: "17*23" }] }, {});
  const body = JSON.parse(requests[before].init.body);
  check("no cap field when none requested", body.max_tokens === undefined && body.max_completion_tokens === undefined, JSON.stringify(Object.keys(body)));
  check("plain text reply, stopReason stop", message.content[0]?.text === "391" && message.stopReason === "stop", JSON.stringify(message));
}

console.log("anthropic route: request shape and streaming");
{
  nextChat = { sse: [
    { type: "message_start", message: { usage: { input_tokens: 20, cache_read_input_tokens: 3, cache_creation_input_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "SIG" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "OK" } },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "read", input: {} } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{\"path\":" } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "\"b\"}" } },
    { type: "content_block_stop", index: 2 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } },
    { type: "message_stop" },
  ] };
  const before = requests.length;
  const ctx = {
    systemPrompt: "sys",
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: [
        { type: "thinking", thinking: "", thinkingSignature: "SIG" },
        { type: "toolCall", id: "t1", name: "read", arguments: {} },
        { type: "toolCall", id: "t2", name: "read", arguments: {} },
      ], stopReason: "toolUse", provider: "azure-foundry", api: "azure-foundry", model: "claude-haiku-4-5" },
      { role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "A" }], isError: false },
      { role: "toolResult", toolCallId: "t2", toolName: "read", content: [{ type: "text", text: "B" }], isError: false },
    ],
    tools: [{ name: "read", description: "d", parameters: { type: "object", properties: { path: { type: "string" } } } }],
  };
  const { message } = await run("claude-haiku-4-5", ctx, {});
  const req = requests[before];
  const body = JSON.parse(req.init.body);
  check("url routed through gateway", req.url === "https://gw.example.net/foundry/anthropic/v1/messages", req.url);
  check("bearer auth + anthropic-version + custom header", req.init.headers.Authorization === "Bearer KEY" && req.init.headers["anthropic-version"] === "2023-06-01" && req.init.headers["Ocp-Apim-Subscription-Key"] === "SUB", JSON.stringify(req.init.headers));
  check("system prompt in body.system", body.system === "sys", JSON.stringify(body.system));
  check("tools use input_schema", body.tools?.[0]?.input_schema?.type === "object", JSON.stringify(body.tools));
  const asst = body.messages.find((m) => m.role === "assistant");
  check("empty thinking block not replayed", !asst.content.some((b) => b.type === "thinking"), JSON.stringify(asst));
  const results = body.messages.filter((m) => m.role === "user" && Array.isArray(m.content) && m.content[0]?.type === "tool_result");
  check("two tool results merged into one user message", results.length === 1 && results[0].content.length === 2, JSON.stringify(results));

  const thinking = message.content.find((b) => b.type === "thinking");
  const tc = message.content.find((b) => b.type === "toolCall");
  check("thinking text and signature captured", thinking?.thinking === "hmm" && thinking.thinkingSignature === "SIG", JSON.stringify(thinking));
  check("text captured", message.content.find((b) => b.type === "text")?.text === "OK", JSON.stringify(message.content));
  check("tool_use input assembled", tc?.id === "toolu_1" && tc.arguments.path === "b", JSON.stringify(tc));
  check("usage incl. cache read, stopReason toolUse", message.usage.input === 20 && message.usage.cacheRead === 3 && message.usage.output === 7 && message.stopReason === "toolUse", JSON.stringify(message.usage));
}

console.log("host tolerance: array system prompt and bare-string content items");
{
  nextChat = { sse: [{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }, "[DONE]"] };
  let before = requests.length;
  await run("gpt-5-mini", { systemPrompt: ["part one", "", "part two"], messages: [{ role: "user", content: ["hello", { type: "text", text: "world" }] }] }, {});
  let body = JSON.parse(requests[before].init.body);
  check("openai: array system prompt collapsed to a string", body.messages[0].role === "system" && body.messages[0].content === "part one\npart two", JSON.stringify(body.messages[0]));
  check("openai: bare string in content array kept as text", body.messages[1].content[0].text === "hello" && body.messages[1].content[1].text === "world", JSON.stringify(body.messages[1]));
  nextChat = { sse: [
    { type: "message_start", message: { usage: { input_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
  ] };
  before = requests.length;
  await run("claude-haiku-4-5", { systemPrompt: ["a", "b"], messages: [{ role: "user", content: ["hello"] }] }, {});
  body = JSON.parse(requests[before].init.body);
  check("anthropic: array system prompt collapsed to a string", body.system === "a\nb", JSON.stringify(body.system));
  check("anthropic: bare string in content array kept as text", body.messages[0].content[0].text === "hello", JSON.stringify(body.messages[0]));
}

console.log("error handling");
{
  nextChat = { status: 429 };
  const { events, message } = await run("gpt-5-mini", { messages: [{ role: "user", content: "x" }] }, {});
  check("non-2xx becomes an error event", events.at(-1)?.type === "error" && message.stopReason === "error", JSON.stringify(events.at(-1)));
  check("error message carries status and body", /429/.test(message.errorMessage) && /boom/.test(message.errorMessage), message.errorMessage);
}

console.log(failures ? `\n${failures} failing check(s)` : "\nall checks passed");
process.exit(failures ? 1 : 0);
