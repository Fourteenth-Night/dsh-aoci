---
name: aoci-cognition
description: 当用户要求"理解/接手这个代码库或系统"、"为项目建立认知"、"维护 AOCI 索引"、或需要数据库表级认知时使用。为 DeepSeek Harness 注入 AOCI-CODE 协作协议：通过 mcp__aoci-<slug>__* 九工具读取、维护受治理的全仓库认知地图。
---

# AOCI 认知协作协议（dsh-aoci）

AOCI-CODE 提供持久化、Git 版本化、可治理的代码库/数据库认知地图。语义条目（F/R/A/S、标签、Curation）**必须由你阅读真实源码后逐项生成**——禁止用 AST/import 扫描/正则/模板/脚本代写。

## 1. 工装
- 工具以命名空间 `mcp__aoci-<slug>__<tool>` 暴露，共九个：
  - Reads: `aoci_rules`、`aoci_overview`、`aoci_get_entries`、`aoci_search`
  - Maintenance: `aoci_maintain`、`aoci_update_entry`、`aoci_remove_entry`
  - Evidence: `aoci_header`、`aoci_report`
- 确定性运维（scan/verify/check/status/panel）可用插件自定义工具 `aoci_scan`、`aoci_verify`、`aoci_check`、`aoci_status`、`aoci_panel`。
- 若项目未配置/工具不可用，让用户先在插件设置页添加 Git 仓库（插件会 init + scan + 生成 MCP 条目）。

## 2. 会话开始与接手
1. 运行 `aoci_rules` 一次，确认行为契约仍可靠；
2. 运行一次完整 `aoci_overview`：获得系统架构、文件职责、模块边界、文件关系、关键约束、标签字典、FRAS 纪律；
3. 超过传输阈值时按 `continuation_required` 连续跟随 `next_cursor` 到 `completed=true`（不得用 aoci_get_entries 少量召回冒充完整认知），然后提交一次 attestation；
4. 认知有效（valid）后：不再重复 Overview、不重复 get_entries/search；因计划重排、工具重试、测试失败或小步骤而重读。

## 3. 允许的三种完整刷新原因
- `context_compaction`：宿主发生压缩，或模型确认系统全貌已丢失；
- `semantic_threshold`：AOCI 机器计算的语义变化达到项目阈值；
- `phase_transition`：一个主要阶段完成，进入另一个主要阶段。

## 4. 业务任务收尾（必然维护）
业务修改 → 格式化 → Lint/测试 → git diff 检查 → 无参 `aoci_maintain` → 完整处理 applied / repair_required / stopped → 语义候选经 `aoci_update_entry` 整批提交（保留 source_sha256 绑定）→ `aoci_verify`/`aoci_check` 证明 aligned → 回复。
维护后再修改任何受管文件会使旧结果失效，须重新维护。

## 5. 压缩后恢复（契约）
- 重新加载 `aoci_rules`（如不再可靠）；
- 以幂等 `refresh_event_id` 向 `aoci_overview` 声明 `context_compaction`（或 `phase_transition`）；
- 完成一次完整 Overview 光标、确认与 attestation；`check_only` 与 cognition probe 不是替代品；
- attestation 为 partial/fail 但传输完整、身份未变、治理对齐、无 Recovery/第三方冲突时：消费该 refresh generation、继续原 source-bound 任务，**禁止声称完整系统认知**，不在同一 generation 循环 Overview。

## 6. 数据库认知
- 凭据：只引用环境变量名 `AOCI_DB_<ID>_DSN`（管理员预先提供，最少权限、只读系统目录）；绝不要求用户把 DSN 粘贴到对话，插件/工具从不收集密钥；
- 流程：`aoci --repo <root> database source access --json` 预检 → 按证据哈希人工接受 → 由你撰写表级 FRAS → 条目进入治理 apply（离线，不重连数据库）；
- 查询：`cognition system impact` 回答"改这张表会影响哪些代码对象"。

## 7. 边界
- AOCI 只读源码与表结构，不读业务数据、不联网、不存凭据；面板只绑 loopback。
- 不要修改 `aoci.txt`、`.aoci/` 等托管资产之外的内容来"保持认知一致"；托管维护是合法行为，业务范围外修改不是。
- 用户明确禁止修改 aoci.txt/.aoci 时：不执行 Entry/Curation Apply，不前移 Baseline，不声称 aligned，如实报告 Stale。
