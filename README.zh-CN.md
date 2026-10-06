# dsh-aoci

**面向 DeepSeek Harness 的 AOCI-CODE 认知层：一条斜杠命令即可让 AI 获得受治理、Git 版本化的仓库与数据库认知。**

[English](README.md) | **简体中文**

---

## 摘要

`dsh-aoci` 将 [AOCI-CODE](https://github.com/aoci-spec/aoci-code)（实现 AOCI——AI 面向认知基础设施——范式的本地优先 stdio MCP 服务器与 Go CLI）接入 DeepSeek Harness（DSH）插件生态。它将**确定性治理**（初始化、基线建立、验证）与**语义创作**（由模型在 AOCI 治理协议约束下撰写 FRAS 条目）相分离，并通过三个互补的模型可见面暴露认知：

- **九个 MCP 工具**（`mcp__aoci-<slug>__aoci_rules` / `aoci_overview` / `aoci_get_entries` / `aoci_search` / `aoci_maintain` / `aoci_update_entry` / `aoci_remove_entry` / `aoci_header` / `aoci_report`），由**动态 MCP 桥**按需注册，免去"每仓库一条静态配置 + 重启"；
- **十一个确定性工具**（`aoci_status`、`aoci_verify`、`aoci_check`、`aoci_scan`、`aoci_panel`、`aoci_use`、`aoci_unbind`、`aoci_relations`、`aoci_impact`、`aoci_lineage`、`aoci_db`），承担治理、System Cognition 查询、数据库预检与智能体自主选路；
- **一键斜杠命令** `/aoci [路径]`：带路径时解析（绝对路径，或相对 `defaultRoot`）；**不带路径时自动定位当前会话工作区仓库**；条件初始化/建基线 → 绑定 MCP 桥 → 经 `agent.steer` 向当前智能体提交建索引指令——**一次调用完成认知接入**。可选标志：`--locale`、`--scope`、`--agent`、`--skip-scan`、`--db`。

AOCI-CODE 采用 FSL-1.1-MIT（source-available）许可；本插件**不捆绑**其二进制——仅引导从官方发布渠道下载并做 SHA-256 校验。

## 适用范围与兼容性

- **实测运行环境**：DSH Desktop >= 2.7.0（API ^1.2.0）；harness 运行时 ^0.1.1-rc.1 || ^0.1.5-alpha.1（cordis ^4.0.2）；web profile。
- **Peer 依赖**（宿主启动时提供）：`@deepseek-ai/cordis`、`dsh-settings`、`dsh-system-prompt`、`dsh-tools`、`dsh-jobs`、`dsh-llm`、`react`、`react-dom`。
- **运行时依赖**：`schemastery`、`@modelcontextprotocol/sdk`。
- **前置二进制**：官方 AOCI-CODE Release 下载并 SHA-256 校验的 `aoci`（默认 `C:/aoci/bin/aoci.exe`）。

## 模型可见面

| 面 | 名称 | 用途 |
|---|---|---|
| 认知读取 | `mcp__aoci-<slug>__aoci_rules`、`...__aoci_overview`、`...__aoci_get_entries`、`...__aoci_search` | 加载与检索受治理的认知地图 |
| 认知维护 | `...__aoci_maintain`、`...__aoci_update_entry`、`...__aoci_remove_entry` | 协议约束下的增量更新 |
| 认知证据 | `...__aoci_header`、`...__aoci_report` | 索引身份与 attestation |
| 确定性治理 | `aoci_status`、`aoci_verify`、`aoci_check`、`aoci_scan`、`aoci_panel` | 健康、验证、基线、面板（status 同时报告 git head/工作区漂移） |
| System Cognition | `aoci_relations`、`aoci_impact <object>`、`aoci_lineage` | 依赖投影、影响分析、来源绑定链 |
| 数据库预检 | `aoci_db <source>` | 只读 `database source access` 预检（凭据仅环境变量引用） |
| 智能体自主选路 | `aoci_use <路径>`、`aoci_unbind <slug>` | 按需绑定/解绑仓库 |
| 斜杠命令 | `/aoci <路径>` | 一键接入（绑定 + 指示 AI 建索引） |

## 架构

```
DSH Web GUI (client) ── RPC/HTTP ──▶ DSH Host 半边（本插件）
                                        │ ctx.tools 动态注册
                                        ▼
                              aoci mcp（stdio，按需拉起）
                                        │ 九 MCP 工具
                                        ▼
                          仓库认知资产（aoci.txt 等，Git 版本化）
```

1. **双面插件**：包根为宿主（Node）半边；`./client` 导出为浏览器半边，经 DSH 的 `__ModuleLoader__.load` 协议注册。状态账本持久化于 profile 隔离的 `state/aoci/`（`projects.json`、`runs.jsonl`）。
2. **动态 MCP 桥**（`AociBridge`）：经 Node `child_process` 拉起 `aoci --repo <root> mcp`，以 `@modelcontextprotocol/sdk` 的 `StdioClientTransport` + `Client` 连接，发现九工具并注册到 `ctx.tools`；解绑时注销并终止进程。
3. **AOCI 治理语义**（实测固化）：`init` 仅对未初始化仓库执行（探测 `aoci.txt`）；`scan` 仅在没有基线时执行（探测 `.aoci/baseline.json`）；既有基线以无参 `aoci_maintain` + 整批 `aoci_update_entry` 维护，由 `verify`/`check` 证明。
4. **一键命令**：`/aoci [路径]`（无参自动定位当前工作区）经 `ctx.inject(['commands'], …)` 注册，并以 `agent.steer(createUserMessage(...))`（plan-mode 提交模式）提交建索引指令。
5. **压缩契约桥接**：`compactAociResults`（将 Whole-Index 正文折叠为 receipt 的纯函数）与 `compaction/end` 恢复钩子（`installAociCompactionGuard`）将 AOCI 压缩纪律对齐到 DSH 会话压缩。

## 安装

### 前置

- DeepSeek Harness profile（desktop >= 2.7.0 / runtime ^0.1.5-alpha.1 线）。
- 从[官方 AOCI-CODE Release](https://github.com/aoci-spec/aoci-code/releases)下载 `aoci` 二进制（如 `aoci_0.1.0-rc18_windows_amd64.zip`），对照发布的 `SHA256SUMS` 做 SHA-256 校验，放到稳定绝对路径（默认 `C:/aoci/bin/aoci.exe`）。

### 步骤

```powershell
cd <插件工程目录>
pnpm install
pnpm check            # typecheck + 单测 + 构建
pnpm pack             # dsh-aoci-<version>.tgz

dsh plugin --profile <name> add ./dsh-aoci-<version>.tgz
# 重启 DSH Desktop 后，在输入框执行：
#   /aoci D:\path\to\repo        （绝对路径）
#   /aoci ./relative                （需先配置 defaultRoot）
```

`/aoci` 之后，智能体将构建索引（rules → 完整 Overview → 分批 Maintain → verify/check → aligned）。后续会话复用同一份 Git 版本化认知；任务收尾自动维护。

## 配置参考

| 键 | 默认值 | 说明 |
|---|---|---|
| `binaryPath` | `C:/aoci/bin/aoci.exe` | 已验证 `aoci` 二进制的稳定绝对路径。 |
| `defaultRoot` | ``（空） | `/aoci` 与 `aoci_use` 相对路径的解析基准目录。 |
| `mcp.serverNamePrefix` | `aoci` | 动态注册 MCP 工具的命名空间前缀。 |
| `mcp.toolCallTimeoutMs` | `120000` | 桥接 MCP 工具的单次调用超时。 |
| `projects[].root` / `slug` / `locale` | — | 静态项目（可选；动态绑定无需预配置）。 |
| `projects[].dbSources[]` | `[]` | 数据库数据源（`sourceId`、`engine`、`databaseName`、`namespace`、`credentialEnv`）。 |
| `projects[].schedule.cron` | `0 3 * * *` | 夜间健康检查（默认仅 verify）。 |

## 验证方法

插件经四种互补方式验证：

1. **单元测试**（15 例）：slug/凭据引用派生、五段 cron 匹配、MCP 条目组装、压缩折叠、schema 默认值、相对路径解析。
2. **端到端链路**（真实 `aoci` 0.1.0-rc18 二进制 + 真实 Git 仓库 + MCP SDK）：`init` 成功；`scan` 建立基线（6 文件 / 586ms）；`verify` 输出 JSON；**九个 MCP 工具全部发现**；`aoci_header` 经 MCP 返回索引身份。
3. **集成自测**（真实 Cordis 上下文 + 命令注入）：`/aoci` handler 注册、绑定 9/9 工具、`agent.steer` 提交成功。
4. **加载器合成**：`dsh --profile web --dump-config` 无错误解析插件条目与配置。

## 已知局限

- 应用完全退出后不承诺后台调度继续执行。
- 首次建索引耗时随规模增长（约 1 小时 / 20 万行）且消耗 API 额度。
- 动态桥进程生命周期管理（崩溃重连）仍可强化。
- 数据库认知（MySQL/PostgreSQL/openGauss 表级 FRAS）与 `aoci ui` 面板内嵌为后续里程碑。

## 安全说明

- 凭据仅以环境变量名引用（`AOCI_DB_<ID>_DSN`）；插件从不存储或嵌入密钥。
- `aoci` 二进制从官方 Release 下载并 SHA-256 校验；不捆绑、不分发（FSL-1.1-MIT）。
- MCP/子进程环境在合并显式覆盖前会清洗形似凭据的变量。
- 所有 `/aoci/*` 面板路由仅限 loopback。

## 致谢

- **AOCI-CODE 团队**与《AOCI: Symbolic-Semantic Indexing for Practical Repository-Scale Code Understanding with LLMs》作者（arXiv:2605.02421）—— 受治理的认知范式与本地优先 MCP 服务器是本插件的基础。
- **DeepSeek Harness SDK 团队** —— 沙箱上下文与注入声明、`ctx.tools`、`ctx.commands`、`__ModuleLoader__.load` 前端契约等插件协议。
- **`dsh-task-board`（@linxin666/dsh-web-ui）与 `dsh-better-sidebar`（omdsh-dev/DSH-better-sidebar）维护者** —— 双面插件架构与清单协议的直接参照。
- **`dsh-plan-mode`（@deepseek-ai/dsh-plan-mode）** —— `ctx.inject(['commands'], …)` 注册与 `agent.steer` 提交模式。
- 早期试用者与审阅者 —— 真实环境反馈驱动了 0.1.x 修复周期。

完整版本历史与致谢见 [RELEASE.md](RELEASE.md)。

## 许可与归属

MIT License（见 [LICENSE](LICENSE)）。AOCI-CODE 采用 FSL-1.1-MIT（source-available，[github.com/aoci-spec/aoci-code](https://github.com/aoci-spec/aoci-code)）；本项目不持有、不分发 AOCI-CODE 二进制。设计文档见 [docs/DESIGN.md](docs/DESIGN.md)。