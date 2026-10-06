# dsh-aoci：基于 AOCI-CODE 认知基础设施的 DeepSeek Harness 插件

**摘要** —— 大型语言模型（LLM）在仓库级代码理解上受限于上下文窗口：既有的检索、摘要与智能体探索方法均于查询时构建视图，跨运行不稳定且难以持久。AOCI（AI-Oriented Cognition Infrastructure）提出"符号—语义"索引范式，以受治理、Git 版本化的纯文本认知资产为智能体提供跨会话、跨工具的仓库认知。本工作将 AOCI-CODE 以本地 stdio MCP（Model Context Protocol）服务器形态接入 DeepSeek Harness（DSH）插件体系，设计并实现：

- **确定性治理与语义创作相分离**：初始化、基线（Baseline）、验证（verify/check）等确定性操作由插件执行；FRAS（职责/关联/契约/约束）语义条目仅由模型在 AOCI 治理协议约束下创作；
- **动态 MCP 桥（Dynamic MCP Bridge）**：按需拉起 `aoci --repo <root> mcp` 并动态注册 `mcp__aoci-<slug>__*` 九件套工具，解除"预配置—重启"耦合，使智能体可自主指定仓库路径；
- **一键认知入口**：宿主斜杠命令 `/aoci <路径>` 在单次调用内完成路径解析、初始化、基线建立、服务器绑定与建索引指令提交（`agent.steer`）；
- **会话压缩契约桥接**：将 AOCI 的上下文压缩交接纪律（Whole-Index 正文不进压缩摘要、压缩后须以 `context_compaction` 与幂等 `refresh_event_id` 恢复完整认知）对齐到 DSH 压缩管线语义。

评测覆盖单元测试（15 例）、端到端链路（真实 `aoci` 二进制、真实 Git 仓库、九工具发现与真实工具调用）与真 Cordis 上下文集成自测（`/aoci` 一键流程）。代码以 MIT 许可开源；AOCI-CODE 采用 FSL-1.1-MIT（source-available）许可，本插件不捆绑其二进制，仅引导从官方发布渠道获取并校验。

---

## 1. 背景与动机

LLM 在超过一定规模的代码库（数十万行）上难以建立完整系统认知。现有方法——基于向量的检索、逐文件摘要、智能体自主探索——各在查询时构造不同视图，视图随运行变化，持久化结果通常是临时的而非系统的。AOCI 论文（arXiv:2605.02421）给出另一种路径：以"编码规则 + 条目"的符号—语义仓库表示，使 LLM 在任务开始前即可单次读取获得系统级蓝图；索引随代码演进增量维护，并由协议规则约束。

AOCI-CODE 是该范式的工程落地：Go 编写的 CLI 与 stdio MCP 服务器，暴露九个工具（读：`aoci_rules`/`aoci_overview`/`aoci_get_entries`/`aoci_search`；维护：`aoci_maintain`/`aoci_update_entry`/`aoci_remove_entry`；证据：`aoci_header`/`aoci_report`），本地优先、不联网、不存凭据。

DeepSeek Harness（DSH）为一可组合的智能体宿主，具备严格的插件加载协议（受限沙箱上下文、`ctx.get`/注入声明、前端 `__ModuleLoader__` 模块注册）。将 AOCI-CODE 接入 DSH，使 DSH 会话中的智能体开工即拥有受治理的仓库认知，是本工作的目标。

## 2. 相关工作

- **检索增强（RAG）与向量数据库**：按查询相关性召回片段，缺乏系统级、可审查的整体表示，且索引不随代码库演进治理。
- **AST / 结构索引**：可枚举符号与依赖，但无法承载职责、契约与不可推断约束等语义。
- **CodeGraph 等**：构建图结构，仍需模型二次推理，且持久化视图不稳定。
- **DSH 插件生态**：本插件参照 `dsh-task-board` 与 `dsh-better-sidebar` 的清单协议与双面架构，扩展出"执行型认知插件"模式。

AOCI-CODE 与上述工具定位不同：它不是检索替代品，而是"受治理的系统认知层"，本插件将其以标准 stdio MCP 形态接入 DSH。

## 3. 系统设计

### 3.1 总体架构

```
DSH Web GUI (client) ── RPC/HTTP ──▶ DSH Host 半边（本插件 host）
                                        │ ctx.tools 动态注册
                                        ▼
                              aoci mcp（stdio，按需拉起）
                                        │ MCP 九工具
                                        ▼
                          仓库认知资产（aoci.txt 等，Git 版本化）
```

插件采用双面结构：包根为宿主（node 进程）半边，`./client` 导出为浏览器半边（经 `__ModuleLoader__.load` 协议注册）。状态账本写入 profile 隔离的 `state/aoci/`（projects.json、runs.jsonl）。

### 3.2 宿主沙箱适配

DSH 宿主运行器以受限上下文执行插件：服务访问须符合注入声明；经实证，静态 bundle 应使用**直接属性访问**解析已挂载服务（缺失时降级），而非 `ctx.get()`（真实 Cordis 上下文不提供该方法）。`ctx.tools.register` 接受标准 `defineTool` 产物。

### 3.3 动态 MCP 桥

`AociBridge` 经 Node `child_process` 拉起 `aoci --repo <root> mcp`，以 `@modelcontextprotocol/sdk` 建立 `StdioClientTransport` + `Client` 连接，发现九工具并以 `mcp__aoci-<slug>__<tool>` 命名注册到 `ctx.tools`；解绑时注销工具并终止进程。该设计消除"每仓库一条静态配置 + 重启"的部署成本。

### 3.4 认知工作流与 AOCI 治理语义

实测确立三条 AOCI 行为规则并固化进实现：

1. `init` 仅治理未初始化仓库（已初始化则拒绝修改 Volumes v1 正式认知）→ 以 `aoci.txt` 存在性判定后条件执行；
2. `scan` 仅建立首次 Baseline（存在基线时拒绝重建，`--force` 亦不适用于 Managed Scope 基线）→ 以 `.aoci/baseline.json` 判定后条件执行；
3. 既有基线的维护走 `aoci_maintain`/无参 + `aoci_update_entry` 整批提交，`verify`/`check` 证明 `aligned`。

### 3.5 一键命令

宿主斜杠命令 `/aoci <路径>`（`ctx.inject(['commands'], …)` 注册）：解析路径（绝对路径，或相对设置项 `defaultRoot`）→ Git 校验 → 条件初始化/基线 → 绑定 → `agent.steer(createUserMessage(...))` 向当前智能体提交建索引指令，实现单次调用完成认知接入。

### 3.6 压缩契约

AOCI 规定压缩交接不得保留/摘要 Whole-Index 正文；压缩后须重载规则并以 `context_compaction` + 幂等 `refresh_event_id` 完成一次完整 Overview 与 Attestation。插件提供 `compactAociResults`（纯函数折叠）与 `compaction/end` 事件恢复指令注入（`installAociCompactionGuard`）。

## 4. 评测

- **单元测试**：15 例覆盖 slug/凭据引用派生、五段 cron 匹配、MCP 条目组装、压缩折叠、schema 默认值、相对路径解析；
- **端到端**（真实 `aoci` 0.1.0-rc18 二进制 + 真实 Git 仓库 + MCP SDK）：`init` 成功 → `scan` 建立基线（6 文件/586ms）→ `verify` 输出 JSON → **九工具全部发现** → `aoci_header` 真实调用返回索引身份；
- **集成自测**（真 Cordis 上下文 + 命令注入）：`/aoci` handler 注册 → 绑定 9/9 工具 → `agent.steer` 提交成功；
- **版本演进**：0.1.0→0.1.8 逐版修复（沙箱注入访问、apply 返回值 effect 语义、前端 `__ModuleLoader__` 协议、init/scan 基线语义等），详见 RELEASE.md。

## 5. 使用

```powershell
# 构建与打包
pnpm install
pnpm check        # typecheck + 单测 + 构建
pnpm pack         # dsh-aoci-<version>.tgz

# 装入 DSH profile
dsh plugin --profile <name> add ./dsh-aoci-<version>.tgz
# 重启 DSH 后，输入框执行：
#   /aoci D:\path\to\repo        （绝对路径）
#   /aoci ./relative                （需先配置 defaultRoot）
```

前提：从 AOCI-CODE 官方 Release 下载并校验 `aoci` 二进制（默认路径 `C:/aoci/bin/aoci.exe`），插件不捆绑二进制。

## 6. 局限与展望

- 应用完全退出后不承诺后台调度继续执行；
- 首次建索引耗时随规模线性增长（约 1 小时/20 万行）且消耗 API 额度；
- 动态桥的进程生命周期管理（崩溃重连）仍可强化；
- 数据库认知（MySQL/PostgreSQL/openGauss 表级 FRAS）与 `aoci ui` 面板内嵌为后续里程碑。

## 7. 许可与致谢

- 本插件：MIT（见 LICENSE）。
- AOCI-CODE：FSL-1.1-MIT（source-available），见 github.com/aoci-spec/aoci-code。
- 致谢：AOCI-CODE 开发团队与《AOCI: Symbolic-Semantic Indexing for Practical Repository-Scale Code Understanding with LLMs》作者；DeepSeek Harness SDK 团队；`dsh-task-board`（@linxin666/dsh-web-ui）与 `dsh-better-sidebar`（omdsh-dev/DSH-better-sidebar）在插件清单协议与双面架构上的开源参照。完整致谢见 RELEASE.md。

## 8. 参考文献

- J. Liu 等：《AOCI: Symbolic-Semantic Indexing for Practical Repository-Scale Code Understanding with LLMs》，arXiv:2605.02421。
- AOCI-CODE 官方文档：github.com/aoci-spec/aoci-code（README、docs/agent-integrations.md、docs/windows-host-agent.md、docs/install.md）。
- DeepSeek Harness SDK 包文档：@deepseek-ai/dsh-mcp-client、dsh-subprocess、dsh-tools、dsh-settings、dsh-commands、dsh-compaction、dsh-cordis-host-runner 等。
