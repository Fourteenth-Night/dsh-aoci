---
name: aoci-cognition
description: 当用户要求"理解/接手这个代码库或系统"、"为项目建立认知"、"维护 AOCI 索引"、或需要数据库表级认知时使用。为 MCP 宿主（含 DeepSeek Harness 的 dsh-aoci 插件）注入 AOCI-CODE 协作协议：通过九个 aoci_* 工具或聚合入口读取、维护受治理的全仓库认知地图。
---

# AOCI 认知协作协议（dsh-aoci）

AOCI-CODE 提供持久化、Git 版本化、可治理的代码库/数据库认知地图。语义条目（F/R/A/S、标签、Curation）**必须由你阅读真实源码后逐项生成**——禁止用 AST/import 扫描/正则/模板/脚本代写。

## 1. 前置与工装
- 需要官方 AOCI-CODE Release 的 `aoci` 二进制（**≥ 0.1.0-rc21**，Volumes v1 布局必需），Git 仓库，以及支持 stdio MCP 的宿主；DSH 用户安装 dsh-aoci 插件即可。
- 工具通道（按可用性优先）：
  1. `aoci_cognition`（dsh-aoci 静态工具，PTC/native 均可用）：`action = rules | overview | get_entries | search | maintain | update_entry | remove_entry | header | report | validate | attest | optimize`；
  2. `mcp__aoci-<slug>__*`（native 模式直连九工具；compact 面为 `aoci_overview` + `aoci_call`）；
  3. 以上都不在工具列表时：使用随包 `scripts/aoci-mcp-driver.mjs`（单进程驱动 MCP：`--repo <路径> <tool> [args]` 或 `--steps steps.json`；输出写 state/aoci/tmp）。
- **overview 与 attestation 必须在同一个 MCP 进程内完成**，否则会丢 delivery 状态。
> 启动约束：**不要**用 `stdio: ['pipe','pipe','inherit']` 之类继承 console 句柄的方式拉起 `aoci.exe ... mcp`——DSH 宿主无 console 时会报 `0x800700E8`（ERROR_BROKEN_PIPE）。使用随包驱动脚本（全管道）或 `stdio: ['pipe','pipe','pipe']` + windowsHide。


## 2. 会话开始与接手
1. `aoci_rules` 一次，确认行为契约；
2. 一次完整 `aoci_overview`：架构、文件职责、模块边界、关系、约束、标签字典、FRAS 纪律；
3. 超过传输阈值时按 `continuation_required` 连续跟随 `next_cursor` 到 `completed=true`，提交 attestation 前先单独提交 `host_delivery_confirmation`（`version: overview-delivery-receipt/v1`，不可与 attestation 合并在同一请求），并用 `aoci_cognition {action:"attest", args:{...}}` 校验字段，**同一进程**内提交 `model-cognition-attestation/v1`（精确 index_sha256 / entry_sequence_sha256 / entry_count + Challenge 答案；object_identity 必须用仓库相对路径，如 `src/host/tools.ts`，裸文件名会失配）；
4. 认知有效后：不重复 Overview、不重复 get_entries/search。

## 3. 允许的三种完整刷新原因
- `context_compaction`：宿主压缩或系统全貌丢失；
- `semantic_threshold`：机器语义变化达到阈值；
- `phase_transition`：主要阶段切换。

## 4. 业务任务收尾（必然维护）
业务修改 → 格式化 → Lint/测试 → git diff → 无参 `maintain` → 完整处理 applied/repair_required/stopped → 语义候选经 `update_entry` **整批**提交（保留机器下发的 candidate_id/source_sha256）→ `verify`/`check` 证明 aligned → `index agent guide` 证明 `complete=true`。

## 5. 条目撰写契约（先 validate 再提交）
- 格式：`filename[tag]: F:… | R:… | A:… | S:`
- 标签：`A+B+C+[D]+E`（两个字母 + 重要度 1-9 + 可选 D + 字母，如 `EG7T`）
- `F≤160 runes`；`R≤360 runes 且 ≤8 项`（`code:path` 逗号分隔，无则 `-`）；`A≤400 runes 且 ≤6 项`（无则 `-`）
- `S` 只写不可推断、防错事实，配额按重要度：C9-8≤600 / C7-4≤200 / C3-1≤50 tokens，无则 `S:-`
- 提交前先调 `aoci_cognition {action:"validate", args:{entries:[...]}}` 本地预校验，避免 `repair_required` 往返。

## 6. 布局边界（Volumes v1）
- Volumes v1 仓库（`aoci.txt` 含 `#Format-Version: cognition-volumes/v1`）**只能**用 `aoci_maintain` / `aoci_update_entry` 维护；旧版 `index inventory/build/agent plan`、`scope`、`cognition onboard` 命令会被拒绝（"cannot modify Volumes v1 formal cognition"）。
- `maintain` 会自动附 E 档建议（行数→T/S/M/L）；质量优化使用 `aoci_cognition {action:"optimize"}`，按 review-required 批次逐项修复。

## 7. 压缩后恢复（契约）
重新加载 `aoci_rules`；以幂等 `refresh_event_id` 声明 `context_compaction`；完成一次完整 Overview 光标、确认与 attestation（check_only 不是替代品）；attestation 为 partial/failed 但传输完整、身份未变、治理对齐且无 Recovery/第三方冲突时：消费该 refresh generation、继续原任务，不声称完整系统认知、不在同一 generation 循环 Overview。

## 8. 数据库认知
- 凭据只引用环境变量名 `AOCI_DB_<ID>_DSN`（管理员预先提供，只读最小权限）；绝不要求用户粘贴 DSN。
- 流程：`database source access --json` 预检 → 人工接受证据哈希 → 模型撰写表级 FRAS → 条目进入治理 apply（离线）。
- 查询：`cognition system impact` 回答"改这张表会影响哪些代码对象"。

## 9. 边界
- AOCI 只读源码与表结构，不读业务数据、不联网、不存凭据；面板仅 loopback。
- 不要修改 `aoci.txt`、`.aoci/` 等托管资产之外的内容来"保持认知一致"；托管维护是合法行为。
- 用户明确禁止修改 aoci.txt/.aoci 时：不执行 Entry/Curation Apply，不前移 Baseline，不声称 aligned，如实报告 Stale。
- 维护后如修改了托管资产，提醒用户 `git commit`（认知随仓库版本化）。