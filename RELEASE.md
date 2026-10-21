# 发布清单（Release Notes）

## 版本历史

| 版本 | 主要内容 |
|---|---|
| 0.2.10 | ① 驱动脚本修复 `0x800700E8`（ERROR_BROKEN_PIPE）：不再继承父进程 console 句柄，改为全管道 + windowsHide + stderr 捕获（DSH 无 console 宿主下启动 `aoci.exe mcp` 曾报错）；② SKILL 增加启动约束；③ 索引维护对齐 |
| 0.2.9 | ① **大结果防截断**：aoci_cognition 结果超过 12K chars 时写入 state/aoci/tmp/ 并返回 body_file/body_sha256/body_bytes/end_marker + HEAD 预览，避免 overview 被宿主截断导致 attestation 误判； ② **受管子进程回退**：aoci_verify/check 等在 PTC 子分派下报「子进程服务未挂载」时自动降级 node spawn； ③ 索引随 0.2.8 会话优化批次更新（34 条替换，E 档 5→0，verify/check 通过） |
| 0.2.8 | **关键修复：DSH 0.2.x 服务访问注入门控**——`ctx.tools`/`ctx.settings`/`ctx.systemPrompt` 改用 `ctx.inject([...], scoped => …)`（原先直接属性访问抛 `cannot get property "tools" without inject`，导致全部工具（含 `aoci_cognition`）与动态桥工具注册失败、系统提示/设置未注入）。修复后 10 个确定性工具与 2 个 compact MCP 工具可正常注册 |
| 0.2.7 | **驱动脚本零依赖化**：`scripts/aoci-mcp-driver.mjs` 改为原生 JSON-RPC over stdio（不再 import @modelcontextprotocol/sdk），任何 Node（含系统 node）可直接运行，修复 `ERR_MODULE_NOT_FOUND` 导致的回退失败；保留 `--preset read/overview/maintain/optimize`、`--args-file`、`--out-dir/--clean`。索引维护对齐（48 条目、verify/check 通过） |
| 0.2.6 | ① Skill（中英）重写：工具通道三级优先（aoci_cognition → mcp__aoci-* → 随包驱动脚本）、Volumes v1 边界、条目撰写契约（先 validate）、attestation 同进程要求、收尾 guide 与 git commit 提醒；② 驱动脚本新增 `--preset read|overview|maintain|optimize`，减少多轮调用；③ 质量优化复核通过：`cognition_optimization` 返回 0 目标（48/48 条目、budget healthy、drift 全空） |
| 0.2.5 | P0/P1 落地：① 工具注册日志与 `aoci_status` 自检（`registeredTools=`，注册失败不再静默）；② `/aoci` 指令双路径（优先 `aoci_cognition`/`mcp__aoci-*`，不可见时使用随包 `scripts/aoci-mcp-driver.mjs`，强调 overview+attestation 必须同一 MCP 进程）；③ 新增 `aoci_cognition action="optimize"`（映射 maintain intent=cognition_optimization，返回 review-required 质量批次）；④ 驱动脚本输出写 `state/aoci/tmp` 并支持 --clean；⑤ steer 提示 maintain 自动附带 E 档建议 |
| 0.2.4 | P0/P1 可用性改进：① `/aoci` 指令与系统提示内置 Entry 撰写契约（F≤160/R≤360≤8项/A≤400≤6项/S 按重要度档、标签 A+B+C+[D]+E）与正确顺序（overview→attestation→maintain→update_entry→verify/check→guide）；② 新增 `aoci_cognition` action=`validate` 本地预校验，`update_entry` 提交前自动预校验，减少 repair_required 往返；③ maintain 结果自动附 E 档建议（行数→T/S/M/L）；④ 同仓库并发写锁（state/aoci/locks）；⑤ Volumes v1 错误提示映射（禁用 legacy index/scope/onboard）；⑥ `minAociVersion` 默认升至 0.1.0-rc21 |
| 0.2.3 | 新增静态工具 `aoci_cognition`（action=rules/overview/get_entries/search/maintain/update_entry/remove_entry/header/report）：在插件加载时注册、懒绑定仓库，**PTC 与 native 工具模式均可用**（解决 PTC 会话拿不到动态 MCP 工具、无法建索引的问题）；桥新增 `ensure`/`call`；共享仓库定位器（上溯父目录/defaultRoot/最近项目） |
| 0.2.2 | `/aoci` 无参定位增加多级回退：会话工作区 → 上溯父目录（最多 8 层）→ `defaultRoot` → 最近绑定的项目；定位失败时给出可操作提示（解决桌面端默认工作区不是 Git 仓库时报错的问题） |
| 0.2.1 | **适配 DSH 0.2.0-rc.2（cordis 4.0.4）**。① 工具面优化：`toolSurface=compact`（默认）仅暴露 `aoci_overview` + 聚合入口 `aoci_call`，确定性工具合并为 `aoci_query`，模型可见工具从 20 个降至 11 个；② 上下文预算：`ctx.tokenMeter` 压力感知 + 压缩折叠策略（fold/fold+compact）；③ 增量刷新：`aoci_refresh`（记录 lastHead + git diff 变更集 + 分批维护指令）、`aoci_build_status`；④ 治理审计：结构化 `aoci-events.jsonl` + `aoci_audit` 报告 + `governance` 分级；⑤ 最小权限：aoci 经 `ctx.subprocess` 受管执行（env 白名单/超时/取消/有界输出）、`readOnly` 模式、`httpRoutes` 默认关闭；⑥ 二进制安全：SHA-256 + `minAociVersion` 校验与缓存；⑦ 质量：依赖矩阵升级至 0.2.0-rc.2、28 单测、GitHub Actions CI。另含 0.2.0 早期功能：`/aoci` 无参自动定位、二进制自动探测、动态绑定持久化、桥自动重连、git 漂移状态、`/aoci` 选项化 |
| 0.2.0 | `/aoci` 无参自动定位当前工作区仓库；二进制自动探测（binaryAutoDetect）；System Cognition 查询工具（aoci_relations / aoci_impact / aoci_lineage）；aoci_db 数据库只读预检；桥进程崩溃自动重连；git 漂移检测（aoci_status 报 head/workingDirty）；动态绑定持久化（upsertProject）；`/aoci`/aoci_use 选项化（--locale/--scope/--agent/--skip-scan/--db） |
| 0.1.0 | 初始可运行版本：双面插件骨架、证据账本、确定性 CLI 封装、设置页、skill |
| 0.1.1 | 修复 DSH 宿主沙箱服务访问：全部服务读取改为安全属性访问（消除 `cannot get property ... without inject` 启动失败） |
| 0.1.2 | 修复 apply 返回值 effect 语义（`Invalid effect`）：apply 不返回值 |
| 0.1.3 | client 半边插槽注册异常隔离（防浏览器端崩溃） |
| 0.1.4 | 前端 client 产物改按 DSH `__ModuleLoader__.load` 协议构建（修复 `Cannot use import statement outside a module`） |
| 0.1.5 | 动态 MCP 桥（`AociBridge`）+ `aoci_use`/`aoci_unbind` 工具 + `defaultRoot` 设置；服务访问语义修正（直接属性访问，恢复系统段/设置/路由） |
| 0.1.6 | 修复 `init` 对已初始化仓库的条件执行（探测 `aoci.txt`） |
| 0.1.7 | 宿主斜杠命令 `/aoci <路径>` 一键建认知（含 `agent.steer` 提交建索引指令）；基线条件化（探测 `.aoci/baseline.json`） |
| 0.1.8 | `/aoci` 命令注册改用 `ctx.inject(['commands'], …)` 官方模式并记录注册日志（修复命令未出现在输入框） |

## 发布内容清单

- 双面插件：`lib/index.mjs`（host，ESM）、`lib/client.js`（client，`__ModuleLoader__.load` 协议）、`lib/skill/SKILL.md`（aoci-cognition 技能）；
- 清单文件：`package.json`（含 `dsh` bundle/compatibility/client 声明）、`dsh.plugin.json`、`cordis.patch.yml`；
- 文档：README.md（English，默认展示）、README.zh-CN.md（简体中文）、docs/DESIGN.md（完整方案设计）、RELEASE.md（本文）；
- 许可：MIT（LICENSE）。

## 依赖与合规

- 运行时依赖：`schemastery`、`@modelcontextprotocol/sdk`；peer 依赖（宿主提供）：`@deepseek-ai/cordis`、`dsh-settings`、`dsh-system-prompt`、`dsh-tools`、`dsh-jobs`、`dsh-llm`、`react`、`react-dom` 等；
- **不捆绑 AOCI-CODE 二进制**（FSL-1.1-MIT source-available）：插件引导从官方 Release 下载并做 SHA-256 校验；
- 全部 `@deepseek-ai/*` 依赖均取自 npm 公开包（MIT）。

## 发布前校验（每次发布须复跑）

```powershell
pnpm install
pnpm check     # typecheck + 28 单元测试 + 构建
pnpm pack      # 产出 dsh-aoci-<version>.tgz，确认包内容含：cordis.patch.yml / dsh.plugin.json / lib/index.mjs / lib/client.js / lib/skill/SKILL.md / README.md / README_EN.md / docs/DESIGN.md / RELEASE.md / LICENSE / package.json
```

## 致谢（Acknowledgements）

本项目的开发与排障过程参考并受益于以下开源工作，特此致谢：

- **AOCI-CODE 开发团队**与《AOCI: Symbolic-Semantic Indexing for Practical Repository-Scale Code Understanding with LLMs》作者（arXiv:2605.02421）—— 提供了认知范式、治理协议与本地优先 MCP 服务器实现；
- **DeepSeek Harness SDK 团队** —— `@deepseek-ai/*` 包文档与插件协议（沙箱上下文、注入声明、`__ModuleLoader__` 前端模块协议、`ctx.commands` 斜杠命令面、`dsh-cordis-host-runner` 守护层），为本插件的合规接入提供了边界与实现依据；
- **`dsh-task-board`（@linxin666/dsh-web-ui）** —— 双面插件、真实执行、profile 隔离持久化与状态账本模式的直接参照；
- **`dsh-better-sidebar`（omdsh-dev/DSH-better-sidebar）** —— 清单字段、bundle patch 通道与真实静态插件服务访问模式的参照；
- **`dsh-plan-mode`（@deepseek-ai/dsh-plan-mode）** —— `ctx.inject(['commands'], …)` 注册与 `agent.steer(createUserMessage(...))` 提交模式的开源参照；
- 以及所有为本插件早期版本提供真实环境测试反馈的用户与社区成员。

> 若本清单遗漏任何应当致谢的项目，欢迎通过 Issue 补充，将予以及时更正。