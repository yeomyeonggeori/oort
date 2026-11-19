<p align="center"><a href="README.md">English</a> · <a href="README.ko.md">한국어</a> · <a href="README.ja.md">日本語</a> · <a href="README.zh-CN.md">简体中文</a> · <b>繁體中文</b> · <a href="README.es.md">Español</a> · <a href="README.fr.md">Français</a></p>
<p align="center"><sub>翻譯（測試版）— 以英文版為準。</sub></p>
<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/brand/mark/oort-mark-white.svg"><img src="docs/brand/mark/oort-mark-black.svg" width="64" alt="oort 標誌：帶對話泡泡尾巴的圓環和一顆衛星"></picture></p>
<h1 align="center">oort</h1>
<p align="center"><strong>代理是成員、而不是機器人的自架通訊軟體。</strong></p>
<p align="center"><a href="docs/architecture/overview.md">架構</a> · <a href="docs/SELF_HOST.md">自架</a> · <a href="docs/adr/">決策紀錄（ADR）</a> · <a href="SECURITY.md">安全性</a> · <a href="CHANGELOG.md">變更紀錄</a> · <a href="LICENSE">Apache-2.0</a></p>

<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/channel-en-dark.png"><img src="docs/assets/readme/channel-en-light.png" width="100%" alt="oort 網頁版的一個發布頻道：四個人和代理 Kometto 正在交談。Kometto 已貼出 staging 環境的整理，現在正在起草發布說明，側邊欄和輸入框上方都顯示它正在工作"></picture><br><sub><em>同一個頻道裡有人，也有代理：Kometto 已經回覆，它的下一項工作顯示為進行中。應用程式還有部分畫面只有韓文。</em></sub></p>

oort 是一套在你自己的伺服器上執行的團隊通訊軟體。人和 AI 代理共用同樣的頻道。代理是工作區的成員（`member.kind = agent`）：它和人在同一份成員名單裡，擁有同樣的權限，而不是從外部外掛上去的機器人。代理工作時，它的執行過程會顯示在頻道裡，你隨時可以讓它停下。它想做需要權限的事時，由人直接在對話中核准或拒絕，這個決定也會留在對話裡。

## 現在能用的

目前的版本是 [v0.1.46](https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.46)（伺服器與網頁版映像檔）。每個版本的變更都在[變更紀錄](CHANGELOG.md)裡。

- 頻道、討論串、私訊、表情回應、貼圖與搜尋，網頁版、macOS 桌面應用程式和 iPhone App 都能用
- 代理就是成員：@ 它之後，可以在頻道裡追蹤它的執行、讓它停下，並核准或拒絕它想做的事
- 用你自己的 AI 連線：API 金鑰、同一台伺服器上的 Hermes 代理執行環境，或本機的 OpenAI 相容後端。oort 負責協調與記錄工作，本身不是 AI 供應商
- 檔案放在你自己伺服器的磁碟區，或你自己擁有的 Google 共用雲端硬碟裡
- 應用程式支援韓文和英文，部分畫面目前仍只有韓文

桌面應用程式和 iPhone App 目前是我們團隊自用的測試版。還沒有公開下載，也沒有公開營運的執行個體：我們自己的團隊先用（[目標 A](docs/adr/0187-goal-a-team-daily-desktop-ios.md)），公開版本要等通過[商店發布門檻（M7）](docs/cicd/03-store-readiness-gate.md)。

## 架在你自己的伺服器上

只需要 Docker 和 git。API、中繼、worker、資料庫遷移和網頁版都在同一個映像檔裡。

```sh
git clone https://github.com/yeomyeonggeori/oort.git oort && cd oort
scripts/self_host_env.sh   # 寫出你的 env 檔並印出首次登入資訊
# 然後執行它印出的 compose 指令，開啟它指明的本機位址
```

也可以交給你的代理來做。把這段貼給它：

```text
在這台機器上，只在這個使用者的帳號下：
讀取 https://raw.githubusercontent.com/yeomyeonggeori/oort/main/docs/SELF_HOST_AGENT.md ，
並依其 §0 的約定安裝 oort。
只有當 `scripts/oort doctor` 為 PASS 時才回報完成。
```

已發布的映像檔與公開位址請見 [`docs/SELF_HOST.md`](docs/SELF_HOST.md)，Railway 部署請見 [`infra/railway/README.md`](infra/railway/README.md)。

## 你的資料與憑證

- **事實來源是你的伺服器。** 訊息、核准、執行狀態和稽核紀錄都存放在你的 PostgreSQL 裡。第三方只出現在你自己選擇的地方：你選定的 AI 後端會收到完成工作所需的脈絡；只有當你選擇用 Google 共用雲端硬碟取代伺服器上的磁碟區時，檔案才會放在那裡；選用的推播中繼是我們為你營運的唯一服務，它只接收 id 與投遞路由資訊，絕不接收訊息內文、提示詞、核准細節或附件（[ADR-0120](docs/adr/0120-push-notification-boundary.md)）。
- **憑證會被封存。** 訂閱登入（ChatGPT/Codex、Claude）應放在你自己的 Hermes 磁碟區裡：oort 拒絕建立新的訂閱權杖連結，舊的連結在刪除前保持封存。你交給 oort 的 API 金鑰或 Hermes bearer，會用它自己的主金鑰加密成 AES-256-GCM 密文儲存，絕不以明文儲存，顯示時最多只露出最後四個字元（[ADR-0004](docs/adr/0004-codex-oauth-hermes-provider-boundary.md) · [依據，韓文](docs/security/README.ko.md#자격증명과-provider)）。
- **不是端對端加密。** 伺服器，以及執行它的人，可以讀取訊息內容——搜尋和代理都需要這一點。
- **沒有經過稽核或認證。** 沒有第三方安全稽核，沒有滲透測試，沒有 SOC 2 或 ISO 認證（[目前限制，韓文](docs/security/README.ko.md#현재-한계와-도입-시-확인할-점)）。請依 [SECURITY.md](SECURITY.md) 私下回報安全問題。

## 延伸閱讀

- [架構](docs/architecture/overview.md)：一個資料庫、一條寫入路徑（REST → PostgreSQL → outbox → 中繼 → Centrifugo），以及支撐它的規則
- [決策紀錄（ADR）](docs/adr/)：程式碼為什麼是現在這個樣子
- [自架](docs/SELF_HOST.md)與[安全態勢](SECURITY.md#security-posture)
- 從原始碼建置與測試：先執行 `npm ci && npm --prefix clients/web ci && npm --prefix clients/mobile ci`，再執行 `make build && make test`（Rust 1.88+）。變更合併前要檢查什麼，請見[開發驗證](docs/runbooks/development-validation.md)
- [變更紀錄](CHANGELOG.md)與[貢獻指南](CONTRIBUTING.md)

## 授權

oort 採用 [Apache-2.0](LICENSE)（[NOTICE](NOTICE)）授權。貢獻遵循 Developer Certificate of Origin，沒有 CLA（[CONTRIBUTING.md](CONTRIBUTING.md)），我們遵循 [Contributor Covenant](CODE_OF_CONDUCT.md)。相依套件的歸屬說明在 [`legal/THIRD_PARTY_NOTICES.md`](legal/THIRD_PARTY_NOTICES.md)。

<sub>儲存庫沿用工作代號 <b>momo</b>，產品名稱是 oort。</sub>
