# Discord 原生 DSH 工作台（Guild Workbench）

面向个人长期使用的 Discord 使用方式：**一个服务器绑定一个 DSH 实例，一个分组
（Category）对应一个项目，一个文字频道固定对应一个 DSH 会话**。频道内直接发消息
即可继续会话，无需每次 @ 机器人；建会话、选模型、停止任务、补充指令、压缩上下文、
归档与恢复都可以在 Discord 原生命令和组件里完成。

本文件同时是安装说明、运维手册与验收清单。设计取舍见
`docs/方案/Discord-原生工作台-设计与实现计划.md`。

## 1. 适用范围

- 一个 DSH 实例、一个 Discord Bot、一个绑定 Guild。
- 单用户或少数受信用户（owner + 白名单）。
- Discord Gateway 长连接，不需要公网回调地址。
- 原 Thread 模式、其它 IM 渠道的行为保持不变；工作台是显式开启的可选模式。

## 2. 数据模型与访问控制

| 层级 | 绑定 | 持久位置 |
| --- | --- | --- |
| Guild | 一个 DSH 实例 / Bot | bot 配置的 `workbench` 块 + `workbench.json` |
| Category | 一个项目：项目 ID、工作目录 | `workbench.json` |
| Channel | 一个固定 Session | `workbench.json` |
| 交互动作 | 操作者、Guild、频道、Session、请求、有效期、是否已消费 | `workbench.json` |

约定：

- 所有 Discord ID 以字符串保存，名称只用于显示，不参与寻址、不拼文件系统路径。
- Session 与频道一一对应；已绑定会话查询失败或不存在时**保留原绑定并报错**，
  不会自动补建替代会话。
- 目录必须位于 `projectRoots` 内，且经过真实路径校验（软链接无法逃逸）。
- 进入下载附件、创建会话或调用 DSH 之前完成操作者校验：owner（应用所有者）
  或 `allowedUserIds` 中的用户。绑定 Guild 内非白名单用户的任何消息都不会触发任务。

## 3. 首次配置

工作台配置保存在 Discord 渠道的 bot 记录里。首次开启推荐使用随包脚本：

```bash
# DSH_HOME 默认 ~/.dsh；config.json 位于 integrations 目录
node scripts/configure-discord-workbench.mjs \
  --config ~/.dsh/integrations/dsh-discord/config.json \
  --bot discord_1234567890123456789 \
  --guild 444444444444444444 \
  --allow 333333333333333333 \
  --root /srv/projects \
  --max-tasks 1 \
  --project-concurrency 1
```

脚本只改动 `workbench` 块，写入前自动备份（`config.json.bak-workbench-*`），
不读取也不输出 Token。关闭工作台用 `--disable`。

手动等价写法（bot 记录中的一段）：

```json
{
  "workbench": {
    "enabled": true,
    "guildId": "444444444444444444",
    "allowedUserIds": ["333333333333333333"],
    "projectRoots": ["/srv/projects"],
    "maxConcurrentTasks": 1,
    "projectConcurrency": 1
  }
}
```

改完后重启 Discord Bot（DSH 设置页里断开重连即可）。启动成功后，Bot 会向
绑定 Guild 注册工作台命令。

## 4. Discord 应用配置

1. Developer Portal → Bot：
   - 开启 **Message Content Intent**（频道内直接发消息必需）。
   - 开启 **Server Members Intent**（可选：便于成员/身份显示）。
2. 机器人权限（OAuth2 → URL Generator，scope `bot` + `applications.commands`）：
   - View Channels、Send Messages、Read Message History、Attach Files
   - Manage Channels（`/project new`、`/session new`、恢复归档需要创建/删除频道）
   - Create Public Threads、Send Messages in Threads（保留旧 Thread 模式）
   - Embed Links、Add Reactions
3. `applications.commands` scope 必须包含，否则无法注册原生命令。
4. 不需要 Message Intent 之外的任何特权，也不需要公网地址。

## 5. 使用方式

### 5.1 频道消息

- 已纳入工作台的频道：直接发文字、图片、文件即可继续该频道的固定会话。
- 项目分组下新建的普通文字频道，**第一条白名单用户消息**会自动登记并按项目目录
  创建会话（并发安全，只会创建一个）。
- 机器人/Webhook 消息被忽略；模型输出不会触发 @everyone 等提及。

### 5.2 原生命令

| 命令 | 说明 |
| --- | --- |
| `/status` | 连接、工作台、当前频道与会话状态 |
| `/workbench status\|bind\|allow\|root` | 绑定服务器、维护白名单与项目根目录 |
| `/project new\|bind\|list\|info` | 创建/绑定项目与分组，查看目录映射 |
| `/session new\|open\|info\|history\|archive\|restore\|sync` | 新会话频道、绑定已有会话、历史、归档/恢复、双向同步 |
| `/model` | 列出并切换当前会话模型及该模型支持的推理强度 |
| `/task stop\|steer\|compact` | 停止、补充指令、压缩上下文 |

命令在绑定 Guild 内即时生效（Guild 命令），不做全局注册。

### 5.3 频道会话卡

会话卡显示项目、工作目录、会话 ID、模型、运行状态与排队数，并提供按钮：
刷新、新会话、停止、补充指令（Modal）、归档/恢复、模型下拉。
每个按钮只带一个服务端保存的动作 ID；点击时会校验操作者、Guild、频道、有效期与
是否已消费，重复/过期/跨频道点击都会安全返回真实状态。

### 5.4 提问与审批按钮

- DSH 需要补充信息且问题带选项时，频道会收到按钮卡片：点击即提交所选选项，卡片
  随即去掉按钮，后续点击返回"已失效"。
- 1–25 个选项的多选问题使用原生下拉多选；单选选项较多时也使用下拉。无选项或超过组件限制时保留文字回答；文字补充遵循 DSH 问题语义。
- 审批请求以「批准一次 / 拒绝」按钮呈现，沿用 DSH 的审批语义：只有发起该任务的
  操作者可以处理，先处理的一端（Web 或 Discord）生效；按钮只携带一次性令牌，
  过期、转发或已处理的点击都会返回真实状态。

### 5.5 打字命令的边界

工作台频道内 `/new`、`/workspace`、`/preset` 等旧命令会被明确拒绝，避免它们
修改 Bot 全局默认或清空其它频道的会话映射；请改用原生命令。旧 Thread 模式与
其它频道的打字命令保持原行为。

## 6. 生命周期

- **改名**：频道/Category 改名不影响项目、目录与 Session。
- **移动频道**：把受管频道拖到别的分组只改变显示位置。工作台以登记时的项目为准；
  需要换项目时请在目标分组用 `/session new`，或把频道移回原分组。
- **归档（普通）**：`/session archive` 标记归档，频道保留、不再接受新任务。
- **归档（深度）**：`/session archive deep:true` 需点击确认按钮。先核实权限、任务状态，完整保存 DSH 历史、Discord 消息和附件，再删除频道；原 Session 与恢复索引保留。历史读取、附件保存或最终频道检查失败均不删除。
- **恢复**：`/session restore <会话ID>` 在原项目重建频道并复用原 Session。
- **删除频道/Category**：不会删除 DSH 历史或项目文件。
- **空频道创建竞态**：`/session new` 与首条消息共用会话创建日志。已知创建成功但绑定失败时重试同一 Session 的绑定；创建结果不确定时保留记录并提示核对，不会重复创建。
- 创建和恢复前检查服务器 500 个频道、Category 内 50 个频道的容量，接近上限时提示；平台 API 仍是最终依据。

## 7. 并发与限流

- 同一会话串行执行（程序内队列，不依赖提示词）。
- 同项目默认串行（`projectConcurrency`），避免两个频道同时改同一目录。
- 全局重任务并发默认 1（`maxConcurrentTasks`）。
- 停止/审批/补充指令等控制请求不排在任务队列后面。
- Discord API 按响应头中的 Bucket、`Retry-After`、`X-RateLimit-*` 调度；全局 429
  会暂停所有请求，频道级 429 只暂停该路由。
- 重复 Gateway 事件按消息 ID 去重；断线重连后继续跟踪原请求 ID 的任务。4007/4009 会清除失效的 Gateway session 后重新 Identify。
- 已提交但未确认结束的任务在进程重启或观察超时后继续占用并发容量；后续任务若无法安全进入会明确拒绝，确认原任务结束后再发送。
- 任务实际获得执行名额时再次检查固定绑定、归档状态、Category 和项目真实路径，排队期间发生变化不会向旧目录提交。

## 8. 双向同步

`/session sync action:on` 后：

- DSH 网页/客户端在**同一 Session**产生的新用户消息与最终回答会镜像到该频道
  （`[来自 DSH]` / `[DSH 助手]` 前缀）。
- 已从 Discord 发出的消息不会被镜像回来后重复提交。
- 来自其它客户端的审批请求会发到频道；Web 与 Discord 先处理的一端生效。
- 关闭同步用 `/session sync action:off`。

## 9. 测试与验证

离线（Mock Discord API + Mock Harness）覆盖：

- 两项目多频道隔离、跨工作区绑定不影响其它映射；
- `/session new` 新建频道+会话、原绑定不变；
- 绑定 Session 失效/查询失败不自动替换；
- 并发首条消息只建一次会话；
- 交互权限、过期、重复、跨频道校验；
- 改名、移动、删除、归档、恢复；
- 创建频道/会话半成功恢复；
- 队列并发、项目串行、限流 Bucket/全局 429；
- 工作台频道作为 Session Sync 目标的键校验。

真实联调（需要 Bot Token 与测试 Guild）覆盖：命令注册、频道消息直连、按钮/Modal、
审批竞争、附件收发的端到端链路。缺少凭据时按"尚未真实联调"记录，不做替代声明。

## 10. 升级、回滚与合并上游

- 本定制位于独立分支（见仓库交付说明），`origin` 指向个人 Fork、`upstream`
  指向 `xmanrui/dsh-im`；合并上游更新时先 `git fetch upstream`，
  `git rebase upstream/main`（或 merge）后重跑 `npm test` 与 `npm run build`。
- 定制代码集中在 `src/channels/discord/workbench/**`、`scripts/configure-discord-workbench.mjs`
  与本文件；对共享层的改动均为**可选注入**，未开启工作台时行为与上游一致。
- 回滚：把 `workbench.enabled` 置为 false（脚本 `--disable`）并重连 Bot 即可回到
  旧 Thread 模式；恢复原模式前完整备份 `workbench.json`、`inbox/`、`archives/`；不要直接删除有未核实任务的工作台状态。DSH 会话与项目文件独立保留。

## 11. 已知限制

- 频道被拖入其它项目分组不会自动迁移会话：工作台不做"看起来成功"的假迁移，
  需要显式 `/session new` 或移回原分组。
- 深度归档依赖 Discord 删除频道权限；删除失败时保留登记并记录错误，可重试。
- 项目 ID 由名称生成（小写字母/数字/短横线），显示名称可随时修改。
- 工作台配置目前通过脚本/配置文件与 `/workbench` 命令维护，DSH 设置页的图形化
  工作台配置尚未提供。
- 双向同步只镜像绑定之后的新事件；历史请在 DSH 或 `/session history` 查看。

## 12. 验收清单

1. `npm run check` 退出码 0，测试无失败、无 cancelled；构建及包检查通过。
2. 绑定 Guild 后，Bot 在该服务器可见工作台命令（`/status` 有响应）。
3. 项目分组下新建频道 → 发一条消息 → 自动创建会话并回复；`/session info` 显示
   固定 Session。
4. 同一频道再发消息 → `/session info` 的 Session 不变；机器人不建 Thread。
5. `/session new` → 新频道 + 新 Session；旧频道绑定不变。
6. 在 DSH 里删除/归档该 Session 后回到频道发消息 → 收到"会话已不存在"提示，
   `/session info` 仍显示原 Session（不自动替换）。
7. 非白名单用户在频道内 @ 机器人 → 无任何任务与回复。
8. 运行长任务时 `/task stop`、补充指令按钮可用；重复点击按钮提示已执行。
9. `/session archive deep:true` → 确认后频道消失，`/session restore` 能重建并复用
   原 Session。
10. `/session sync action:on` 后，在 DSH 网页同一会话发消息/等回答 → 频道出现镜像。


## 13. 持久恢复、附件与归档保存（2026-10-13）

- `workbench.json` 的 `message-task` 日志分别记录 queued、submitting、running、completed、delivering、delivered，以及提交/投递不确定状态；保存 sessionId、promptRpcId、历史位置和回执。
- 入站附件在权限、路由、目录校验后立即写入同目录的私有 `inbox/`，避免排队期间 CDN 链接失效。确定成功/失败路径清理缓存；不确定状态保留缓存以便核查，备份时一并保存。
- 工作台任务由自己的日志恢复，不同时注册共享的 deferred delivery。普通渠道沿用旧路径。
- 重启前尚未提交的排队消息提示核对后重发，先将原记录标为 cancelled，再尝试通知；通知结果不确定也不会继续占用归档阻塞状态；不会静默重放。提交不确定时查询原请求对应的历史，无法确认就继续保留，不猜测已执行/未执行。
- 已识别的原 turn 仍运行时继续跟踪，已结束时补投最终文本。投递结果不明时不自动重发，提示在 DSH 查看。自动恢复不保证结果附件补投，原产物仍应在 DSH/项目目录查看。
- 深度归档快照位于工作台状态同目录的 `archives/<channelId>-<uuid>/`：`manifest.json` 含 DSH 历史、Discord 消息和附件索引，附件用内部文件名存储（原文件名仅作为元数据）。目录 0700、文件 0600，完成写盘后才记为 saved。
- 深度归档核实有效的查看频道、读取消息历史、管理频道权限；未完成/未核实任务会阻止删除。快照过程中频道出现新消息也会中止删除。归档期间请停止其他客户端/用户写入：Discord 没有“读取快照并条件删除”的原子 API，最后核查与删除之间仍有极短竞争窗口。
- 普通归档及准备深度归档会停止工作台接收新任务，不修改 Discord 成员权限覆盖；成员仍可能发消息。保存失败会保留频道，可重试深度归档或恢复。
- 恢复会核对 Discord 上的真实频道：确认不存在时重建；权限/网络不确定时保留绑定。已保存的新频道 ID 可继续登记，避免重复建频道。

## 14. 定制版安装与交付边界

仓库：`https://github.com/Leon-Geldmann/dsh-im`，分支 `feat/discord-guild-workbench`。
本轮运行环境：Node 22.23.2、DSH 0.2.0-rc.2、插件源码版本 4.38.0。

先在独立 DSH_HOME/Profile 验证，安装已构建 tarball：

```bash
# 使用本次交付的绝对 tarball 路径；此命令不会在本轮自动执行
DSH_HOME=/absolute/path/to/dsh-discord-test dsh plugin --profile web add /absolute/path/to/dsh-im-workbench.tgz
# 在同一个 DSH_HOME 配置测试 Bot、Guild、白名单与允许根目录后启动
DSH_HOME=/absolute/path/to/dsh-discord-test dsh web --no-open
```

生产启用前备份 DSH Profile、插件包及完整 integrations 状态目录，在维护窗口按同样
方式安装已验证包并重启。保留 tarball 和 SHA-256，升级定制版时从 Fork 的明确提交构建。
不要通过原版 npm 安装/插件上游更新按钮覆盖该包；恢复原版前先禁用工作台并备份全部状态。
本轮未替换生产插件、未修改生产配置、未发布 npm 或上游 PR。

离线 Mock 测试不能证明真实 Discord/代理链路通过。当前未配置测试 Bot，真实端到端
需要 Bot Token（仅写本机配置）、Guild ID、授权用户 ID 和测试项目根目录；按第 12 节
清单验证，并增加：多选、推理强度、Web/Discord 审批竞争、长任务断线恢复、归档附件保存。

## 15. 仍需注意的能力边界

- 并发保护覆盖本工作台受管任务及其恢复记录，不是整个 DSH 实例的跨客户端全局调度锁；其他客户端在不同 Session 对同一目录启动任务仍需协调。
- 提交结果不确定且宿主没有可关联历史时，系统保留记录和并发保护，不提供自动强制重放。需先人工核对 DSH，不能仅删除日志来尝试“解锁”。
- 快照未保存 DSH 内部数据库或项目完整副本；删除频道不删除 DSH Session，项目文件另行备份。
- 工作台设置页仍由脚本/原生命令提供；未增加图形化项目配置面板。
- 参考本机 Hermes 的持久消息游标、断线恢复和网络重试边界，沿用本项目的 JSON 状态、DSH 请求身份和 Node 网络层；没有移植 Telegram 的专用 DNS fallback 或新增外部数据库。
