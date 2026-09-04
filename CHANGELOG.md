# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `gatewayUrl` config option to route chat requests through an API Management gateway.
- `headers` config option to send extra HTTP headers on every chat request.
- Reasoning deltas (`reasoning_content`, `reasoning`, `reasoning_text`) on the OpenAI-compatible route are surfaced as thinking blocks.
- `thinkingLevelMap` and `supportsReasoningEffort` per-model config overrides.
- Offline test suites (`npm test`): converter regression tests and an end-to-end suite with a fake pi host and mocked `fetch`.
- GitHub Actions CI running type-check and tests on Node 22 and 24.

### Fixed
- Both routes now accept a system prompt given as a string array and bare strings inside user content arrays, as some pi forks (OMP) send. Previously the OpenAI route returned a 400 and the bare strings were dropped.
- Reasoning is now actually enabled on the OpenAI-compatible route. Foundry defaults to no reasoning unless `reasoning_effort` is sent; pi's thinking level is now clamped and mapped through the catalog's per-model `thinkingLevelMap`. Models that reject `"none"` get no field when thinking is off, and models that do not accept the field (Kimi) never receive it.
- No output cap is sent on the OpenAI-compatible route unless the caller sets one. Catalog `maxTokens` values that equal the context window (Kimi) caused a 400 on every request.
- DeepSeek gets `reasoning_content` replayed on assistant turns, which it requires once thinking is on.
- Sessions no longer break permanently after an interrupted turn. Histories now pass through pi-ai's `transformMessages` before conversion, which adds synthetic results for unanswered tool calls and drops empty assistant turns.
- Assistant `content` is always a string on the OpenAI route. A tool-call-only turn previously sent no content, which Azure rejects.
- A turn's tool results are merged into a single user message on the Anthropic route.
- Thinking blocks with empty text or no signature are no longer replayed on the Anthropic route.
- Removed a stray duplicate of the source under `.pi/extensions`.

## [1.0.3]

### Added
- Model metadata resolved from pi-ai's built-in catalogs, with per-model overrides via the `models` config key (#1).

## [1.0.0] - 2025-05-22

### Added
- Initial release.
