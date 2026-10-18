# dsh-aoci

**面向 DeepSeek Harness 的 AOCI-CODE 认知层：一条斜杠命令即可让 AI 获得受治理、Git 版本化的仓库与数据库认知。**

[English](README.md) | **简体中文**

---

## 摘要

`dsh-aoci` 将 [AOCI-CODE](https://github.com/aoci-spec/aoci-code)（本地优先的 stdio MCP 服务器 + Go CLI，实现 AOCI 认知范式）接入 DeepSeek Harness（DSH）插件生态，并严格区分**确定性治理**（初始化/基线/验证）与**语义创作**（由模型按 AOCI 协议撰写 FRAS 条目），通过三类互补面暴露认知：

- **九个 MCP 工具**（`aoci_rules`/`aoci_overview`/`aoci_get_entries`/`aoci_search`/`aoci_maintain`/`aoci_update_entry`/`aoci_remove_entry`/`aoci_header`/`aoci_report`），由动态 MCP 桥按需注册；`toolSurface: compact`（默认）下模型只看到 `aoci_overview` + 聚合入口 `aoci_call {tool,args}`（工具 schema 体积约减半），`full` 直接暴露九工具；
- **确定性工具**：`aoci_status`、`aoci_verify`、`aoci_check`、`aoci_use`、`aoci_unbind`、`aoci_refresh`（增量刷新）、`aoci_audit`（审计报告）、`aoci_build_status`，以及 `aoci_query`（compact 合并 relations/impact/lineage/db）或全量 `aoci_scan`/`aoci_panel`/`aoci_relations`/`aoci_impact`/`aoci_lineage`/`aoci_db`；
- **一键斜杠命令** `/aoci [路径]`：带路径解析（绝对或相对 `defaultRoot`）；**不带路径自动定位当前会话工作区**；校验二进制 → 条件 init/scan → 绑定 MCP 桥 → 经 `agent.steer` 指示当前 AI 建索引；可选 `--locale/--scope/--agent/--skip-scan/--db`。

AOCI-CODE 采用 FSL-1.1-MIT（source-available）；本插件**不捆绑**其二进制，仅对用户提供的二进制做 SHA-256 与最低版本校验。

## 适用范围与兼容性

- **实测运行环境**：DSH 0.2.0-rc.2（harness 运行时 `^0.2.0-rc.2`，cordis `^4.0.4`）；web profile。
- **Peer 依赖**（宿主提供）：`@deepseek-ai/cordis`、`dsh-settings`、`dsh-system-prompt`、`dsh-tools`、`dsh-jobs`、`dsh-llm`、`react`、`react-dom`。
- **运行时依赖**：`schemastery`、`@modelcontextprotocol/sdk`。
- **前置二进制**：官方 AOCI-CODE Release 的 `aoci`（默认 `C:/aoci/bin/aoci.exe`），SHA-256 + 最低版本（`minAociVersion`，默认 `0.1.0-rc18`；上游最新 rc21）校验。

## 模型可见面

| 面 | 名称 | 用途 |
|---|---|---|
| 认知读取 | `aoci_overview`（始终）+ `aoci_call`（compact）或九工具直连（full） | 加载与检索受治理认知 |
| 认知维护 | `aoci_call {tool: aoci_maintain/aoci_update_entry/…}` 或直连 | 协议约束下的增量更新 |
| 认知证据 | `aoci_call {tool: aoci_header/aoci_report}` 或直连 | 索引身份与 attestation |
| 确定性治理 | `aoci_status`、`aoci_verify`、`aoci_check`、`aoci_scan`(full)、`aoci_panel`(full) | 健康/验证/基线/面板；status 含二进制校验、git 漂移与工具面 |
| 刷新 | `aoci_refresh` | 计算上次维护 HEAD 以来的 git 变更集，给出分批增量维护指令 |
| 审计 | `aoci_audit` | verify/check + HEAD 漂移 + 结构化事件时间线 |
| 构建状态 | `aoci_build_status` | 最近构建/维护/验证记录与绑定 |
| 系统查询 | `aoci_query {kind}`(compact) 或 `aoci_relations`/`aoci_impact`/`aoci_lineage`/`aoci_db`(full) | 依赖投影/影响分析/来源链/数据库预检 |
| 自主选路 | `aoci_use`、`aoci_unbind` | 按需绑定/解绑仓库 |
| 斜杠命令 | `/aoci [路径]` | 一键接入（校验 + 绑定 + 指示建索引） |

## 架构要点

1. **双面插件**：包根为宿主半边；`./client` 为浏览器半边（`__ModuleLoader__.load` 协议）。
2. **动态 MCP 桥**：以**清洗后的环境**拉起 `aoci --repo <root> mcp`，stdio 连接并注册工具；解绑注销并终止进程；退出/调用失败 2s 退避重连。
3. **确定性执行**：优先 `ctx.subprocess` 受管进程（env 清洗、grace 终止、有界输出），缺失时降级 `node:child_process`。
4. **治理语义**：init 仅未初始化仓库（探测 `aoci.txt`）；scan 仅无基线时（探测 `.aoci/baseline.json`）；维护走无参 `aoci_maintain` + 整批 `aoci_update_entry`，`verify`/`check` 证明 aligned；verify 成功记录维护基线 HEAD，驱动 `aoci_refresh` 漂移检测。
5. **Token/预算工程**：compact 工具面；结果整形截断 + receipt 指针；压缩钩子折叠 AOCI 正文为单条 receipt，并在 `ctx.tokenMeter` 可用时按压力升级恢复提示（fold → fold+compact）。
6. **二进制安全**：SHA-256 + 最低版本校验 + 校验缓存；不匹配时阻止绑定并给出可操作提示。
7. **最小权限**：子进程环境白名单（系统变量 + `AOCI_DB_*` + 显式 `envPassthrough`）；`readOnly` 禁止写操作；`/aoci/api` 默认关闭。

## 安装

### 前置

- DSH 0.2.0-rc.2 profile（desktop 或 web）。
- 官方 Release 的 `aoci` 二进制（如 `aoci_0.1.0-rc21_windows_amd64.zip`），按 `SHA256SUMS` 校验后放到稳定绝对路径（默认 `C:/aoci/bin/aoci.exe`）。

### 步骤

```powershell
cd <plugin-checkout>
pnpm install
pnpm check
pnpm pack
dsh plugin --profile <name> add ./dsh-aoci-<version>.tgz
# 重启后输入：
#   /aoci D:\path\to\repo   （绝对路径）
#   /aoci                     （自动定位当前工作区）
```

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `binaryPath` | `C:/aoci/bin/aoci.exe` | aoci 二进制路径（留空自动探测） |
| `binarySha256` | `` | 期望 SHA-256；不匹配拒绝使用 |
| `minAociVersion` | `0.1.0-rc18` | 最低版本（建议随上游升至 rc21） |
| `envPassthrough` | `[]` | 额外透传的环境变量名（白名单恒含系统变量与 `AOCI_DB_*`） |
| `toolSurface` | `compact` | 工具面 compact/full |
| `autoRefresh` | `status` | off/status/nightly（夜间自动 verify） |
| `governance` | `standard` | strict 强制 verify+check；relaxed 仅建议 |
| `readOnly` | `false` | 只读模式（禁 init/scan/maintain） |
| `httpRoutes` | `false` | 挂载只读 `/aoci/api` |
| `budget.warn/fold/compact` | `0.6/0.75/0.9` | 上下文压力阈值 |
| `defaultRoot` | `` | 相对路径基准 |
| `mcp.serverNamePrefix` / `toolCallTimeoutMs` | `aoci` / `120000` | 命名空间前缀与调用超时 |
| `projects[]` | `[]` | 可选静态项目（动态绑定不需要） |

## 验证方法

1. **单元测试 28 例**：slug/凭据派生、cron、压缩折叠与预算策略、审计报告、刷新计划、环境白名单、工具面估算、配置默认值；
2. **端到端链路**（真实 rc18 二进制 + Git 仓库 + MCP SDK）：init/scan/verify、九工具发现、`aoci_header`；
3. **集成自测**（真实 Cordis）：`/aoci` 带参/无参、compact 面 2/2 工具、status 含二进制校验、`aoci_query`、`aoci_refresh`、`aoci_audit`、`aoci_build_status`、解绑；
4. **组合加载**：`dsh --profile web --dump-config` 正常解析。

## 已知限制

- 宿主完全退出后后台调度（含 nightly）不保证执行；
- 首次建索引随仓库规模增长（≈1h/20 万行）并消耗模型额度——用 `aoci_refresh` 做增量维护；
- `ctx.subprocess` 取决于宿主组合，降级路径保护较弱；
- 数据库认知仅表结构元数据（不读业务数据）。

## 安全

- 凭据仅以环境变量名引用（`AOCI_DB_<ID>_DSN`），不存储密钥；
- 子进程环境白名单，凭据形态变量不隐式透传；
- 不捆绑/不再分发 aoci 二进制；使用前 SHA-256 + 最低版本校验；
- `/aoci/api` 默认关闭，启用时仅 loopback。

## 致谢

- **AOCI-CODE 团队**与论文作者（arXiv:2605.02421）——认知范式与本地优先 MCP 服务器；
- **DeepSeek Harness SDK 团队**——插件协议与 `ctx.tools`/`ctx.commands`/`ctx.subprocess`/`ctx.tokenMeter` seam、压缩契约、`__ModuleLoader__` 协议；
- `dsh-task-board`、`dsh-better-sidebar`、`dsh-plan-mode` 等开源实现的借鉴；
- 提供真实环境反馈的早期用户与社区成员。

完整版本史与致谢见 [RELEASE.md](RELEASE.md)。

## 许可与归属

MIT（见 [LICENSE](LICENSE)）。AOCI-CODE 为 FSL-1.1-MIT（source-available）；本项目不持有/分发其二进制。设计理由见 [docs/DESIGN.md](docs/DESIGN.md)。
