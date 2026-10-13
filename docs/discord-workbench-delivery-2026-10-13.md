# Discord 工作台接续交付 — 2026-10-13

原会话“构建 Discord 原生 DSH 工作台”因模型容量不足连续中断；本轮保留其未提交实现，按接续计划完成开发、审查、离线验证、打包和 Fork 推送。

- Fork：[Leon-Geldmann/dsh-im](https://github.com/Leon-Geldmann/dsh-im/tree/feat/discord-guild-workbench)
- 分支：`feat/discord-guild-workbench`
- 实现提交：[`6f29d61e2a6fb625f2f6efcead8888428985d677`](https://github.com/Leon-Geldmann/dsh-im/commit/6f29d61e2a6fb625f2f6efcead8888428985d677)，推送后已核对远端 SHA。
- [接续计划](superpowers/plans/2026-10-13-discord-workbench-takeover.md) · [原始需求](superpowers/specs/2026-10-13-discord-workbench-requirements.md) · [使用及独立安装说明](discord-workbench.md)

## 实现与验证

完成固定 Session 路由与操作范围隔离、模型及推理强度选择、原生问题/审批、Guild 同步路径、持久任务日志和附件缓存、重启恢复与并发预约、深度归档快照及断点恢复、Gateway/REST 可靠性收尾。

独立审查发现的七项问题及复核的两项恢复边界均已修复并增加回归。另修复停止流程早于外层异步落盘完成的问题，以及测试夹具清理顺序。

`npm run check` 退出码 **0**：**4174 tests / 4174 pass / 0 fail / 0 cancelled / 0 skipped**；客户端/宿主构建及包验证通过。定向 Discord 测试最近一次 237/237，通过后的停止提交保护也包含在最终全量检查中。测试运行器对无网络句柄的模拟传输使用 keep-alive preload 和 60 秒测试上限，避免 unref 超时被误判为取消；生产超时语义未改动。

实测环境：Node **22.23.2**、DSH **0.2.0-rc.2**、插件版本 **4.38.0**。保留原包名与版本，安装时应使用此 Fork 的明确构建包。

## 本机交付文件

目录：`/home/leon/.local/state/dsh-im-work/releases/2026-10-13/`

- `xmanrui-dsh-im-4.38.0.tgz`：9,671,616 字节，440 个文件。
- `xmanrui-dsh-im-4.38.0.tgz.sha256`
- `check.log`：最终全量验证输出。
- `discord-targeted.tap`：最近一次定向测试输出。

SHA-256：

```text
098948ce120a6c4f7db0a4e6f9aee1845c5abe71260341903b8a2450e978285c
```

已检查包内配置脚本、使用文档、任务日志、附件缓存、归档实现和 lib 构建文件存在且与源码一致。交付记录和接续计划不在安装包白名单中，后续文档提交不改变此安装包。

## 尚未验证与能力边界

本机未配置测试 Bot，真实 Discord HTTP/Gateway、代理链路和隔离 Profile 实装联调尚未验证。下一步按使用文档第 12 节及第 14 节的真实验收清单执行，需要测试 Bot、Guild、授权用户及项目根目录。本轮没有替换生产插件、修改生产配置、发布 npm 或创建上游 PR。

恢复保留提交/投递不确定状态，不保证结果附件自动补投；并发保护只覆盖本工作台任务，非整个 DSH 的跨客户端目录锁。深度归档保存历史及 Discord 附件，不替代项目/DSH 数据库备份；Discord 缺少原子条件删除 API，最终核查与删除之间仍有竞争窗口。完整限制见使用文档第 13–15 节。
