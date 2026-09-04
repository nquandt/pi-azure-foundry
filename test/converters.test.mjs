/**
 * Regression tests for the message converters.
 *
 * Run: npm test
 *
 * Covers the histories that pi persists but the provider APIs reject:
 * aborted turns with unanswered tool calls, empty thinking blocks,
 * tool-call-only assistant turns, and multi-tool turns.
 */
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import { toOpenAIMessages, toAnthropicMessages } from "../dist/index.js";

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n        ${detail}`}`);
  if (!ok) failures++;
}

const model = { id: "dep", provider: "azure-foundry", api: "azure-foundry", input: ["text", "image"] };
const prep = (msgs) => transformMessages(msgs, model);
const assistant = (content, stopReason = "stop") => ({ role: "assistant", content, stopReason, provider: model.provider, api: model.api, model: model.id });

function auditAnthropic(msgs) {
  const badThinking = [];
  const orphans = [];
  msgs.forEach((m, i) => {
    if (m.role !== "assistant" || !Array.isArray(m.content)) return;
    for (const b of m.content) if (b.type === "thinking" && (!b.thinking || !b.signature)) badThinking.push(i);
    const ids = m.content.filter((b) => b.type === "tool_use").map((b) => b.id);
    if (!ids.length) return;
    const next = msgs[i + 1];
    const answered = new Set(next?.role === "user" && Array.isArray(next.content)
      ? next.content.filter((b) => b.type === "tool_result").map((b) => b.tool_use_id) : []);
    for (const id of ids) if (!answered.has(id)) orphans.push(`${i}:${id}`);
  });
  return { badThinking, orphans };
}

function auditOpenAI(msgs) {
  const nonString = [];
  const orphanTools = [];
  msgs.forEach((m, i) => {
    if (m.role === "assistant" && typeof m.content !== "string") nonString.push(i);
    if (m.role === "tool") {
      const prev = msgs[i - 1];
      const ok = prev && ((prev.role === "assistant" && (prev.tool_calls ?? []).some((t) => t.id === m.tool_call_id)) || prev.role === "tool");
      if (!ok) orphanTools.push(i);
    }
  });
  return { nonString, orphanTools };
}

console.log("aborted turn: orphaned tool call + empty thinking with signature");
{
  const h = [
    { role: "user", content: "read the file" },
    assistant([
      { type: "thinking", thinking: "", thinkingSignature: "SIG" },
      { type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "a.md" } },
    ], "aborted"),
    { role: "user", content: "do something else" },
  ];
  const a = auditAnthropic(toAnthropicMessages(prep(h)));
  check("anthropic: no empty/unsigned thinking blocks", a.badThinking.length === 0, `at ${a.badThinking}`);
  check("anthropic: no orphaned tool_use", a.orphans.length === 0, `orphans ${a.orphans}`);
  const o = auditOpenAI(toOpenAIMessages("sys", prep(h)));
  check("openai: assistant content is a string", o.nonString.length === 0, `at ${o.nonString}`);
  check("openai: no orphaned tool messages", o.orphanTools.length === 0, `at ${o.orphanTools}`);
}

console.log("errored turn with no content");
{
  const h = [{ role: "user", content: "hi" }, assistant([], "error"), { role: "user", content: "continue" }];
  const msgs = toAnthropicMessages(prep(h));
  check("anthropic: empty assistant turn dropped", !msgs.some((m) => m.role === "assistant"), JSON.stringify(msgs));
  const o = auditOpenAI(toOpenAIMessages("sys", prep(h)));
  check("openai: assistant content is a string", o.nonString.length === 0, `at ${o.nonString}`);
}

console.log("tool-call-only assistant turn");
{
  const h = [
    { role: "user", content: "list files" },
    assistant([{ type: "toolCall", id: "call_1", name: "ls", arguments: {} }], "toolUse"),
    { role: "toolResult", toolCallId: "call_1", toolName: "ls", content: [{ type: "text", text: "a.md" }], isError: false },
  ];
  const o = auditOpenAI(toOpenAIMessages("sys", prep(h)));
  check("openai: assistant content is a string", o.nonString.length === 0, `at ${o.nonString}`);
  check("openai: no orphaned tool messages", o.orphanTools.length === 0, `at ${o.orphanTools}`);
}

console.log("turn with two tool calls");
{
  const h = [
    { role: "user", content: "read both" },
    assistant([
      { type: "toolCall", id: "t1", name: "read", arguments: { path: "a" } },
      { type: "toolCall", id: "t2", name: "read", arguments: { path: "b" } },
    ], "toolUse"),
    { role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "A" }], isError: false },
    { role: "toolResult", toolCallId: "t2", toolName: "read", content: [{ type: "text", text: "B" }], isError: false },
    { role: "user", content: "thanks" },
  ];
  const msgs = toAnthropicMessages(prep(h));
  const a = auditAnthropic(msgs);
  check("anthropic: no orphaned tool_use", a.orphans.length === 0, `orphans ${a.orphans}`);
  check("anthropic: results merged into one user message", msgs.length === 4, `got ${msgs.length}: ${JSON.stringify(msgs)}`);
}

console.log(failures ? `\n${failures} failing check(s)` : "\nall checks passed");
process.exit(failures ? 1 : 0);
