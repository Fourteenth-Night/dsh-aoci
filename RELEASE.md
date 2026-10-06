# 发布清单（Release Notes）

## 版本历史

| 版本 | 主要内容 |
|---|---|
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
pnpm check     # typecheck + 15 单元测试 + 构建
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