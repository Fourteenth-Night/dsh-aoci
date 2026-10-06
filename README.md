# dsh-aoci

**AOCI-CODE cognition layer for DeepSeek Harness: one slash command gives agents governed, Git-versioned repository and database cognition.**

**简体中文版见 [README.zh-CN.md](README.zh-CN.md).**

---

## Abstract

`dsh-aoci` integrates [AOCI-CODE](https://github.com/aoci-spec/aoci-code) — a local-first stdio MCP server and Go CLI implementing the AOCI (AI-Oriented Cognition Infrastructure) paradigm — into the DeepSeek Harness (DSH) plugin ecosystem. It separates **deterministic governance** (initialisation, baseline establishment, verification) from **semantic authorship** (FRAS entries authored by the model under AOCI's governance protocol), and exposes cognition through three complementary surfaces:

- **Nine MCP tools** (`mcp__aoci-<slug>__aoci_rules` / `aoci_overview` / `aoci_get_entries` / `aoci_search` / `aoci_maintain` / `aoci_update_entry` / `aoci_remove_entry` / `aoci_header` / `aoci_report`), registered **on demand** by a dynamic MCP bridge instead of static per-repository configuration;
- **Seven deterministic tools** (`aoci_status`, `aoci_verify`, `aoci_check`, `aoci_scan`, `aoci_panel`, `aoci_use`, `aoci_unbind`) for governance, health, and agent-driven repository selection;
- **One-shot slash command** `/aoci <path>`: resolves the path (absolute, or relative to the `defaultRoot` setting), runs conditional initialisation/baseline, binds the MCP bridge, and submits the index-build instruction to the current agent via `agent.steer` — cognition onboarding in a single invocation.

AOCI-CODE is licensed FSL-1.1-MIT (source-available); this plugin **does not bundle** its binary — it guides checksum-verified downloads from the official release channel.

## Scope and Compatibility

- **Tested runtime**: DSH desktop >= 2.7.0 (API ^1.2.0); harness runtime ^0.1.1-rc.1 || ^0.1.5-alpha.1 (cordis ^4.0.2); web profile.
- **Peer dependencies** (provided by the host at boot): `@deepseek-ai/cordis`, `dsh-settings`, `dsh-system-prompt`, `dsh-tools`, `dsh-jobs`, `dsh-llm`, `react`, `react-dom`.
- **Runtime dependencies**: `schemastery`, `@modelcontextprotocol/sdk`.
- **Prerequisite binary**: `aoci` from the official AOCI-CODE Release (default `C:/aoci/bin/aoci.exe`), verified by SHA-256.

## Model-Facing Surface

| Surface | Names | Purpose |
|---|---|---|
| Cognition reads | `mcp__aoci-<slug>__aoci_rules`, `...__aoci_overview`, `...__aoci_get_entries`, `...__aoci_search` | Load and query the governed cognition map |
| Cognition maintenance | `...__aoci_maintain`, `...__aoci_update_entry`, `...__aoci_remove_entry` | Incremental, protocol-governed updates |
| Cognition evidence | `...__aoci_header`, `...__aoci_report` | Index identity and attestation |
| Deterministic governance | `aoci_status`, `aoci_verify`, `aoci_check`, `aoci_scan`, `aoci_panel` | Health, verification, baseline, panel |
| Agent-driven binding | `aoci_use <path>`, `aoci_unbind <slug>` | Autonomous repository selection |
| Slash command | `/aoci <path>` | One-shot onboarding (bind + instruct agent to build) |

## Architecture

```
DSH Web GUI (client) ── RPC/HTTP ──▶ DSH Host half (this plugin)
                                        │ ctx.tools dynamic registration
                                        ▼
                              aoci mcp (stdio, spawned on demand)
                                        │ nine MCP tools
                                        ▼
                          repository cognition assets (aoci.txt et al., Git-versioned)
```

1. **Dual-face plugin**: the package root is the host (Node) half; the `./client` export is the browser half registered through DSH's `__ModuleLoader__.load` protocol. State ledgers persist under profile-isolated `state/aoci/` (`projects.json`, `runs.jsonl`).
2. **Dynamic MCP bridge** (`AociBridge`): spawns `aoci --repo <root> mcp` via Node `child_process`, connects `StdioClientTransport` + `Client` from `@modelcontextprotocol/sdk`, discovers the nine tools, and registers them on `ctx.tools`; unbinding unregisters and terminates the process.
3. **AOCI governance semantics** (empirically fixed): `init` runs only for uninitialised repositories (probe `aoci.txt`); `scan` runs only when no Baseline exists (probe `.aoci/baseline.json`); existing Baselines are maintained via argument-less `aoci_maintain` plus batch `aoci_update_entry`, proven by `verify`/`check`.
4. **One-shot command**: `/aoci <path>` is registered via `ctx.inject(['commands'], …)` and submits the build instruction through `agent.steer(createUserMessage(...))` — the plan-mode submission pattern.
5. **Compaction-contract bridge**: `compactAociResults` (pure folding of Whole-Index bodies into receipts) and a `compaction/end` recovery hook (`installAociCompactionGuard`) align AOCI's compaction discipline with DSH session compaction.

## Installation

### Prerequisites

- A DeepSeek Harness profile (desktop >= 2.7.0 / runtime ^0.1.5-alpha.1 line).
- The `aoci` binary from the [official AOCI-CODE Release](https://github.com/aoci-spec/aoci-code/releases) (e.g. `aoci_0.1.0-rc18_windows_amd64.zip`), SHA-256 verified against the published `SHA256SUMS` and placed at a stable absolute path (default `C:/aoci/bin/aoci.exe`).

### Steps

```powershell
cd <plugin-checkout>
pnpm install
pnpm check            # typecheck + unit tests + build
pnpm pack             # dsh-aoci-<version>.tgz

dsh plugin --profile <name> add ./dsh-aoci-<version>.tgz
# restart DSH Desktop, then in the input box:
#   /aoci D:\path\to\repo        (absolute path)
#   /aoci ./relative                (requires defaultRoot configured)
```

After `/aoci`, the agent builds the index (rules → full Overview → batched Maintain → verify/check → aligned). Subsequent sessions reuse the same Git-versioned cognition; maintenance is automatic at task completion.

## Configuration Reference

| Key | Default | Description |
|---|---|---|
| `binaryPath` | `C:/aoci/bin/aoci.exe` | Stable absolute path to the verified `aoci` binary. |
| `defaultRoot` | `` (empty) | Base directory for relative paths in `/aoci` and `aoci_use`. |
| `mcp.serverNamePrefix` | `aoci` | Namespace prefix for dynamically registered MCP tools. |
| `mcp.toolCallTimeoutMs` | `120000` | Per-call timeout for bridged MCP tools. |
| `projects[].root` / `slug` / `locale` | — | Static projects (optional; dynamic binding via `/aoci` needs none). |
| `projects[].dbSources[]` | `[]` | Database sources (`sourceId`, `engine`, `databaseName`, `namespace`, `credentialEnv`). |
| `projects[].schedule.cron` | `0 3 * * *` | Nightly health-check schedule (verify-only by default). |

## Verification Methodology

The plugin was validated through four complementary approaches:

1. **Unit tests** (15 cases): slug/credential-reference derivation, five-field cron matching, MCP entry assembly, compaction folding, schema defaults, relative-path resolution.
2. **End-to-end chain** (real `aoci` 0.1.0-rc18 binary + real Git repository + MCP SDK): `init` succeeded; `scan` established a Baseline (6 files / 586 ms); `verify` emitted JSON; **all nine MCP tools discovered**; `aoci_header` returned index identity over MCP.
3. **Integration self-test** (real Cordis context + command injection): `/aoci` handler registered, bound 9/9 tools, and `agent.steer` submission succeeded.
4. **Loader composition**: `dsh --profile web --dump-config` resolves the plugin entry and its configuration without errors.

## Known Limitations

- Background scheduling is not guaranteed after the application fully exits.
- Initial index construction grows with repository size (≈1 hour per 200K lines) and consumes API quota.
- Dynamic-bridge process lifecycle (crash reconnection) can be strengthened further.
- Database cognition (MySQL/PostgreSQL/openGauss table-level FRAS) and embedding the `aoci ui` panel are later milestones.

## Security Considerations

- Credentials are referenced exclusively through environment-variable names (`AOCI_DB_<ID>_DSN`); the plugin never stores or embeds secrets.
- The `aoci` binary is downloaded from the official Release and verified by SHA-256; it is not bundled or redistributed (FSL-1.1-MIT).
- MCP/subprocess environments are scrubbed of credential-shaped variables before merging explicit overrides.
- All `/aoci/*` panel routes are loopback-only.

## Acknowledgments

The authors wish to thank:

- The **AOCI-CODE team** and the authors of *AOCI: Symbolic-Semantic Indexing for Practical Repository-Scale Code Understanding with LLMs* (arXiv:2605.02421), whose governed cognition paradigm and local-first MCP server make this plugin possible.
- The **DeepSeek Harness SDK team** for the plugin protocols this work builds upon — sandbox context and injection declarations, `ctx.tools`, `ctx.commands`, and the `__ModuleLoader__.load` frontend contract.
- The maintainers of `dsh-task-board` (@linxin666/dsh-web-ui) and `dsh-better-sidebar` (omdsh-dev/DSH-better-sidebar), whose dual-face plugin architecture and manifest protocols were direct references.
- `dsh-plan-mode` (@deepseek-ai/dsh-plan-mode) for the `ctx.inject(['commands'], …)` registration and `agent.steer` submission patterns.
- Early adopters and reviewers whose real-environment feedback drove the 0.1.x fix cycle.

See [RELEASE.md](RELEASE.md) for the full version history and acknowledgements.

## License and Attribution

MIT License (see [LICENSE](LICENSE)). AOCI-CODE is licensed FSL-1.1-MIT (source-available, [github.com/aoci-spec/aoci-code](https://github.com/aoci-spec/aoci-code)); this project holds no AOCI-CODE binaries and distributes none. The design rationale is documented in [docs/DESIGN.md](docs/DESIGN.md).
