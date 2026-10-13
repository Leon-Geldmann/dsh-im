# Discord 原生工作台接续开发计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 接续中断会话，完成个人 Discord 原生 DSH 工作台的可靠性收尾、验证和 Fork 交付。

**Architecture:** 沿用 Guild → Category/项目 → Channel/固定 Session，以及现有共享 Harness 桥接器。工作台自己的持久任务日志负责请求身份和恢复，DSH 负责会话与任务真相；恢复不盲目重放。以现有未提交代码为接续基础，逐项复现、修正和验证。

**Tech Stack:** Node.js >=22.19、ES modules、node:test、esbuild、DSH 0.2.0-rc.2、Discord Gateway/REST。

**Spec:** `docs/superpowers/specs/2026-10-13-discord-workbench-requirements.md`；已有设计见 `docs/方案/Discord-原生工作台-设计与实现计划.md`。冲突以原始需求为准。

## 接手事实（2026-10-13）

- 原会话：构建 Discord 原生 DSH 工作台，ID `01a128b0-fe39-7c21-ab0f-423b350e7ca1`；连续六轮因模型容量不足中断。
- 仓库：`/home/leon/Documents/dsh_im/dsh-im`；分支 `feat/discord-guild-workbench`；HEAD `9b67c22`；上游基线 `bbafc99`。
- origin：`Leon-Geldmann/dsh-im`，已通过 GitHub API 确认为 Fork；upstream：`xmanrui/dsh-im`。
- 接手时 17 个已跟踪文件修改、9 个新文件；不能重置或覆盖这些成果。
- 定向基线：197 tests / 195 pass / 2 fail / 0 cancelled，日志 `/tmp/dsh-im-takeover-discord-20261013.tap`。
- 失败：`/session new keeps a half-created channel registered when the Session fails`、`/model lists the session catalog and applies a selection`。
- 原报告中的“全量 0 失败”包含 cancelled 且退出码非零，不能视为完整通过。本轮重新报告真实退出码及分类。
- 当前 DSH 实测为 0.2.0-rc.2。真实 Discord 联调尚无本轮证据。

## Global Constraints

- 一个 DSH 实例、一个专属 Bot、一个指定 Guild；Discord ID 始终用字符串。
- 一个频道固定一个 Session；失效或查询失败不得自动替换。
- 权限及路由校验先于下载、建会话、调用 DSH；项目真实路径必须位于允许根目录。
- 默认全局重任务并发 1、同项目串行；控制动作不排在普通任务后面。
- 提交/投递不确定时核对原请求，不能盲目重试；不得声称未经验证的 exactly-once。
- 保留旧 Thread 模式和其他渠道行为；不把生产配置、凭证和会话正文加入仓库。
- 原始授权包含创建/复用 Fork、提交推送、计划后直接实施。无需再次询问执行方式。
- 本轮不替换生产插件、不修改生产配置；先前 DSH 升级授权已执行，无需重复升级重启。
- 缺真实联调凭据时完成离线测试、构建与打包，并明确标注真实联调未验证。

## Review Focus

1. 同一超时任务同时进入旧 deferred coordinator 和新 journal，可能重复投递：任务 2 测试恢复所有权。
2. 原操作者把审批 token 带到另一频道、或绑定已变更：任务 3 测试作用域拒绝且原请求仍可处理。
3. Discord 删除频道前尚未确认历史/附件存续：任务 4 测试保存失败时不删除。
4. API 已创建对象但本地写盘失败：任务 1/5 测试保留不确定状态，不再创建第二对象。
5. 重启恢复时任务仍运行、历史分页或另一个新 turn 已完成：任务 2/5 测试按原 rpcId 恢复。

---

### Task 1: 整理接手基线与命令契约

**Files:** `test/channels/discord/workbench-interactions.test.mjs`、`test/channels/discord/workbench-command-hardening.test.mjs`、`src/channels/discord/workbench/commands.mjs`、`channel-session-router.mjs`。

**Interfaces:** 消费 `getSessionModels(sessionId)` 的真实 `{groups:[{id,models:[{id,...}]}],current}` 结构；产出保留中间操作状态、固定 Session 不变的命令行为。

- [x] 读取原会话、人类原始需求、分支及未提交修改；重跑定向基线。
- [x] 核实两项失败根因：模型测试夹具是否落后于宿主契约；半创建操作是否应保留恢复记录。更新夹具/断言时增加“不重复创建”的行为断言，不简单删除断言。
- [x] 验证模型 ID 含 `/`、推理强度选择、重复 interaction、首消息与原生命令并发创建的用例。
- [x] 运行 `node --test test/channels/discord/workbench-interactions.test.mjs test/channels/discord/workbench-command-hardening.test.mjs test/channels/discord/workbench-production-scope.test.mjs`，预期零失败、零取消。

### Task 2: 持久任务、附件与恢复的唯一负责路径

**Files:** `src/channels/shared/text-harness-bridge.mjs`、`src/channels/shared/harness-client.mjs`、`src/channels/discord/discord-runtime.mjs`、`src/channels/discord/workbench/task-journal.mjs`、`input-cache.mjs`；测试 `test/harness-prompt-lifecycle.test.mjs`、`test/channels/discord/workbench-task-journal.test.mjs`、`workbench-input-cache.test.mjs` 及新增桥接回归。

**Interfaces:** `message.onPromptState(event)` 在 RPC 提交前持久保存 sessionId/promptRpcId/baselineSeq；`message.onTaskState(state,facts)` 记录投递阶段；`WorkbenchTaskJournal.recover({signal,excludeMessageIds})` 只观察原任务，不重新提交。

- [x] 写失败用例：工作台携带 `onPromptState` 时，超时不能再注册旧 deferred delivery；普通渠道仍可注册。
- [x] 实现恢复所有权隔离，核实 queued/submitting/running/completed/delivery-unknown 的转换与异常路径。
- [x] 验证附件在排队前缓存、确定终态后清理、提交不确定时保留；恢复通知不能重复自动发最终答案。
- [x] 核实队列重启后未提交消息有明确“核对后重新发送”提示；运行中原 turn 能继续跟踪，其他 turn 不能被误认为该任务结果。
- [x] 运行上述测试与 `workbench-queue-hardening.test.mjs`，预期零失败、零取消。

### Task 3: 原生问题、审批与跨端同步

**Files:** `src/channels/shared/text-harness-bridge.mjs`、`src/channels/discord/discord-bridge.mjs`、`src/channels/discord/discord-runtime.mjs`、`plugin-src/host/session-sync-coordinator.mjs`（仅必要时）；测试 `test/channels/discord/discord-cards.test.mjs`、`test/session-sync-coordinator.test.mjs`、`test/delivery-adapter.test.mjs`。

**Interfaces:** 审批 token 保存 `approvalId/nonce/key/sessionId/actor`；`acceptApprovalCallback(callback)` 必须验证 channel/kind/actor/当前绑定，提交仍走 `HarnessApprovalQueue.submitByApprovalId`。多选走 `DISCORD_INTERACTION_CARD.answer(question,parsed,callback)`。

- [x] 写失败用例：相同 actor 跨频道、伪造 kind、Session 已变、机器人 sender 均不能批准；正确来源仍可提交一次。
- [x] 实现审批作用域校验；Web 先处理后 Discord 返回真实已处理状态。同步审批复用原生卡片并保留宿主 validate。
- [x] 验证多选、无效选项、文字补充、重复点击；核实 Gateway values 正确传入。
- [x] 验证 Guild 同步目标、来源去重、同一 Session 新用户消息/结果及可用状态事件。
- [x] 运行卡片、同步、投递适配及共享审批测试，预期无新增失败或取消。

### Task 4: 深度归档前的数据保存与恢复

**Files:** `src/channels/discord/workbench/commands.mjs`、`workbench-store.mjs`；必要时新增 `archive-snapshot.mjs`；测试 `test/channels/discord/workbench-command-hardening.test.mjs` 及归档专用测试。

**Interfaces:** 深度归档在用户确认后先核实 Session 无运行/排队任务；历史/必要附件可靠保存完成并持久记录后才允许 `deleteChannel({channelId})`。恢复仍使用原 Session。

- [x] 核实 DSH 历史/文件接口及现有保存保证；不使用猜测的宿主 API。
- [x] 写失败用例：历史读取失败、分页不完整、必要附件无法保存时不删除频道。
- [x] 实现可恢复的归档准备/保存/删除状态；保存文件权限受限，不将会话正文加入 Git。
- [x] 验证删除权限不足、404、重复确认、恢复失败重试、容量不足均保留索引且不会重复创建。
- [x] 运行归档与 store 测试，预期零失败、零取消。

### Task 5: 网关和生产接线回归

**Files:** `src/channels/discord/discord-runtime.mjs`、`discord-api.mjs`、`workbench/rate-limiter.mjs`、`plugin-src/host/channels/discord/production.mjs`；测试 `test/channels/discord/*.test.mjs`。

**Interfaces:** Gateway READY/RESUMED 触发 journal 核对；状态存储及 workspace scoped harness 必须走生产注入接口。

- [x] 参考本机 Hermes Discord recovery 与 Telegram 网络实现，记录适用原则（重连退避、会话恢复、投递不确定性）；保持本项目 Node/DSH 架构。
- [x] 验证 Gateway 断线/恢复/无效 session、重复事件、白名单和 Guild 隔离；任何缺口先补失败测试再修复。
- [x] 验证 204 交互响应、3 秒内 defer、429 bucket/global、附件重试 nonce、消息创建/编辑 allowed_mentions、长任务普通 Bot 消息投递。
- [x] 跑完整 Discord 定向集，预期零失败、零取消。

### Task 6: 全量验证、文档、安装包与 Fork 交付

**Files:** `docs/discord-workbench.md`、既有设计文档、`package.json`（仅打包所需）、构建产物 `lib/**`、本计划执行记录。

**Interfaces:** `npm run build` → `npm test` → `node scripts/verify-package.mjs` → `npm pack`；发布到已授权 Fork 功能分支，不创建上游 PR 或 npm 发布。

- [x] 运行完整检查，记录通过/失败/取消数及退出码；对失败定位到测试名称。与未修改上游基线对比区分原有问题，不放宽关键断言掩盖失败。
- [x] 进行一次独立代码审查，修复实际影响需求的发现并回归相关测试。
- [x] 更新文档中的已过时限制、恢复语义、附件保留策略、深度归档、同步范围、独立安装/升级/备份/回滚及真实验收清单。
- [x] 检查安装包包含配置脚本和所需源文件；生成包与 SHA-256。
- [x] 提交接续成果、推送 `origin feat/discord-guild-workbench`，核实远端 commit 与本地一致。
- [x] 交付 Fork/分支/commit、实测版本和测试结果、安装包、明确限制。真实 Discord 联调若无凭据标记未验证。

## 执行记录

- 2026-10-13：计划已基于原始需求、原会话、实际 diff 和 197 项定向测试自审。旧会话未完成的工作与文档声明不一致，以本轮测试为准。

- 2026-10-13：任务 1–5 完成；模型夹具按真实 groups 契约修正，Session 创建不确定记录保留。持久恢复和旧 deferred 路径隔离，审批作用域、多选与推理强度通过回归。
- 独立审查发现的并发预约、归档历史权限/新消息检查、排队后上下文变化、未提交队列恢复、频道恢复断点问题均已修复。复核补充的两项边界用例（通知结果不明、已登记替代频道被删除）通过。
- 新增停止流程回归：延迟入站日志落盘时 stop 必须等待完整处理器，且不能提交任务；同时修复测试夹具先删除目录再关闭运行时的顺序。
- 最终 `npm run check` 退出码 0：4174 tests / 4174 pass / 0 fail / 0 cancelled / 0 skipped；构建及包验证通过。Discord 定向测试最近一次 237/237。完整日志 `/tmp/dsh-im-final-check-20261013.log`。
- 测试进程对模拟传输增加 keep-alive preload，并设置每项 60 秒上限，解决 AbortSignal.timeout/unref 在无网络句柄时提前取消测试；未改变生产超时语义。
- 验证范围为本地 Mock、构建和包内容；没有测试 Bot 配置，真实 Discord/代理链路和隔离 Profile 实装联调未验证。

- 实现提交 `6f29d61e2a6fb625f2f6efcead8888428985d677` 已推送 Fork，`git ls-remote` 与本地一致。安装包、校验值与验收边界见 `docs/discord-workbench-delivery-2026-10-13.md`。后续提交仅补充本交付记录。
