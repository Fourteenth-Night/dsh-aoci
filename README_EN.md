# dsh-aoci: An AOCI-CODE Cognition Layer for DeepSeek Harness

**Abstract** — Large language models (LLMs) face fundamental limits in repository-scale code understanding imposed by context windows. Retrieval, summarisation, and agent exploration each construct a different view at query time; the view varies across runs, and persistence is ad-hoc rather than systematic. AOCI (AI-Oriented Cognition Infrastructure) proposes a symbolic-semantic indexing paradigm: a governed, Git-versioned, plain-text cognition asset that provides agents with persistent, cross-session repository knowledge. This work integrates AOCI-CODE — a local-first stdio MCP (Model Context Protocol) server and Go CLI — into the DeepSeek Harness (DSH) plugin ecosystem, contributing:

- **Separation of deterministic governance from semantic authorship**: initialisation, baseline establishment, and verification (`verify`/`check`) are executed deterministically by the plugin, while FRAS (responsibility/relationship/contract/constraint) entries are authored exclusively by the model under AOCI's governance protocol;
- **A Dynamic MCP Bridge**: spawns `aoci --repo <root> mcp` on demand and registers the nine tools as `mcp__aoci-<slug>__*`, removing the "pre-configure-and-restart" coupling and enabling agents to select repository paths autonomously;
- **One-shot cognition entry**: the host slash command `/aoci <path>` completes path resolution, conditional initialisation, baseline establishment, server binding, and index-build instruction submission (`agent.steer`) within a single invocation;
- **Compaction-contract bridging**: aligns AOCI's context-compaction discipline (Whole-Index bodies must not enter compaction handoffs; after compaction, cognition must be restored via `context_compaction` with an idempotent `refresh_event_id` followed by a complete Overview and attestation) with DSH compaction semantics.

Evaluation comprises 15 unit tests, an end-to-end chain against the real `aoci` binary and a real Git repository (nine-tool discovery and genuine tool invocation), and an integration self-test in a real Cordis context (`/aoci` one-shot flow). The plugin is released under the MIT license; AOCI-CODE is licensed FSL-1.1-MIT (source-available), and this plugin neither bundles nor redistributes its binary — it guides checksum-verified downloads from the official release channel.

---

## 1. Background and Motivation

LLMs struggle to form complete system cognition beyond a certain codebase scale (hundreds of thousands of lines). Existing methods — vector retrieval, per-file summarisation, autonomous agent exploration — each construct different query-time views that vary across runs and rarely persist in a systematic, reviewable form. The AOCI paper (arXiv:2605.02421) offers an alternative: a symbolic-semantic repository representation of encoding rules followed by entries, readable by an LLM in a single pass before any task; the index is maintained incrementally as code evolves, under protocol rules.

AOCI-CODE is the engineering realisation of this paradigm: a Go CLI and stdio MCP server exposing nine tools (reads: `aoci_rules`, `aoci_overview`, `aoci_get_entries`, `aoci_search`; maintenance: `aoci_maintain`, `aoci_update_entry`, `aoci_remove_entry`; evidence: `aoci_header`, `aoci_report`). It is local-first: read-only on the repository, no network egress, no stored credentials.

DeepSeek Harness (DSH) is a composable agent host with strict plugin-loading protocols: a restricted sandbox context with injection declarations, and a browser-side `__ModuleLoader__.load` registration protocol. Embedding AOCI-CODE into DSH gives every DSH session agent governed, persistent repository cognition at the start of work.

## 2. Related Work

- **Retrieval-Augmented Generation and vector databases**: recall relevant fragments per query but lack a system-level, reviewable representation; indices are not governed as code evolves.
- **AST / structural indexing**: enumerate symbols and dependencies but cannot carry responsibilities, contracts, or non-inferable constraints.
- **CodeGraph and similar**: build graph views that still require secondary model reasoning, with unstable persistence.
- **DSH plugin ecosystem**: this plugin references the manifest protocol and dual-face architecture of `dsh-task-board` and `dsh-better-sidebar`, extending the "execution-oriented cognition plugin" pattern.

AOCI-CODE is not a retrieval substitute; it is a governed system-cognition layer. This plugin bridges it into DSH over standard stdio MCP.

## 3. System Design

### 3.1 Architecture Overview

```
DSH Web GUI (client) ── RPC/HTTP ──▶ DSH Host half (this plugin)
                                        │ dynamic ctx.tools registration
                                        ▼
                              aoci mcp (stdio, spawned on demand)
                                        │ nine MCP tools
                                        ▼
                          repository cognition assets (aoci.txt et al., Git-versioned)
```

The plugin is dual-faced: the package root is the host (Node) half; the `./client` export is the browser half registered via the `__ModuleLoader__.load` protocol. State ledgers are persisted under profile-isolated `state/aoci/` (`projects.json`, `runs.jsonl`).

### 3.2 Host Sandbox Adaptation

DSH's host runner executes plugins under a restricted context. Empirical verification showed that static bundles should resolve mounted services via **direct property access** (degrading gracefully when absent) rather than `ctx.get()` (which the real Cordis context does not provide). `ctx.tools.register` accepts standard `defineTool` outputs.

### 3.3 Dynamic MCP Bridge

`AociBridge` spawns `aoci --repo <root> mcp` via Node `child_process`, connects a `StdioClientTransport` + `Client` from `@modelcontextprotocol/sdk`, discovers the nine tools, and registers them on `ctx.tools` as `mcp__aoci-<slug>__<tool>`. Unbinding unregisters the tools and terminates the process. This eliminates the per-repository static configuration and restart cost.

### 3.4 Cognition Workflow and AOCI Governance Semantics

Three AOCI behavioural rules were established empirically and fixed into the implementation:

1. `init` governs only uninitialised repositories (it refuses to modify Volumes v1 formal cognition otherwise) — executed conditionally after probing for `aoci.txt`;
2. `scan` establishes only the first Baseline (refused when a Baseline exists; `--force` does not apply to a Managed Scope Baseline) — executed conditionally after probing `.aoci/baseline.json`;
3. Maintenance on an existing Baseline proceeds via argument-less `aoci_maintain` plus batch `aoci_update_entry`, with `verify`/`check` proving `aligned`.

### 3.5 One-shot Command

The host slash command `/aoci <path>` (registered via `ctx.inject(['commands'], …)`) resolves the path (absolute, or relative to the `defaultRoot` setting), validates the Git repository, runs conditional initialisation/baseline, binds the bridge, and submits the index-build instruction to the current agent via `agent.steer(createUserMessage(...))` — a single invocation completes cognition onboarding.

### 3.6 Compaction Contract

AOCI requires that compaction handoffs retain neither Whole-Index bodies nor summaries; after compaction, agents must reload rules and restore cognition via `context_compaction` with an idempotent `refresh_event_id`, completing one full Overview with attestation. The plugin provides `compactAociResults` (a pure folding function) and a `compaction/end` recovery-instruction hook (`installAociCompactionGuard`).

## 4. Evaluation

- **Unit tests**: 15 cases covering slug/credential-reference derivation, five-field cron matching, MCP entry assembly, compaction folding, schema defaults, and relative-path resolution;
- **End-to-end** (real `aoci` 0.1.0-rc18 binary + real Git repository + MCP SDK): `init` succeeded; `scan` established a Baseline (6 files / 586 ms); `verify` emitted JSON; **all nine tools discovered**; `aoci_header` returned index identity over MCP;
- **Integration self-test** (real Cordis context + command injection): `/aoci` handler registered, bound 9/9 tools, and `agent.steer` submission succeeded;
- **Version evolution**: 0.1.0–0.1.8 with per-version fixes (sandbox injection access, apply-return effect semantics, frontend `__ModuleLoader__` protocol, init/scan baseline semantics); see RELEASE.md.

## 5. Usage

```powershell
pnpm install
pnpm check        # typecheck + unit tests + build
pnpm pack         # dsh-aoci-<version>.tgz

dsh plugin --profile <name> add ./dsh-aoci-<version>.tgz
# after restarting DSH, run in the input box:
#   /aoci D:\path\to\repo        (absolute path)
#   /aoci ./relative                (requires defaultRoot configured)
```

Prerequisite: download and verify the `aoci` binary from the official AOCI-CODE Release (default path `C:/aoci/bin/aoci.exe`); the plugin does not bundle the binary.

## 6. Limitations and Future Work

- Background scheduling is not guaranteed after the application fully exits;
- Initial index construction grows linearly with repository size (≈1 hour per 200K lines) and consumes API quota;
- Lifecycle management of dynamic-bridge processes (crash reconnection) can be strengthened;
- Database cognition (MySQL/PostgreSQL/openGauss table-level FRAS) and embedding the `aoci ui` panel are later milestones.

## 7. License and Acknowledgements

- This plugin: MIT (see LICENSE).
- AOCI-CODE: FSL-1.1-MIT (source-available), see github.com/aoci-spec/aoci-code.
- Acknowledgements: the AOCI-CODE team and the authors of *AOCI: Symbolic-Semantic Indexing for Practical Repository-Scale Code Understanding with LLMs*; the DeepSeek Harness SDK team; and the open-source references `dsh-task-board` (@linxin666/dsh-web-ui) and `dsh-better-sidebar` (omdsh-dev/DSH-better-sidebar) for plugin-manifest protocols and dual-face architecture. Full acknowledgements in RELEASE.md.

## 8. References

- J. Liu et al., *AOCI: Symbolic-Semantic Indexing for Practical Repository-Scale Code Understanding with LLMs*, arXiv:2605.02421.
- AOCI-CODE documentation: github.com/aoci-spec/aoci-code (README, docs/agent-integrations.md, docs/windows-host-agent.md, docs/install.md).
- DeepSeek Harness SDK package documentation: @deepseek-ai/dsh-mcp-client, dsh-subprocess, dsh-tools, dsh-settings, dsh-commands, dsh-compaction, dsh-cordis-host-runner, et al.
