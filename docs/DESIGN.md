# dsh-aoci —— 基于 AOCI-CODE 的 DeepSeek Harness 插件完整开发方案

> 为 AI 提供"全仓库代码/数据库认知"：把 AOCI-CODE（AI-Oriented Cognition Infrastructure 的代码落地方案）接入 DeepSeek Harness（DSH），
> 使每个 DSH 会话中的 Agent 开工即拥有整个系统的 FRAS 认知地图，并在任务中自动维护。
>
> 依据（本机实证）：
> - AOCI-CODE 官方仓库 README / agent-integrations / getting-started / windows-host-agent 文档 + arXiv:2605.02421
> - 本机 DSH 安装包内 SDK（@deepseek-ai/dsh-mcp-client / dsh-subprocess / dsh-tools / dsh-settings / dsh-jobs / dsh-system-prompt / dsh-api-gateway / dsh-compaction / dsh-schedule 等）
> - 已安装插件参照（@linxin666/dsh-client-ui-task-board、dsh-better-sidebar）的真实 manifest 与架构

---

## 0. 结论先行（TL;DR）

| 项 | 结论 |
|---|---|
| 可行性 | **完全可行，且是"正路"**：DSH 自带 `dsh-mcp-client`，专为把外部 stdio MCP 服务器工具注册到 `ctx.tools` 而设计；AOCI-CODE 就是"本地优先的 stdio MCP 服务器（9 个工具）+ Go CLI"，二者是既定接口的天作之合 |
| 核心接线 | 每个项目一条 `dsh-mcp-client` 配置：`command = C:/aoci/bin/aoci.exe, args = [--repo, <abs>, mcp]` → Agent 立刻获得 `mcp__aoci__aoci_rules / aoci_overview / ...` 九件套 |
| 认知生成 | 语义（FRAS 条目）**必须由模型生成**（AOCI 明令禁止 AST/正则/模板代写），插件负责"确定性层"：初始化、扫描、治理、验证、调度、面板、证据 |
| 最大差异化 | 把 AOCI 的**压缩（compaction）契约**桥进 DSH 的 `dsh-compaction` 管线；用 host 侧会话驱动"建索引/维护索引"为真实 Agent 任务（对接 DSH 会话）；数据库认知通过环境变量引用凭据（AOCI 不接受、不保存密钥值） |
| 许可 | AOCI-CODE 是 FSL-1.1-MIT（source-available）：插件**不得捆绑 aoci 二进制**，应引导从官方 Release 下载并校验 SHA-256；插件自身按社区惯例 MIT/Apache-2.0 |

---

## 1. 目标与设计原则

### 1.1 目标能力
1. **一键认知接入**：用户在设置页选择一个 Git 仓库 → 插件自动完成二进制就绪、`init`（写入仓库契约 + Volumes + AGENTS.md）、`scan`（建立基线 Baseline + Managed Scope 角色）、MCP 接入 → Agent 立即能"读懂整个系统"。
2. **跨会话/跨 Agent 复用**：索引资产随仓库由 Git 版本化，换设备、换会话、换模型不丢认知。
3. **任务尾自动维护**：model 在 DSH 会话中完成业务修改后，按规则收尾调用 `aoci_maintain`；让索引始终 aligned。
4. **数据库认知**：MySQL / PostgreSQL / openGauss 表级 FRAS 与代码认知一起交付。
5. **可审计**：`verify` / `check` 证据、索引 sha、构建 Run 记录，落盘到 profile 的 state 目录（对齐 dsh-task-board 的 Project/TaskRun/Evidence 建模）。
6. **治理可视化**：把 AOCI 只读面板（loopback）嵌入 DSH 客户端的"认知"页。

### 1.2 设计原则
- **确定性归插件，语义归模型**。AOCI-CODE 的定位是"治理者"，语义创作铁律：只允许当前宿主模型阅读真实内容后逐项生成 F/R/A/S，禁止 AST/import 扫描/模板/脚本代写（官方 windows-host-agent.md §6）。插件绝不做任何"索引生成器"。
- **不碰用户秘密**。DB 凭据只保存"环境变量名引用"（AOCI_DB_<ID>_DSN）；DSH 的 MCP client 与 subprocess 都会清洗形似凭据的环境变量再合并显式 env。
- **一切写入走官方契约**。不直接改 aoci.txt/.aoci 业务文件；索引写入全部经 `aoci_update_entry`/`aoci_maintain` 治理通道。
- **复用 DSH 基建，不重造轮子**：MCP 接入用 `dsh-mcp-client`，进程用 `ctx.subprocess`，任务用 `ctx.jobs`/会话驱动，设置用 `ctx.settings`，压缩用 `dsh-compaction`，面板用 loopback 代理。

---

## 2. 总体架构

```
┌──────────────────────────── DSH Web GUI (client 半边) ────────────────────────────┐
│ 侧边栏「AOCI 认知」入口                                                              │
│   ├─ 认知页(项目列表/状态/证据)   ├─ 设置页(settings.section)   ├─ 面板页(只读代理)    │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────────────────────────────────┐
│  │ client/board│  │ client/setup│  │ client/panel (iframe→/aoci/panel/* 代理)  │
│  └──────┬──────┘  └──────┬──────┘  └──────────────────────┬───────────────────┘
└─────────┼────────────────┼────────────────────────────────┼──────────────────────┘
          │ ctx.remote(RPC)/FetchHandler(HTTP)              │ loopback 转发
┌─────────▼────────────────▼────────────────────────────────▼──────────────────────┐
│                          DSH Host 半边 (cordis 插件进程)                          │
│  ┌────────────────────────────────────────────────────────────────────────────┐  │
│  │ host/workspace  项目Git仓库发现、Managed Scope 角色、.gitignore 纪律          │  │
│  │ host/aoci-bin   二进制下载/校验/升级、doctor、 能力探测                         │  │
│  │ host/mcp-boot   每个项目 ⇄ 一条 dsh-mcp-client 配置（serverName=aoci-<slug>） │  │
│  │ host/cli        ctx.subprocess 受控执行 aoci init/scan/verify/check/...     │  │
│  │ host/session-driver  “建索引/维护索引” = 真实 DSH 会话任务（session.create+    │  │
│  │                      prompt，订阅快照至 settle；消耗 API 额度，先确认）         │  │
│  │ host/jobs       后台任务注册(ctx.jobs)+浏览器/宿主导管调度(夜间 verify 等)     │  │
│  │ host/compaction AOCI 压缩契约 → dsh-compaction 后端（摘要剔除 Whole-Index 正文│  │
│  │                      + 恢复指令 + context_compaction 事件声明）               │  │
│  │ host/evidence   verify/check --json、索引 sha、TaskRun 证据持久化(state/aoci/)│  │
│  │ host/routes     /aoci/api/*(状态)、/aoci/panel/*(只读面板代理)、SSE            │  │
│  └───────┬────────────────────────────────────────────────────────────────────┘  │
│          │ ctx.tools.register(defineTool(aoci_status/aoci_scan/aoci_verify...))  │
│          │ ctx.systemPrompt.section(认知纪律段) + contributes.skills               │
└──────────┼──────────────────────────────────────────────────────────────────────┘
           │  dsh-mcp-client（stdio, 环境已清洗）
           ▼
┌─────────────────────────────────────────────────────────────┐
│  aoci.exe  (C:\aoci\bin\aoci.exe, 稳定绝对路径)                │
│    aoci --repo <abs> mcp   →  9 个 stdio MCP 工具              │
│    Reads: aoci_rules aoci_overview aoci_get_entries aoci_search│
│    Maintenance: aoci_maintain aoci_update_entry aoci_remove_entry │
│    Evidence: aoci_header aoci_report                          │
│  （可选）aoci ui --detach --json → loopback 只读面板             │
└─────────────────────────────────────────────────────────────┘
```

**双面插件结构**（与 dsh-task-board 同型）：包根导出为 host 半边（node 进程），`./client` 导出为浏览器半边（被 serve 在 `/plugins/<id>/client.js`）。

---

## 3. 插件包结构与清单文件

### 3.1 目录布局

```
dsh-aoci/
├─ package.json              # dsh.bundle.patch / dsh.client.inject / dsh.compatibility
├─ dsh.plugin.json           # id=dsh-external/dsh-aoci, main, client.main, contributes
├─ cordis.patch.yml          # insert 一行
├─ tsdown.config.ts / tsconfig.build.json
├─ src/
│  ├─ index.ts               # host 入口（节点半边）
│  ├─ client.ts              # client 入口（浏览器半边）
│  ├─ host/
│  │  ├─ aoci-bin.ts         # 二进制下载/校验/升级/doctor
│  │  ├─ workspace.ts        # 仓库发现/角色/忽略纪律
│  │  ├─ mcp-boot.ts         # dsh-mcp-client 配置生成与重载
│  │  ├─ cli.ts              # ctx.subprocess 封装（--json、退出码）
│  │  ├─ session-driver.ts   # 索引构建/维护会话任务
│  │  ├─ jobs.ts             # ctx.jobs 后台任务 + 调度
│  │  ├─ compaction.ts       # dsh-compaction 后端（AOCI 压缩契约）
│  │  ├─ evidence.ts         # 证据持久化（state/aoci/）
│  │  ├─ routes.ts           # /aoci/* FetchHandler + Typert Remote
│  │  └─ settings.ts         # settingsNamespace('aoci') 注册
│  ├─ client/
│  │  ├─ setup/page.tsx      # settings.section 设置页
│  │  ├─ board/page.tsx      # 认知页（项目/状态/证据/任务）
│  │  └─ panel/page.tsx      # AOCI 面板嵌入式页
│  └─ skill/
│     └─ SKILL.md            # contributes.skills：捎带认知纪律的 AOCI 技能
├─ lib/                      # 构建产物（files 白名单）
└─ README.md / LICENSE
```

### 3.2 三个清单文件要点（对照本机实证）

**package.json 关键字段**（参考 dsh-task-board 0.1.18 / dsh-better-sidebar 0.17.1）：

```jsonc
{
  "name": "dsh-aoci",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": { ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
                "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
                "./package.json": "./package.json" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "compatibility": {
      "desktop": { "range": ">=2.7.0 <4.0.0", "api": "^1.2.0" },
      "runtime": { "range": "^0.1.1-rc.1 || ^0.1.5-alpha.1" },
      "surfaces": ["main"]
    },
    "client": {
      "inject": ["@deepseek-ai/dsh-client-connection", "@deepseek-ai/dsh-api-session-controller",
                 "@deepseek-ai/dsh-api-workspace-controller", "@deepseek-ai/dsh-client-store",
                 "@deepseek-ai/dsh-client-ui-settings", "@deepseek-ai/dsh-client-ui-sidebar"],
      "platform": "web"
    }
  },
  "peerDependencies": { "@deepseek-ai/cordis": "^4.0.2", "@deepseek-ai/dsh-settings": "^0.1.5-rc.1",
                        "@deepseek-ai/dsh-system-prompt": "^0.1.5-rc.1", ... }
}
```

**dsh.plugin.json**（id 遵循 `dsh-external/<name>` 习惯；`contributes.skills` 挂载 AOCI 技能）：

```jsonc
{
  "id": "dsh-external/dsh-aoci",
  "version": "0.1.0",
  "main": "./lib/index.js",
  "description": "AOCI 认知层：为 DSH 提供全仓库代码/数据库认知地图（MCP 桥接 + 索引治理 + 面板）",
  "engines": { "dsh": ">=0.0.1" },
  "contributes": { "tools": [], "skills": [{ "name": "aoci-cognition", "path": "./lib/skill/SKILL.md" }] },
  "client": { "main": "./lib/client.js" }
}
```

**cordis.patch.yml**：

```yaml
# 参照 dsh-task-board：双面插件——host 半边(exports ".") + client 半边(exports "./client")。
- insert:
    - id: aoci-cognition
      name: 'dsh-aoci'
```

安装/挂载（官方插件通道）：

```powershell
dsh plugin --profile web add ./dsh-aoci-0.1.0.tgz   # 写入 profiles/<name>/node_modules + bundles
dsh --profile web
```

---

## 4. 核心模块设计（host 半边）

### 4.1 host/aoci-bin —— 二进制生命周期（复用官方发布通道）
- 稳定路径 **`C:\aoci\bin\aoci.exe`**（官方 windows-host-agent.md §1 推荐；配置可改）。
- 首次使用：读设置 → 引导下载 GitHub Releases 资产（`gh release download v0.1.0-rc18 --repo aoci-spec/aoci-code` 或浏览器）→ **SHA-256 校验**（与官方资产校验流程对齐）→ `aoci --version`/`aoci capabilities` 自检 → 记录版本与校验和。
- 升级：守官方顺序（退出 MCP 进程 → 备份 → 替换 → 校验 → 重启会话）。
- 不捆绑二进制（FSL-1.1-MIT 再分发限制），只提供"引导+校验"。

### 4.2 host/workspace —— 项目与范围治理
- 判定 Git 仓库（`git rev-parse`）；记录仓库根绝对路径。
- **忽略纪律**：AOCI 认知资产（aoci.txt / aoci.meta.txt / aoci.code.txt / aoci.database.txt / AGENTS.md）**不得加入 .gitignore**——`scan` 依 Git 清单取文件，被忽略的资产会被静默跳过导致索引建不起来；`init` 自己写的宿主配置忽略项保持原样。
- Managed Scope 与角色（`index` 角色等）由第一次 `scan` 固定，`scan --force` 不能推进；需要提示用户"首个 scan 前配好宿主文件"。

### 4.3 host/mcp-boot —— MCP 接线（本方案核心）
每个已配置项目生成一条 **`dsh-mcp-client`** 组合条目（DSH 原生能力，可控、可重载）：

```yaml
- id: mcp-aoci-<project-slug>
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: aoci-<project-slug>        # namespace；[A-Za-z0-9_-]{1,32}，作用域内唯一
    transport: stdio
    command: 'C:/aoci/bin/aoci.exe'        # 必须是 init 校验过的同一绝对路径
    args: ['--repo', '<repository-root>', 'mcp']
    env: {}                                # DB 凭据用环境变量名引用（AOCI_DB_*_DSN）时在此透传引用
    toolCallTimeoutMs: 120000              # aoci_overview 全量交付可超 60s 默认值
    failOnStartupError: false              # 服务器缺失时 harness 照常启动（温和降级）
    reconnect.enabled: true
```

- Agent 获得稳定工具名：`mcp__aoci-<slug>__aoci_rules` / `...__aoci_overview` / `...__aoci_get_entries` / `...__aoci_search` / `...__aoci_maintain` / `...__aoci_update_entry` / `...__aoci_remove_entry` / `...__aoci_header` / `...__aoci_report`。
- 环境清洗：stdio 子进程 env 以 scrub（去掉 `KEY|PASSWORD|SECRET|TOKEN` 名与 `DSH_*`）再合并配置 env——凭据引用不会被意外泄漏给子进程。
- 项目增删/路径变更 → 重写条目（原地重载）；同一作用域内 serverName 唯一，重名配置加载期即报错。
- 与官方宿主接入的差异：**不写 `.codex/config.toml`、`.mcp.json` 等宿主文件**（DSH 不是 Codex/Claude Code），MCP 由插件经 DSH 通道接入；`aoci init` 不带 `--agent`（避免在仓库里写入无用的宿主配置，只写契约 + Volumes + AGENTS.md + .gitignore 块）。

### 4.4 host/cli —— 受控确定性命令
用 `ctx.subprocess.spawn({ argv, cwd, stdio:{stdin:'ignore', stdout:{maxBytes}, stderr:'inherit'|collect}, graceMs, env })` 执行：

- `aoci --repo <r> init [--locale en-US]`（新建/二次初始化）
- `aoci --repo <r> scan`（建立 Baseline，**必做**；缺它 Guide 报 `baseline_missing`）
- `aoci --repo <r> verify --json` / `check --json`（只读治理门，可能追加本地 Ledger）
- `aoci --repo <r> index agent guide --agent codex --json`（确定性 host-agent 工作流入口；guide 命令从 MCP 配置派生：去掉终止子命令 `mcp`、追加 `index agent guide --agent <host> --json`，**禁止裸命令**——实现官方 windows-host-agent.md §5 契约）
- `aoci --repo <r> database source add --source-id <id> --engine <mysql|postgresql|opengauss> --database-name <db> --namespace <ns> [--credential-env <name>]`
- `aoci --repo <r> database source access --source primary --json`（只读预检，不返回秘密）
- `aoci --repo <r> database cognition bootstrap` + `database cognition status`
- `aoci --repo <r> cognition system snapshot|relations|impact|lineage --json`（System Cognition 查询，供认知页可视化）
- `aoci --repo <r> ui --detach --json`（只读面板，返回 loopback 链接）

统一封装：**--json 解析 + 退出码语义 + 超时 + 树级 terminate + 输出上限**；真实语义（FRAS）绝不经过此通道。

### 4.5 host/session-driver —— "认知工作" = 真实 DSH 会话任务
AOCI 语义必须由模型生成，因此"建索引 / 维护索引 / 建数据库认知"由插件驱动**真实 Agent 会话**执行（复用 dsh-task-board 的执行模式）：

- 通过 host workspaces 接入真实 session（blank 复用或 `session.create`），重命名为"为 <repo> 建立 AOCI 认知"；
- 注入任务提示：先确认 `mcp__aoci-<slug>__*` 已连接 → `aoci_rules` → `aoci_overview` → 按 Guide 逐批 `aoci_maintain`(无参) + `aoci_update_entry` 提交候选 → 直到 `applied/aligned` → `verify`/`check`；
- 订阅会话快照直到本轮 settle；把结论（aligned 状态、索引 sha、条目数、耗时、会话 id）写回项目记录；
- **执行消耗 API 额度**，启动前 UI 确认；正在运行的同类任务由 guard 拒绝（避免并发双跑）。
- 数据库认知：先 `database source add` + `source access --json` 预检（管理员已放好 `AOCI_DB_<ID>_DSN` 环境变量）→ 再驱动会话执行 `database cognition bootstrap` 流程（模型读证据哈希并人工接受 → 写表级 FRAS → 绑定证据 → 治理 apply）。

### 4.6 host/jobs + 调度 —— 后台维护
- `ctx.jobs`（dsh-jobs-local + dsh-tool-jobs 挂载后）注册后台任务：`aoci-verify-<slug>`、`aoci-check-<slug>`、`aoci-scan-<slug>`（确定性、无模型成本）。
- 夜间健康检查：浏览器端心跳调度（60s，任务看板同款）或未来 Host 端 host-job adapter（租约 + 时区 cron + 确定性认领）；命中 cron（如 `0 3 * * *`）触发 verify+check，漂移（Stale/未 aligned）时生成"建议维护"通知，不自动烧 API 额度。
- 明确限制：应用完全退出后不承诺调度继续执行；GUI 未开错过即跳过（不排队）。

### 4.7 host/compaction —— AOCI 压缩契约 × dsh-compaction
这是本插件区别于"手动挂 MCP"的**最大增量价值**。AOCI 的上下文压缩纪律（官方 README / windows-host-agent.md §2）：

1. 压缩交接只允许保留：receipt 身份、未完成写/恢复状态、立即重载指令；**不得保留/摘要 Whole-Index / Overview / Entry / Challenge / Attestation 正文**；
2. 压缩后恢复业务前：重新加载 `aoci_rules`（如不再可靠）→ 声明 `context_compaction` + 幂等 `refresh_event_id` → 完成一次完整 Overview 光标、确认与 attestation；
3. 触发刷新只有三种合法原因：`context_compaction` / `semantic_threshold`(机器算) / `phase_transition`。

实现：插件实现一个 `dsh-compaction` 自定义后端（继承基类实现 `compactIfNeeded`/`compactNow`/`compactRegion`）或包装 `dsh-compaction-basic`——
- 摘要生成时把 `mcp__aoci__*` 的大工具结果（Overview 正文等）替换为 AOCI receipt + 重载指令；
- 在压缩后注入一条后续消息/系统段：以 `context_compaction` 事件 ID 完成一次 Overview + Attestation（幂等，不重复刷新）；
- 与官方 Codex/Claude 的 `--hooks` 压缩集成做同一件事，但走 DSH 原生压缩管线，不需要宿主 hook 文件。

### 4.8 host/evidence + routes —— 证据与 HTTP
- 证据账本：`profiles/<name>/state/aoci/` 下 `projects.json`（项目⇄二进制⇄MCP⇄schedule⇄dbSources）、`runs.jsonl`（TaskRun：kind=index_build|maintain|verify|check|scan|db_bootstrap，state、索引 sha、条目数、耗时、会话 id、证据摘要）、`evidences/*.json`（verify/check --json 原样）。写入串行 + 临时文件回读校验 + 原子替换（对齐 task-board 的持久化纪律）。
- 路由（loopback same-origin 固定路径，拒绝浏览器传入文件路径）：
  - `GET /aoci/api/projects`、`GET /aoci/api/projects/<slug>`（含状态快照）
  - `GET /aoci/api/projects/<slug>/runs`
  - `GET /aoci/panel/*`：把 `aoci ui` 的 loopback 页面反代到同源路径（panel 只读、只绑回环，不走公网）
  - SSE：多标签页变更同步。
- 可选：`ctx.typertGateway` 注册类型化 Remote（`projects.status(slug)` 等），client 经 `ctx.remote` 调用。

### 4.9 host/settings —— 设置 schema（schemastery）

```ts
const Schema = s.object({
  binaryPath: s.string().default('C:/aoci/bin/aoci.exe'),
  autoInstallOnFirstUse: s.boolean().default(true),
  mcp: s.object({
    serverNamePrefix: s.string().default('aoci'),
    toolCallTimeoutMs: s.number().default(120000),
    failOnStartupError: s.boolean().default(false),
  }),
  projects: s.array(s.object({
    root: s.string().required(),                 // 仓库根绝对路径
    slug: s.string(),                            // 默认取目录名
    enabled: s.boolean().default(true),
    locale: s.string().default('en-US'),
    schedule: s.object({ cron: s.string().default('0 3 * * *'), verifyOnly: s.boolean().default(true) }).default(),
    dbSources: s.array(s.object({
      sourceId: s.string().required(),           // 例如 primary
      engine: s.union(['mysql','postgresql','opengauss']).default('postgresql'),
      databaseName: s.string(), namespace: s.string().default('public'),
      credentialEnv: s.string(),                 // 默认派生 AOCI_DB_<ID>_DSN
    })).default([]),
    chunkTokens: s.number().min(4000).max(24000).default(7000),   // overview_delivery.chunk_tokens
    maintainBudgetBytes: s.number().default(24576),               // maintain_transport_budget_bytes
  })).default([]),
})
```

- host：`ctx.settings.register(settingsNamespace('aoci'), Schema, { base: config })`；组合配置未显式给 `dsh-settings-file` 时用 `installSettingsSection` 优雅回退。
- client：`ctx.settingsScope.bind('aoci')` 渲染设置页；注册到 `settings.section` slot。

### 4.10 模型侧增强
- **`ctx.systemPrompt.section`**：注入"认知纪律"段——开工先 `aoci_rules`+一次 `aoci_overview`；任务尾收尾顺序（格式化→lint/测试→git diff→`aoci_maintain`→`aoci_update_entry`→verify/check→aligned）；压缩后守重载契约；维护后再改受管文件会使旧结果失效。
- **自定义工具**（确定性，零模型语义）：`ctx.tools.register(defineTool(...))` 注册 `aoci_status`（项目状态快照）、`aoci_scan`、`aoci_verify`、`aoci_check`、`aoci_panel`（打开面板）。语义九个工具仍走 MCP 通道。
- **skill**：`contributes.skills` 挂 SKILL.md，内含完整 AOCI 协作协议（FRAS 纪律、attestation、DB 认知流程），Agent 遇到"理解这个系统/接手这个仓库"类任务时被引导加载。

---

## 5. 数据模型（state/aoci/）

```jsonc
// projects.json —— 每个被认知管理的项目
{
  "version": 1,
  "projects": [{
    "slug": "my-service",
    "root": "D:/code/my-service",
    "binaryPath": "C:/aoci/bin/aoci.exe",
    "aociVersion": "0.1.0-rc18",
    "mcp": { "serverName": "aoci-my-service", "connected": true, "tools": 9 },
    "index": { "layout": "volumes-v1", "baseline": { "established": true, "baselineSha": "..." },
               "aligned": true, "entries": 340, "indexSha": "...", "lastOverviewAt": "..." },
    "database": { "enabled": true, "sources": [{ "sourceId": "primary", "engine": "postgresql",
                  "databaseName": "app", "namespace": "public", "credentialEnv": "AOCI_DB_PRIMARY_DSN",
                  "accessPreflight": "ok", "evidenceHash": "..." }] },
    "schedule": { "cron": "0 3 * * *", "verifyOnly": true },
    "createdAt": "...", "updatedAt": "..."
  }]
}
```

```jsonl
// runs.jsonl —— 认知 TaskRun（对齐任务看板 Run 概念）
{"ts":"...","kind":"index_build","project":"my-service","state":"completed",
 "sessionId":"...","indexSha":"...","entries":340,"exitCode":0,"evidence":"ev-xxx.json","apiTokens":123456}
```

---

## 6. 关键工作流（时序）

### 6.1 首次接入
1. 用户安装插件 → 设置页添加项目（选仓库根）→ 插件：
2. `init`（不带 --agent；写契约 + Volumes + AGENTS.md + .gitignore 块）→
3. `scan`（建立 Baseline；缺此步后续全部 blocked:baseline_missing）→
4. 生成/重载 `dsh-mcp-client` 条目（stdio` aoci --repo <root> mcp`）→
5. 显示"可在会话中建立索引"——用户或 Agent 发起 → 进入 6.2。

### 6.2 建立/刷新认知（真实会话）
1. 会话驱动：确认工具已连接 → 会话提示词（Guide 引导）→
2. Agent：`aoci_rules` → `aoci_overview`（全量，超阈值按 continuation_required 分块 + attestation）→
3. Guide（`aoci index agent guide --agent codex --json`）→ 按批 `aoci_maintain`(无参) → 整批 `aoci_update_entry` → 直至 applied/aligned →
4. `verify --json` + `check --json` → 证据入库 → 面板/认知页可查。
5. 大型仓库提醒：约 1 小时/20 万行；可中途打断续跑；预算按项目提示 token 预估。

### 6.3 数据库认知
1. 管理员在 Profile/Windows 环境准备 `AOCI_DB_PRIMARY_DSN`（最少权限、只读系统目录）→
2. 设置页声明数据源 → `database source add` + `database source access --json` 预检 →
3. 会话驱动执行 `database cognition bootstrap`：读取经典 schema 证据 → 模型按证据写表级 FRAS → 证据哈希人工接受 → 条目进入治理 apply（离线，不再重连数据库）→
4. `cognition system impact` 可回答"改这张表会影响哪些代码对象"。

### 6.4 日常收尾（自动维护）
Agent 完成任务后按系统段纪律：业务修改 → 格式化/Lint/测试 → git diff → `aoci_maintain` → `aoci_update_entry` 整批提交 → 内部 Check/CAS/Baseline/Ledger → aligned 复查。插件在 run 记录中留下证据，供面板显示"认知健康"。

---

## 7. 安全与隐私（对齐 AOCI 官方边界）
- **零外联**：AOCI 只连你声明的数据库（仅表结构）+ 本机回环面板；插件不新增数据出口。
- **凭据**：DSH MCP/subprocess 清洗环境（`KEY|PASSWORD|SECRET|TOKEN` + `DSH_*`）；DB 凭据只存环境变量名引用，dialog 不收集 DSN。
- **二进制完整性**：Release 资产 SHA-256 校验；检查替换后版本；MCP 配置引用 init 校验过的同一绝对路径。
- **回环路由**：/aoci/* 只接受 loopback same-origin；面板反代只读（GET/HEAD）。
- **许可**：FSL-1.1-MIT 为 source-available，插件只引导下载、不捆绑；插件自身开源（MIT/Apache-2.0）并写明 AOCI-CODE 归属与许可链接。
- **权限**：DB 账号按官方要求最少权限、只读 catalog；TLS 策略（verify-full、TLS≥1.2）由 DSN 配置保证。

---

## 8. 风险与对策

| 风险 | 说明 | 对策 |
|---|---|---|
| `aoci_overview` 大结果 | 默认 chunk 7000 token（可配 4000–24000）；AOCI 声明 per-tool 结果尺寸放量（Claude Code 下 24K 可用） | 验证 DSH MCP client 是否尊重该声明；不尊重则保守设 `chunkTokens` ≤ 结果上限；结果经 dsh 工具结果回传上限评估 |
| token 成本 | 首次建索引 ≈1h/20万行；维护/全量重读耗额度 | 默认 verifyOnly 夜间调度；语义刷新（overview）只在三种合法原因触发；UI 明示额度消耗并确认 |
| 双执行/并发 | 两个会话同时对同一仓库 maintain | 每仓库一把内存锁 + runs.jsonl 状态守卫；同 kind 运行中拒绝 |
| MCP 进程崩溃 | stdio 子进程崩溃 | `reconnect.enabled: true`（内置 500ms→30s 退避、10 次预算）；面板可观测 `aoci mcp` 进程 |
| 升级二进制 | 替换后旧会话仍引用 | 守官方升级顺序；重启会话；面板标记"被替换的二进制" |
| FSL 许可合规 | 再分发受限 | 不捆绑；文档注明来源、版本、校验方式 |
| 应用退出后调度中断 | 浏览器调度回退限制 | 文档明示；未来接 Runtime Provider host-job adapter（租约+时区 cron） |
| 仓库换机 | 宿主配置绝对路径失效 | 不写宿主文件（插件自持 MCP）；init 写 .gitignore 块防误提交 |
| 模型忘记纪律 | 收尾不 maintain | system-prompt 段 + skill + 会话驱动兜底（后台校验任务发现未 aligned 时提示） |

---

## 9. 实施路线图（建议拆分）

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| M0 原型（评估） | 手工在 profile 加一条 `dsh-mcp-client` 配置连一个 demo Go 仓库；会话内跑通 `aoci_rules`→`aoci_overview`；确认大结果回传与 chunk 行为 | 9 工具可达；全量 Overview 完整交付；无结果截断 |
| M1 MVP | 插件骨架（双面）；host/aoci-bin + workspace + mcp-boot + cli；设置页（项目添加）；会话驱动"建索引/维护"；证据落盘；认知页基础版 | 一键接入 demo 仓库；verify/check aligned；runs/证据可查 |
| M2 增强 | compaction 后端（契约桥接）；数据库认知全流程；AOCI 面板反代；夜间调度 + 通知；自定义确定性工具 + system-prompt 段 + skill | 压缩后恢复认知不重读全量；DB 表级 FRAS 入库；面板可用；夜间验证通过 |
| M3 打磨/发布 | 多项目多会话并发锁；升级流程；i18n（中/英）；测试（单元+E2E 仿 task-board）；打包 .tgz + README + 许可声明；发布插件市场（dshmarket/聚合包）可选 | 全流程自检脚本通过；并发/崩溃/断线场景稳定 |

**M0 最小验证脚本（可立即执行）**：
```powershell
# 1) 下载官方 Release 并校验（示例，替换为实际资产）
gh release download v0.1.0-rc18 --repo aoci-spec/aoci-code --pattern '*windows*'
# 2) 稳定路径 + 初始化示例仓库
& C:\aoci\bin\aoci.exe --repo D:\code\demo init --locale en-US
& C:\aoci\bin\aoci.exe --repo D:\code\demo scan
& C:\aoci\bin\aoci.exe --repo D:\code\demo mcp   # 验证 stdio MCP 端点
# 3) 在 DSH profile 手工加 dsh-mcp-client 条目后：会话内让 Agent
#    "调用 mcp__aoci-demo__aoci_rules 与 aoci_overview，确认本仓库认知可完整交付"
```

---

## 10. 参照清单（一手事实来源）
- AOCI-CODE 仓库与文档：github.com/aoci-spec/aoci-code（README / docs/agent-integrations.md / docs/getting-started.md / docs/windows-host-agent.md / install.md）
- 论文：arXiv:2605.02421《AOCI: Symbolic-Semantic Indexing for Practical Repository-Scale Code Understanding with LLMs》
- DSH SDK（本机安装包内）：@deepseek-ai/dsh-mcp-client（README.zh.md 含完整配置表）、dsh-subprocess、dsh-tools、dsh-settings、dsh-jobs、dsh-system-prompt、dsh-api-gateway、dsh-compaction、dsh-schedule、dsh-client-ui-settings
- 插件参照：dsh-better-sidebar（manifest/补丁模式）、@linxin666/dsh-client-ui-task-board（双面插件 + 真实执行 + 证据持久化）
