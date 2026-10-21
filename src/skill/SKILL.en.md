---
name: aoci-cognition
description: Use when the user asks to understand or take over a codebase or system, establish or maintain repository cognition, or handle database table-level cognition. Implements the AOCI-CODE collaboration protocol for any MCP-capable coding agent: read and maintain a governed, Git-versioned cognition map through the nine aoci_* tools or the aggregate entry.
license: MIT
source: https://github.com/Fourteenth-Night/dsh-aoci
version: 0.3.0
---

# AOCI Cognition Collaboration Protocol (dsh-aoci)

AOCI-CODE provides a persistent, Git-versioned, governed cognition map of a codebase and its database schema. Semantic entries (F/R/A/S, tags, curation) **must be authored by you from the real source, item by item** — AST/import scans, regex, templates and scripts are forbidden as authoring substitutes.

## 1. Prerequisites and tooling
- The official `aoci` binary (**>= 0.1.0-rc21**, required for the Volumes v1 layout), a Git repository, and an MCP-capable host; DSH users install the dsh-aoci plugin.
- Tool channels (prefer the first available):
  1. `aoci_cognition` (static dsh-aoci tool, works in PTC and native modes): `action = rules | overview | get_entries | search | maintain | update_entry | remove_entry | header | report | validate | optimize`;
  2. `mcp__aoci-<slug>__*` (nine tools in native mode; the compact surface is `aoci_overview` + `aoci_call`);
  3. If neither is in the tool list, use the bundled `scripts/aoci-mcp-driver.mjs` (single-process MCP driver: `--repo <path> <tool> [args]` or `--steps steps.json`; outputs under state/aoci/tmp).
- **Overview and attestation must run in the same MCP process**, otherwise delivery state is lost.
> Launch constraint: do **not** spawn `aoci.exe ... mcp` with inherited console handles (`stdio: ['pipe','pipe','inherit']`) from a console-less host — Windows reports `0x800700E8` (ERROR_BROKEN_PIPE). Use the bundled driver (full pipes) or `['pipe','pipe','pipe']` + windowsHide.

## 2. Session start and hand-off
1. Call `aoci_rules` once to confirm the behaviour contract.
2. Load one complete `aoci_overview`: architecture, file responsibilities, module boundaries, relationships, constraints, tag dictionary, FRAS discipline.
3. When the overview exceeds the transport budget, follow `continuation_required` cursors until `completed=true`, then submit `model-cognition-attestation/v1` **in the same process** (exact index_sha256 / entry_sequence_sha256 / entry_count + challenge answers).
4. While cognition is valid: do not repeat the overview, re-read entries or re-search for small steps.

## 3. The only three full-refresh triggers
- `context_compaction` (host compacted context or the system picture is lost);
- `semantic_threshold` (machine-computed semantic changes reached the threshold);
- `phase_transition` (a major phase boundary).

## 4. Task completion (mandatory maintenance)
Business edits → format → lint/tests → git diff → argument-less `maintain` → handle applied / repair_required / stopped → submit semantic candidates in one batch via `update_entry` (keep machine-issued candidate_id/source_sha256) → prove aligned with `verify`/`check` → prove `complete=true` with `index agent guide`.

## 5. Entry authoring contract (validate before submit)
- Format: `filename[tag]: F:… | R:… | A:… | S:`
- Tags: `A+B+C+[D]+E` (two letters + importance 1-9 + optional D + letter, e.g. `EG7T`).
- `F<=160 runes`; `R<=360 runes, max 8 items` (`code:path`, comma-separated, `-` when none); `A<=400 runes, max 6 items` (`-` when none).
- `S` holds only non-inferable, error-preventing facts; quota by importance: C9-8<=600 / C7-4<=200 / C3-1<=50 tokens, `S:-` when none.
- Before submitting, call `aoci_cognition {action:"validate", args:{entries:[...]}}` for local pre-validation to avoid repair_required round trips.

## 6. Layout boundary (Volumes v1)
- Volumes v1 repositories (`aoci.txt` contains `#Format-Version: cognition-volumes/v1`) are maintained **only** through `aoci_maintain` / `aoci_update_entry`; legacy `index inventory/build/agent plan`, `scope` and `cognition onboard` commands are rejected ("cannot modify Volumes v1 formal cognition").
- `maintain` appends E-scale hints (line count → T/S/M/L); run `aoci_cognition {action:"optimize"}` for the quality review batch.

## 7. Compaction recovery contract
Reload `aoci_rules`; declare `context_compaction` with an idempotent `refresh_event_id`; complete one full Overview cursor, confirmation and attestation (`check_only` is not a substitute). If attestation resolves partial/failed but transport was complete, identity unchanged and governance aligned with no recovery/third-party conflict: consume the refresh generation, continue the task, never claim complete system cognition, and do not loop the Overview in the same generation.

## 8. Database cognition
- Credentials: reference only environment-variable names (`AOCI_DB_<ID>_DSN`, least-privilege read-only); never ask the user to paste a DSN.
- Flow: `database source access --json` preflight → human acceptance of the evidence hash → author table-level FRAS → governed apply (offline).
- Queries: `cognition system impact` answers "which code objects might a database change reach".

## 9. Boundaries
- AOCI reads source and schema metadata only: no business data, no network egress, no stored credentials; any panel binds loopback only.
- Do not modify anything outside the managed assets (aoci.txt / .aoci/) to "keep cognition consistent".
- When the user forbids touching aoci.txt/.aoci/: do not apply entries/curation, do not advance the baseline, do not claim aligned; report Stale honestly.
- After maintenance changes managed assets, remind the user to `git commit` (cognition is versioned with the repository).