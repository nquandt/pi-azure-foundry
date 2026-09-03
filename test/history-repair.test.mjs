/**
 * Regression tests for the three history defects that brick a session.
 *
 * Run: node test/history-repair.test.mjs [path-to-session.jsonl]
 *
 * With no argument the tests run against synthetic fixtures. Pass a real pi
 * session file to replay an actual transcript through both converters.
 */
import { readFileSync } from "node:fs";
import { toOpenAIMessages, toAnthropicMessages } from "../dist/index.js";

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n        ${detail}`}`);
  if (!ok) failures++;
}

// --- assertions on a converted payload -------------------------------------

function auditAnthropic(msgs) {
  const emptyThinking = [];
  const orphans = [];
  msgs.forEach((m, i) => {
    if (m.role !== "assistant" || !Array.isArray(m.content)) return;
    for (const b of m.content) {
      if (b.type === "thinking" && !b.thinking) emptyThinking.push(i);
    }
    const ids = m.content.filter((b) => b.type === "tool_use").map((b) => b.id);
    if (!ids.length) return;
    const next = msgs[i + 1];
    const answered = new Set(
      next && next.role === "user" && Array.isArray(next.content)
        ? next.content.filter((b) => b.type === "tool_result").map((b) => b.tool_use_id)
        : []
    );
    for (const id of ids) if (!answered.has(id)) orphans.push(`${i}:${id}`);
  });
  return { emptyThinking, orphans };
}

function auditOpenAI(msgs) {
  const nonStringContent = [];
  const orphanTools = [];
  msgs.forEach((m, i) => {
    if (m.role === "assistant" && typeof m.content !== "string") nonStringContent.push(i);
    if (m.role === "tool") {
      const prev = msgs[i - 1];
      const ok =
        prev &&
        ((prev.role === "assistant" && (prev.tool_calls ?? []).some((t) => t.id === m.tool_call_id)) ||
          prev.role === "tool");
      if (!ok) orphanTools.push(i);
    }
  });
  return { nonStringContent, orphanTools };
}

// --- fixtures ---------------------------------------------------------------

const abortedTurn = [
  { role: "user", content: "read the file" },
  {
    role: "assistant",
    stopReason: "aborted",
    content: [
      { type: "thinking", thinking: "", thinkingSignature: "SIGNATURE" },
      { type: "toolCall", id: "toolu_orphan", name: "read", arguments: { path: "a.md" } },
    ],
  },
  { role: "user", content: "actually do something else" },
];

const emptyErrorTurn = [
  { role: "user", content: "hi" },
  { role: "assistant", stopReason: "error", content: [] },
  { role: "user", content: "continue" },
];

const toolOnlyTurn = [
  { role: "user", content: "list files" },
  {
    role: "assistant",
    stopReason: "toolUse",
    content: [{ type: "toolCall", id: "call_1", name: "ls", arguments: {} }],
  },
  { role: "toolResult", toolCallId: "call_1", toolName: "ls", content: [{ type: "text", text: "a.md" }], isError: false },
];

console.log("fixture: aborted turn with orphaned tool call + empty thinking");
{
  const a = auditAnthropic(toAnthropicMessages(abortedTurn));
  check("anthropic: no empty thinking blocks", a.emptyThinking.length === 0, `at ${a.emptyThinking}`);
  check("anthropic: no orphaned tool_use", a.orphans.length === 0, `orphans ${a.orphans}`);
  const o = auditOpenAI(toOpenAIMessages("sys", abortedTurn));
  check("openai: assistant content always a string", o.nonStringContent.length === 0, `at ${o.nonStringContent}`);
  check("openai: no orphaned tool messages", o.orphanTools.length === 0, `at ${o.orphanTools}`);
}

console.log("fixture: empty errored assistant turn");
{
  const msgs = toAnthropicMessages(emptyErrorTurn);
  check("anthropic: empty assistant turn dropped", !msgs.some((m) => m.role === "assistant"), JSON.stringify(msgs));
  const o = auditOpenAI(toOpenAIMessages("sys", emptyErrorTurn));
  check("openai: assistant content always a string", o.nonStringContent.length === 0, `at ${o.nonStringContent}`);
}

console.log("fixture: tool-call-only assistant turn (no text)");
{
  const o = auditOpenAI(toOpenAIMessages("sys", toolOnlyTurn));
  check("openai: assistant content always a string", o.nonStringContent.length === 0, `at ${o.nonStringContent}`);
  check("openai: no orphaned tool messages", o.orphanTools.length === 0, `at ${o.orphanTools}`);
}

// --- optional: replay a real session ----------------------------------------

const sessionPath = process.argv[2];
if (sessionPath) {
  const messages = readFileSync(sessionPath, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === "message")
    .map((e) => e.message);

  console.log(`real session: ${sessionPath} (${messages.length} messages)`);
  const a = auditAnthropic(toAnthropicMessages(messages));
  check("anthropic: no empty thinking blocks", a.emptyThinking.length === 0, `${a.emptyThinking.length} found`);
  check("anthropic: no orphaned tool_use", a.orphans.length === 0, `${a.orphans.length} found`);
  const o = auditOpenAI(toOpenAIMessages("sys", messages));
  check("openai: assistant content always a string", o.nonStringContent.length === 0, `${o.nonStringContent.length} found`);
  check("openai: no orphaned tool messages", o.orphanTools.length === 0, `${o.orphanTools.length} found`);
}

console.log(failures ? `\n${failures} failing check(s)` : "\nall checks passed");
process.exit(failures ? 1 : 0);
