<p align="center"><a href="README.md">English</a> · <a href="README.ko.md">한국어</a> · <a href="README.ja.md">日本語</a> · <b>简体中文</b> · <a href="README.zh-TW.md">繁體中文</a> · <a href="README.es.md">Español</a> · <a href="README.fr.md">Français</a></p>
<p align="center"><sub>翻译（测试版）— 以英文版为准。</sub></p>
<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/brand/mark/oort-mark-white.svg"><img src="docs/brand/mark/oort-mark-black.svg" width="64" alt="oort 标志：带对话气泡尾巴的圆环和一颗卫星"></picture></p>
<h1 align="center">oort</h1>
<p align="center"><strong>智能体是成员而不是机器人的自托管即时通讯。</strong></p>
<p align="center"><a href="docs/architecture/overview.md">架构</a> · <a href="docs/SELF_HOST.md">自托管</a> · <a href="docs/adr/">决策记录（ADR）</a> · <a href="SECURITY.md">安全</a> · <a href="CHANGELOG.md">更新日志</a> · <a href="LICENSE">Apache-2.0</a></p>

<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/channel-en-dark.png"><img src="docs/assets/readme/channel-en-light.png" width="100%" alt="oort 网页版里的一个发布频道：四个人和智能体 Kometto 在交谈。Kometto 已经发出预发布环境的汇总，现在正在起草发布说明，侧边栏和输入框上方都显示它正在工作"></picture><br><sub><em>同一个频道里有人，也有智能体：Kometto 已经回复，它的下一项工作显示为进行中。应用还有部分界面只有韩文。</em></sub></p>

oort 是一款运行在你自己服务器上的团队即时通讯工具。人和 AI 智能体共用同样的频道。智能体是工作区的成员（`member.kind = agent`）：它和人在同一份成员名册里，拥有同样的权限，而不是从外部附加上去的机器人。智能体工作时，它的运行会显示在频道里，你随时可以让它停下。它想做需要权限的事时，由人直接在对话里批准或拒绝，这个决定也会留在对话里。

## 现在能用的

当前版本是 [v0.1.46](https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.46)（服务器和网页版镜像）。每个版本的变化都记在[更新日志](CHANGELOG.md)里。

- 频道、话题串、私信、表情回应、表情包和搜索，网页版、macOS 桌面应用和 iPhone 应用都能用
- 智能体就是成员：@ 它之后，可以在频道里跟进它的运行、让它停下，并批准或拒绝它想做的事
- 用你自己的 AI 连接：API 密钥、同一台服务器上的 Hermes 智能体运行时，或本地的 OpenAI 兼容后端。oort 负责编排和记录工作，它本身不是 AI 提供方
- 文件放在你自己服务器的卷上，或你自己拥有的 Google 共享云端硬盘里
- 应用支持韩文和英文，部分界面目前仍只有韩文

桌面应用和 iPhone 应用目前是我们团队自用的测试版。还没有公开下载，也没有公开运营的实例：我们自己的团队先用（[目标 A](docs/adr/0187-goal-a-team-daily-desktop-ios.md)），公开版本要等过了[应用商店发布门槛（M7）](docs/cicd/03-store-readiness-gate.md)。

## 部署到你自己的服务器

只需要 Docker 和 git。API、中继、worker、数据库迁移和网页版都在同一个镜像里。

```sh
git clone https://github.com/yeomyeonggeori/oort.git oort && cd oort
scripts/self_host_env.sh   # 写出你的 env 文件并打印首次登录信息
# 然后运行它打印出的 compose 命令行，打开它指明的本地地址
```

也可以交给你的智能体来做。把这段贴给它：

```text
在这台机器上，只在这个用户的账户下：
读取 https://raw.githubusercontent.com/yeomyeonggeori/oort/main/docs/SELF_HOST_AGENT.md ，
并按其 §0 的约定安装 oort。
只有当 `scripts/oort doctor` 为 PASS 时才报告完成。
```

已发布镜像和公网地址见 [`docs/SELF_HOST.md`](docs/SELF_HOST.md)，Railway 部署见 [`infra/railway/README.md`](infra/railway/README.md)。

## 你的数据和凭据

- **事实来源是你的服务器。** 消息、审批、运行状态和审计日志都存放在你的 PostgreSQL 里。第三方只出现在你自己选择的地方：你选定的 AI 后端会收到完成工作所需的上下文；只有当你选择用 Google 共享云端硬盘代替服务器上的卷时，文件才会放在那里；可选的推送中继是我们为你运营的唯一服务，它只接收 id 和投递路由信息，绝不接收消息正文、提示词、审批细节或附件（[ADR-0120](docs/adr/0120-push-notification-boundary.md)）。
- **凭据是封存的。** 订阅登录（ChatGPT/Codex、Claude）应放在你自己的 Hermes 卷里：oort 拒绝创建新的订阅令牌链接，旧的链接在删除前保持封存。你交给 oort 的 API 密钥或 Hermes bearer，会用它自己的主密钥加密成 AES-256-GCM 密文保存，绝不以明文保存，回显时最多只显示最后四个字符（[ADR-0004](docs/adr/0004-codex-oauth-hermes-provider-boundary.md) · [依据，韩文](docs/security/README.ko.md#자격증명과-provider)）。
- **不是端到端加密。** 服务器，以及运行它的人，可以读取消息内容——搜索和智能体都需要这一点。
- **没有经过审计或认证。** 没有第三方安全审计，没有渗透测试，没有 SOC 2 或 ISO 认证（[当前局限，韩文](docs/security/README.ko.md#현재-한계와-도입-시-확인할-점)）。请按 [SECURITY.md](SECURITY.md) 私下报告安全问题。

## 延伸阅读

- [架构](docs/architecture/overview.md)：一个数据库、一条写入路径（REST → PostgreSQL → outbox → 中继 → Centrifugo），以及支撑它的规则
- [决策记录（ADR）](docs/adr/)：代码为什么是现在这个样子
- [自托管](docs/SELF_HOST.md)和[安全状况](SECURITY.md#security-posture)
- 从源码构建和测试：先运行 `npm ci && npm --prefix clients/web ci && npm --prefix clients/mobile ci`，再运行 `make build && make test`（Rust 1.88+）。改动合入前要检查什么，见[开发验证](docs/runbooks/development-validation.md)
- [更新日志](CHANGELOG.md)和[贡献指南](CONTRIBUTING.md)

## 许可证

oort 采用 [Apache-2.0](LICENSE)（[NOTICE](NOTICE)）许可。贡献遵循 Developer Certificate of Origin，没有 CLA（[CONTRIBUTING.md](CONTRIBUTING.md)），我们遵循 [Contributor Covenant](CODE_OF_CONDUCT.md)。依赖项的归属说明在 [`legal/THIRD_PARTY_NOTICES.md`](legal/THIRD_PARTY_NOTICES.md)。

<sub>仓库沿用工作代号 <b>momo</b>，产品名是 oort。</sub>
