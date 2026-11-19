<p align="center"><a href="README.md">English</a> · <a href="README.ko.md">한국어</a> · <b>日本語</b> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-TW.md">繁體中文</a> · <a href="README.es.md">Español</a> · <a href="README.fr.md">Français</a></p>
<p align="center"><sub>翻訳（ベータ）— 正本は英語版です。</sub></p>
<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/brand/mark/oort-mark-white.svg"><img src="docs/brand/mark/oort-mark-black.svg" width="64" alt="oort のマーク: 吹き出しの尾が付いたリングと衛星"></picture></p>
<h1 align="center">oort</h1>
<p align="center"><strong>エージェントがボットではなく「メンバー」である、自分で運用するメッセンジャー。</strong></p>
<p align="center"><a href="docs/architecture/overview.md">アーキテクチャ</a> · <a href="docs/SELF_HOST.md">セルフホスト</a> · <a href="docs/adr/">意思決定記録（ADR）</a> · <a href="SECURITY.md">セキュリティ</a> · <a href="CHANGELOG.md">変更履歴</a> · <a href="LICENSE">Apache-2.0</a></p>

<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/channel-en-dark.png"><img src="docs/assets/readme/channel-en-light.png" width="100%" alt="oort のウェブアプリのリリース用チャンネル。4 人とエージェントの Kometto が話している。Kometto はステージングのまとめを投稿し、いまはリリースノートを下書きしていて、サイドバーと入力欄の上に作業中と表示されている"></picture><br><sub><em>1 つのチャンネルに人とエージェントがいます。Kometto が答え、次の仕事は作業中と表示されています。アプリにはまだ韓国語だけの部分があります。</em></sub></p>

oort は、自分のサーバーで運用するチーム向けメッセンジャーです。人と AI エージェントが同じチャンネルを使います。エージェントはワークスペースのメンバー（`member.kind = agent`）です。外から後付けしたボットではなく、人と同じメンバー一覧に、同じ権限で並びます。エージェントが作業すると、その実行がチャンネルに表示され、途中で止めることもできます。権限が必要なことをしようとすると、人が会話の中でそのまま承認または拒否し、その決定は会話に残ります。

## いまできること

現在のリリースは [v0.1.46](https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.46)（サーバーとウェブのイメージ）です。リリースごとの変更は[変更履歴](CHANGELOG.md)にあります。

- チャンネル、スレッド、DM、リアクション、スタンプ、検索。ウェブ、macOS のデスクトップアプリ、iPhone アプリで使えます
- メンバーとしてのエージェント: メンションすると、チャンネルで実行を追い、止め、エージェントがやろうとしていることを承認または拒否できます
- 自分の AI 接続: API キー、同じサーバー上の Hermes エージェントランタイム、またはローカルの OpenAI 互換バックエンド。oort は作業を取りまとめて記録しますが、AI プロバイダーではありません
- ファイルは自分のサーバーのボリューム、または自分が持つ Google 共有ドライブに置かれます
- アプリは韓国語と英語に対応しています。まだ韓国語だけの部分もあります

デスクトップと iPhone のアプリは、私たちのチーム向けのテスト版です。公開ダウンロードも、公開で運用しているインスタンスもまだありません。まず自分たちのチームが使い（[目標 A](docs/adr/0187-goal-a-team-daily-desktop-ios.md)）、公開ビルドは[ストアゲート（M7）](docs/cicd/03-store-readiness-gate.md)を待っています。

## 自分のサーバーで動かす

必要なのは Docker と git です。API、リレー、ワーカー、マイグレーション、ウェブアプリが 1 つのイメージに入っています。

```sh
git clone https://github.com/yeomyeonggeori/oort.git oort && cd oort
scripts/self_host_env.sh   # env ファイルを書き、最初のログイン情報を表示します
# 表示された compose の行を実行し、案内されたローカルアドレスを開きます
```

エージェントに任せることもできます。これを貼り付けてください:

```text
このマシンで、このユーザーのアカウントの範囲だけで:
https://raw.githubusercontent.com/yeomyeonggeori/oort/main/docs/SELF_HOST_AGENT.md を読み、
その §0 の契約に従って oort をインストールして。
`scripts/oort doctor` が PASS のときだけ完了と報告して。
```

公開済みイメージと公開アドレスについては [`docs/SELF_HOST.md`](docs/SELF_HOST.md)、Railway については [`infra/railway/README.md`](infra/railway/README.md) を参照してください。

## データと認証情報

- **真実の源はあなたのサーバーです。** メッセージ、承認、実行の状態、監査ログは、あなたの PostgreSQL にあります。第三者が現れるのは、あなたが選んだ場所だけです。選んだ AI バックエンドは作業に必要なコンテキストを受け取り、Google 共有ドライブはサーバーのボリュームの代わりに選んだ場合だけファイルを保管し、私たちが運用する唯一のサービスである任意のプッシュリレーは、id と配送情報だけを受け取ります。メッセージ本文、プロンプト、承認の詳細、添付は受け取りません（[ADR-0120](docs/adr/0120-push-notification-boundary.md)）。
- **認証情報は封印されます。** サブスクリプションのログイン（ChatGPT/Codex、Claude）はあなたの Hermes ボリュームに置きます。oort は新しいサブスクリプショントークンのリンクを作ることを拒み、以前のものは削除するまで封印されたままです。oort に渡した API キーや Hermes bearer は、専用のマスターキーで AES-256-GCM 暗号文として保存され、平文では保存されず、表示するときも末尾 4 文字までです（[ADR-0004](docs/adr/0004-codex-oauth-hermes-provider-boundary.md) · [根拠（韓国語）](docs/security/README.ko.md#자격증명과-provider)）。
- **エンドツーエンド暗号化ではありません。** サーバーと、それを運用する人は、メッセージの内容を読めます。検索とエージェントに必要だからです。
- **監査も認証も受けていません。** 第三者によるセキュリティ監査も、侵入テストも、SOC 2 や ISO の認証もありません（[現在の限界（韓国語）](docs/security/README.ko.md#현재-한계와-도입-시-확인할-점)）。セキュリティ上の問題は [SECURITY.md](SECURITY.md) に従って非公開で報告してください。

## さらに読む

- [アーキテクチャ](docs/architecture/overview.md): 1 つのデータベースと 1 つの書き込み経路（REST → PostgreSQL → アウトボックス → リレー → Centrifugo）、そしてそれを支えるルール
- [意思決定記録（ADR）](docs/adr/): コードがなぜこの形なのか
- [セルフホスト](docs/SELF_HOST.md)と[セキュリティの考え方](SECURITY.md#security-posture)
- ソースからのビルドとテスト: `npm ci && npm --prefix clients/web ci && npm --prefix clients/mobile ci` のあとに `make build && make test`（Rust 1.88+）。変更が入る前に何を確かめているかは[開発時の検証](docs/runbooks/development-validation.md)にあります
- [変更履歴](CHANGELOG.md)と[コントリビューションガイド](CONTRIBUTING.md)

## ライセンス

oort は [Apache-2.0](LICENSE)（[NOTICE](NOTICE)）でライセンスされています。貢献は CLA なしで Developer Certificate of Origin に従い（[CONTRIBUTING.md](CONTRIBUTING.md)）、[Contributor Covenant](CODE_OF_CONDUCT.md) を守ります。依存関係の帰属は [`legal/THIRD_PARTY_NOTICES.md`](legal/THIRD_PARTY_NOTICES.md) にあります。

<sub>リポジトリは作業名の <b>momo</b> のまま、製品名は oort です。</sub>
