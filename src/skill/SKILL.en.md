---
name: aoci-cognition
description: Use when the user asks to understand or take over a codebase or system, establish or maintain repository cognition, or handle database table-level cognition. Implements the AOCI-CODE collaboration protocol for any MCP-capable coding agent: read and maintain a governed, Git-versioned cognition map through the nine aoci_* tools.
license: MIT
source: https://github.com/Fourteenth-Night/dsh-aoci
version: 0.2.0
---

# AOCI Cognition Collaboration Protocol (dsh-aoci)

AOCI-CODE provides a persistent, Git-versioned, governed cognition map of a codebase and its database schema. Semantic entries (F/R/A/S, tags, curation) **must be authored by you from the real source, item by item** — AST/import scans, regex, templates and scripts are forbidden as authoring substitutes.

## 1. Tooling

The nine tools are exposed under the `mcp__aoci-<slug>__<tool>` namespace (the server runs `aoci --repo <root> mcp` over stdio):

- Reads: `aoci_rules`, `aoci_overview`, `aoci_get_entries`, `aoci_search`
- Maintenance: `aoci_maintain`, `aoci_update_entry`, `aoci_remove_entry`
- Evidence: `aoci_header`, `aoci_report`

Deterministic operations (scan/verify/check/status/panel) are available from the host plugin as `aoci_scan`, `aoci_verify`, `aoci_check`, `aoci_status`, `aoci_panel`. If the project is not configured or the tools are unavailable, ask the user to add the Git repository first (the plugin runs init + scan and generates the MCP entries).

## 2. Session start and hand-off

1. Run `aoci_rules` once to confirm the behaviour contract still holds.
2. Run one complete `aoci_overview`: system architecture, file responsibilities, module boundaries, file relationships, key constraints, tag dictionary, FRAS discipline.
3. When the overview exceeds the transport budget, follow `continuation_required` cursors continuously until `completed=true` (do not substitute partial `aoci_get_entries` recalls for full cognition), then submit one attestation.
4. While cognition is valid: do not repeat the overview, re-read entries, or re-search for plan reshuffles, tool retries, test failures, or small steps.

## 3. The only three full-refresh triggers

- `context_compaction`: the host compacted context, or you know the system picture is lost;
- `semantic_threshold`: AOCI's machine-computed semantic change count reached the project threshold;
- `phase_transition`: one major phase completed and a new major phase begins.

## 4. Task completion (mandatory maintenance)

Business edits → format → lint/tests → review git diff → argument-less `aoci_maintain` → handle `applied` / `repair_required` / `stopped` completely → submit the semantic candidates in one batch via `aoci_update_entry` (keeping `source_sha256` binding) → prove `aligned` with `aoci_verify`/`aoci_check` → reply. Editing any managed file afterwards invalidates the maintenance result; maintain again.

## 5. Compaction recovery contract

- Reload `aoci_rules` if it may no longer be reliable;
- Declare `context_compaction` (or `phase_transition`) on `aoci_overview` with an idempotent `refresh_event_id`;
- Complete one full Overview cursor, confirmation and attestation; `check_only` and cognition probes are not substitutes;
- If attestation resolves partial/failed but transport was complete, identity unchanged, governance aligned and no Recovery/third-party conflict: consume this refresh generation, continue the source-bound task, **never claim complete system cognition**, and do not loop the Overview within the same generation.

## 6. Database cognition

- Credentials: reference only environment-variable names (`AOCI_DB_<ID>_DSN`; pre-provisioned, least-privilege, read-only catalogs); never ask the user to paste a DSN into the conversation; the plugin/tools never collect secrets;
- Flow: `aoci --repo <root> database source access --json` preflight → human acceptance of the evidence hash → author table-level FRAS → entries enter governed apply (offline; no database reconnection while writing);
- Queries: `cognition system impact` answers "which code objects might a database change reach".

## 7. Boundaries

- AOCI reads source code and schema metadata only: no business data, no network egress, no stored credentials; any panel binds loopback only.
- Do not modify managed assets (aoci.txt / .aoci/) to "keep cognition consistent" outside the protocol; managed maintenance is legitimate, out-of-scope business edits are not.
- When the user explicitly forbids modifying aoci.txt/.aoci: do not apply Entry/Curation, do not advance the Baseline, do not claim `aligned`; report Stale honestly.

## Prerequisites

- The `aoci` CLI binary from the official AOCI-CODE Release (github.com/aoci-spec/aoci-code), checksum-verified against the published SHA256SUMS, on a stable absolute path (e.g. `C:/aoci/bin/aoci.exe`); nothing is bundled.
- A Git repository.
- An MCP-capable host with the nine AOCI tools connected — via `aoci --repo <root> init --agent <host>` (Claude Code / Codex / Cursor / OpenCode, optionally `--hooks`) or the dsh-aoci DeepSeek Harness plugin.
- Database cognition (optional): a read-only `AOCI_DB_<ID>_DSN` environment variable reference.
