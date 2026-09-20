# 更新日志

本项目遵循[语义化版本](https://semver.org/lang/zh-CN/)。

> **0.6.0 是本次公开发布的最终版本**，作者不承诺后续更新——详见 README 的「维护状态」一节。

## 0.6.0

- **访客工具闸**：非拥有者的消息驱动 Agent 时，禁用 DSH 内部工具（bash / 读写 / 子代理 / …）。
  实现为 `tools.guard`，只在建会话时注册一次，判据是可变标志位——因此不注入提示词、
  不改工具表、不记 `request/header`，**0 额外 token**，且保持单会话单历史。
- 采用**白名单**而非黑名单（`auth.guestToolAllow`，默认 `qqbot,qqgroup`），
  使 `run_code` 这类"不在全局层"的 PTC 保留传输也自动被挡。
- 会话分流（`ownerPreset` / `guestPreset`）**降级为可选的人格分离**，默认关闭；
  文档与设置页明确标注它不再是安全边界。
- 设置页新增「允许非拥有者使用 DSH 内部工具」「访客仍可用的工具白名单」。

## 0.5.0

- **权限模型重做**，改为三路并行取并集：
  1. 静态名单：`auth.owners`（拥有者，含永久授权）、`auth.superAdmins`（后台设定的高级管理员）
  2. 动态授权：群维度、可带时限，由拥有者或本群管理员授予，**不可跨群生效**
  3. 本群身份：`get_group_member_info` 查到 admin / owner
- 新增 `/whoami`、`/perms`、`/grant`、`/revoke`、`/grants`；权限来源会如实列出。
- **指令严格匹配**：前缀必须在消息首位；动词必须完全匹配；token 数必须落在
  该指令声明的 `[min,max]` 内，多余内容判为用法错误且不执行——防止聊天内容夹带
  指令样内容被误执行。
- Agent 工具 `qqgroup` 改用同一套鉴权，"说话人"取自本会话最近一条消息。
- **reply 透传**：适配器解析 `[CQ:reply,id=…]` 并输出 `reply_to`，
  `/recall` 因此支持"回复某条消息即可撤回"；同时 reply 段不再污染正文
  （否则正文以 `[回复]` 开头，斜杠就不在首位了）。

## 0.4.0

- 新增群管理：QQ 侧指令（`/mute`、`/kick`、`/banall`、`/card`、`/admin`、`/recall`、
  `/rename`、`/members`、`/info`、`/help`）+ Agent 工具 `qqgroup`。
- 适配器新增**通用 action 通道**，任意 OneBot 11 动作都可透传，无需为每个动作改代码。
- `notice` / `request` 事件改为**全字段透传**（此前丢了 `operator_id`、`duration`、
  `target_id`、`card` 等群管理必需字段）。
- 引入「演练模式」`admin.dryRun`：只回复将执行什么，不真执行。

## 0.3.2

- **修复** `registration.schema.toJSON is not a function`：设置命名空间的 schema
  必须同时是可调用的解析函数和可 JSON 化的对象。
- `access_token` 改为**只写字段**：不上发到浏览器，留空即不修改（避免保存时被清空）。
- **修复**保存成功后按钮卡在「保存中…」（`setSaving(false)` 漏在成功分支）。

## 0.3.1

- 文档补充升级注意事项：`dsh plugin add` 走 pnpm，按 tarball 完整性缓存，
  改代码必须打成**新版本号文件名**再装，否则会被判成 lockfile 最新而跳过。

## 0.3.0

- 新增**客户端半边**：在 DSH「设置」里贡献「QQ 机器人」选项卡，配置项全部可视化修改。
- 手写客户端 bundle（`window.__ModuleLoader__.load`），只 `require('react')`，无需打包器。
- 配置分两层：composition 行配置是 base 层，设置面板改的是用户层。

## 0.2.0

- 首个可安装的插件包：`dsh plugin --profile web add` 即自动注册为 profile 层。
- OneBot 11 适配器（零 npm 依赖，用 Node 22 内置 `WebSocket` / `fetch`）：
  正向 WebSocket 收事件 + HTTP API 发消息，自带指数退避重连与发送限速。
- 每个 QQ 会话对应一个 DSH Agent，会话落盘并出现在 Web UI。
- 群聊默认要求 @机器人，私聊直接回，长回复按换行分片。

## 0.1.0

- 未发布的原型：以「动态 Cordis Package」形式在运行的 DSH 进程里验证了完整链路
  （`examples/dynamic-package-host.js` 保留了这一形态）。
