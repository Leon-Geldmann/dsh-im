# Discord 原生 DSH 工作台（Guild Workbench）设计与实现计划

基线：dsh-im 4.38.0（commit bbafc99），DSH 0.2.0-rc.2。分支 `feat/discord-guild-workbench`。

## 目标

把现有 Discord 渠道从「服务器频道 @ 一次后开 Thread」升级为可长期个人使用的
原生工作台，同时保留原 Thread 模式与其它渠道行为：

1. 一个 Discord 服务器（Guild）绑定一个 DSH 实例（Bot）。
2. 一个 Category 对应一个项目：项目 ID、工作目录、会话分组。
3. 一个受管文字频道固定对应一个 DSH Session，长期不变。
4. 频道内直接发消息即可继续会话，无需 @。
5. 原生 Slash Command、按钮、Select、Modal：建会话、选模型、审批、提问、
   停止、补充指令、压缩上下文、归档、诊断。
6. DSH 网页/客户端与频道的双向同步（同一 Session）。
7. 单实例、单 Guild 的个人部署优先；保留扩展空间。

## 不可破坏的约定

- 所有 Discord ID 以字符串保存；名称不参与寻址，不拼文件系统路径。
- Channel → Session 一一对应；`/session new` 必须新建频道，不在原频道偷换绑定。
- 已绑定 Session 查询失败/不存在时保留映射并报错，绝不自动补建。
- 项目目录必须位于配置允许的根目录内；绑定已有目录要校验真实存在。
- 访问控制在下载附件、建会话、调用 DSH 之前完成；「能看到频道」不等于
  「可以执行指令」。
- 复用的持久映射与任务队列分离；不声称 exactly-once。
- 旧 Thread 模式、其它渠道与共享桥接命令的既有语义不回归。

## 数据模型

Bot 配置（`config.json` 的 bot 扩展，`DiscordConfigStore.normalizeBotExtension`）：

```
workbench: {
  enabled: boolean, guildId: string|null, allowedUserIds: string[],
  projectRoots: string[], maxConcurrentTasks: number, projectConcurrency: number,
}
```

持久状态（`<botsDir>/<botId>/workbench.json`，原子写入 + 规范化丢弃非法项）：

```
{
  version: 1,
  guildId: string|null,
  projects:  { [projectId]: { projectId, name, categoryId, workspacePath, createdAt } },
  channels:  { [channelId]: { channelId, projectId, sessionId, title, lifecycle,
                             createdAt, updatedAt, lastError } },
  sessions:  { [sessionId]: { channelId, projectId, state, archivedAt } },
  actions:   { [actionId]: { kind, operatorId, guildId, channelId, sessionId,
                             payload, expiresAt, consumedAt } },
  operations:{ [opId]: { kind, state, payload, createdAt, updatedAt } },
  processed: [ { id, at } ],
}
```

`actions` 支撑交互按钮/Modal：操作者、Guild、频道、Session、请求 ID、有效期、
是否已消费；重复点击、过期、跨频道、已在他端处理都安全返回实际状态。
`operations` 记录创建频道/Session、归档等多步操作的中间状态，支持恢复。

## 模块划分（新增 `src/channels/discord/workbench/`）

| 文件 | 职责 |
| --- | --- |
| `workbench-store.mjs` | 持久化、规范化、原子写入、动作/操作/去重游标 |
| `access.mjs` | Guild 绑定校验、owner+白名单判定、操作者归属 |
| `project-registry.mjs` | Category↔项目映射、目录根约束校验、名称→路径安全 |
| `channel-session-router.mjs` | 频道→Session 解析：首次建会话并发锁、失效不补建 |
| `rate-limiter.mjs` | 按 Discord Bucket/Retry-After 调度，全局 429 暂停 |
| `queue.mjs` | 同 Session 串行、全局/项目并发上限 |
| `interactions.mjs` | INTERACTION_CREATE 路由、action 校验、defer/回执 |
| `slash-commands.mjs` | 命令定义、注册 payload、命令处理 |
| `session-card.mjs` | 频道会话信息卡（项目/目录/模型/状态/操作入口） |
| `archive.mjs` | 普通/深度归档、恢复索引、容量检查 |

共享改动（保持旧模式不变，均为可选注入）：

- `src/channels/shared/workspace-session.mjs`：`askInWorkspaceSession` 增加
  `resolveSession` 钩子；工作台模式用自定义解析器替换「失效自动补建」。
- `src/channels/shared/text-harness-bridge.mjs`：可选 `sessionResolver` 透传，
  并把工作台路由错误渲染为明确中文提示。
- `src/channels/discord/discord-runtime.mjs`：Guild 消息在工作台模式下直连频道
  （不建 Thread）、忽略 Bot/Webhook 消息、操作者校验、INTERACTION_CREATE 分发、
  连接时注册 Guild 命令。
- `src/channels/discord/discord-api.mjs`：频道/Category 增删改、Guild 查询、
  应用命令注册、交互回调与回执、消息组件与 allowed_mentions、限流接入。
- `plugin-src/host/session-sync-coordinator.mjs` 与投递适配：把已开启同步的
  工作台频道作为合法 Session Sync 目标（含来自其它客户端的审批）。

## 命令面（Guild 命令，绑定 Guild 内注册）

- `/workbench`：`bind`（绑定当前 Guild）、`allow add/remove`、`root add/remove`、
  `status`。
- `/project`：`new <name> <path>`、`bind <category> <path>`、`list`、`info`。
- `/session`：`new [name] [project]`、`open <id>`、`info`、`history [n]`、
  `archive [deep]`、`restore <id>`。
- `/model`：显示/选择当前频道会话模型与推理等级（Select 组件）。
- `/task`：`stop`、`steer <text>`、`compact`。
- `/status`：连接、Guild 绑定、项目、Session、队列状态卡。

会话信息卡按钮：刷新、新会话、停止、模型、补充指令（Modal）、归档。
问题/审批复用共享桥接的交互语义，按钮绑定真实 Session/Turn/请求。

## 生命周期与语义

- 频道改名/Category 改名：保留项目标识、Session 与工作目录。
- 频道被移入其它项目 Category：标记归属冲突，处理前不向错误目录提交。
  无原生迁移时给出「移回原分组」或「在目标项目另建会话」两个明确选项。
- 任务运行中不改变工作目录。
- 删除 Discord 频道/Category 不删除 DSH 历史或项目文件。
- 普通归档保留只读频道；深度归档经确认删除频道但保留 Session 与恢复索引。
- 接近频道/Category 上限时提示；失败保持原数据，不反复创建。

## 并发与恢复

- 同 Session 提交与串行（程序实现，不靠提示词）。
- 全局重任务并发默认 1，同项目默认串行；不同项目可配置并行。
- 重复 Gateway 事件不重复提交；断线重连继续跟踪原任务。
- 提交结果不确定时先核对 DSH 状态与历史，不直接重放。
- DSH 重启导致任务中断时明确显示「中断」，不静默改状态。

## 测试矩阵（离线，Mock Discord API + Mock Harness）

1. 两项目多频道隔离；2. 跨工作区绑定不清空其它映射；3. `/session new` 新频道新
Session 且原绑定不变；4. 绑定 Session 失效不自动替换；5. 并发首条消息只建一次；
6. 交互权限/过期/重复/跨频道；7. 改名、跨 Category、删除、归档、恢复；8. 半成功
恢复；9. 断线、重复事件、重启、提交不确定；10. 长任务不依赖交互 Token；
11. 限流与最终输出完整性；12. Web/Discord 同步去重与审批竞争；13. 未授权用户/
其它 Guild/未绑定频道不触发；14. 旧 Thread 模式与其它渠道回归。

真实 Discord 联调需要 Bot Token、测试 Guild 与可运行 DSH；缺少时以离线验证交付，
并在验收清单中标注「尚未真实联调」。

## 分阶段

1. 状态层：store、配置、访问、项目注册表（含测试）。
2. 路由层：`resolveSession` 钩子、频道直连、首次建会话锁（含测试）。
3. 交互层：API 扩展、限流、命令、组件、信息卡（含测试）。
4. 生命周期：归档、队列、半成功恢复、同步（含测试）。
5. 文档、构建、打包、验收清单。

## 实施状态

- 第 1-5 阶段已完成：状态层、路由层、交互层（命令/组件/Modal/信息卡/限流）、
  生命周期（归档、深度归档、恢复、半成功恢复）、任务队列、Discord 频道的
  Session Sync 目标与审批归属。
- 离线测试：`workbench-store`、`workbench-access`、`workbench-project`、
  `workbench-routing`、`workbench-queue-rate`、`workbench-interactions` 及
  `delivery-adapter` 的 Guild 同步用例全部通过；`npm test` 全量 0 失败。
- 构建：`npm run build` 与 `node scripts/verify-package.mjs` 通过。
- 尚未真实联调：需要 Bot Token 与测试 Guild，详见 `docs/discord-workbench.md`
  的验收清单与"已知限制"。
