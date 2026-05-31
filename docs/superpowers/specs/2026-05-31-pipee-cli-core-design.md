# Pipee CLI 核心 — 設計文件

**日期**: 2026-05-31
**狀態**: 已核准設計,待寫實作計畫
**範圍**: 三層系統的第一層(CLI / SDK 核心)

---

## 背景與目標

Pipee 是自架的靜態網站托管平台。目前已具備:JWT 認證、site(slug)、ZIP 上傳部署 API、git push 部署、GitHub webhook 自動部署、伺服器端 AI 編輯器(在 server 上 spawn Claude Code CLI 編輯已部署的站)。

本專案要補的是**反方向**:當 user 在自己電腦用 Claude Code 做網站時,讓 Claude(或 user)能從本地直接把站部署到 Pipee。

整體是分層系統,三個獨立交付物,**一次只 spec 一個,從底層開始**:

| 層 | 交付物 | 內容 | 相依 |
|---|---|---|---|
| **① CLI / SDK 核心**(本文件) | npm 套件 `pipee` | `pipee login` + `pipee deploy`,以及可被程式呼叫的 `deploy()` SDK | 只依賴現有 Pipee API,**零伺服器改動** |
| **② Skill**(之後) | Claude Code skill `deploy-pipee` | 教 Claude 做出 Pipee 能直接上的靜態站,完成時呼叫 `npx pipee deploy` | 依賴 ① |
| **③ MCP**(選做/最後) | Pipee MCP server | 把 deploy 包成 `deploy_site` 工具 | 依賴 ① |

② 與 ③ 都是 ① 的薄包裝,故先把 ① 做穩。本文件只規範 ①。

---

## 設計決策(已與使用者確認)

- 部署入口分層,**CLI 為核心**,Skill / MCP 是薄層。
- 部署傳輸用 **ZIP 上傳 API**(現有 `POST /api/user/sites/:slug/deploy`),零伺服器改動。
- 認證用 **`pipee login` 互動登入**,token 存本地。
- Skill 的範圍是「**規範 + 部署**」(下一個專案才做)。
- 套件名 `pipee`(若 npm 被占則 `@pipee/cli`)。
- `pipee deploy` 在 slug 不存在時**自動建站**。
- CLI 核心**不含 `init` 腳手架**(腳手架屬於 Skill)。

---

## 依賴的現有 API(已驗證)

- `POST /api/auth/login` `{ username, password }` → 回傳含 JWT `token`。
- `POST /api/user/sites` `{ slug }`,帶 `Authorization: Bearer <token>`
  - `201` 建立成功;`409 SLUG_TAKEN` 表示已存在;`402 QUOTA_EXCEEDED` 達方案上限。
- `POST /api/user/sites/:slug/deploy`,帶 Bearer token
  - **body = 原始 ZIP bytes**(非 multipart)。
  - 伺服器驗證:必須含根目錄 `index.html`;ZIP 與解壓後皆 ≤ 50MB;檔數上限;禁止特定副檔名。
  - 成功回 `{ url, slug, size }`。
  - 錯誤碼:`401 UNAUTHORIZED`、`403 FORBIDDEN`、`413 ARCHIVE_TOO_LARGE`、`400 NO_INDEX_HTML`、`400 TOO_MANY_FILES`、`400 FORBIDDEN_FILE`。

---

## 指令介面

```bash
pipee login                    # 互動登入,存 token
pipee deploy [folder]          # 部署資料夾(預設當前目錄)
pipee whoami                   # 顯示登入身分 + server
pipee logout                   # 清除本地憑證
```

`pipee deploy` 旗標:
- `--slug <name>` — 覆寫 slug
- `--dir <path>` — 指定資料夾(等同位置參數)
- `--yes` — 跳過互動確認(給 Skill / CI 用)

---

## 設定 / 憑證儲存

- **全域憑證** → `~/.pipee/config.json`,檔案權限 `0600`:
  ```json
  { "serverUrl": "http://localhost:3939", "token": "<jwt>", "username": "jeff" }
  ```
- **專案綁定** → 部署資料夾(或其上層)的 `pipee.json`:
  ```json
  { "slug": "my-blog" }
  ```
  CLI 從這裡讀 slug,同專案重複部署免再輸入。第一次部署若無 `pipee.json` 就互動詢問 slug 並寫回。

---

## 流程

### `pipee login`

1. 問 server URL(預設 `http://localhost:3939`,記住上次值)。
2. 問 username / password(password 隱藏輸入)。
3. `POST /api/auth/login` → 取得 token。
4. 寫入 `~/.pipee/config.json`(`0600`)。
5. 印 `✓ Logged in as <username> @ <serverUrl>`。

### `pipee deploy`(核心)

1. 載入 `~/.pipee/config.json`;無 token → 提示先 `pipee login` 並結束。
2. 決定 slug:`--slug` > `pipee.json` > 互動詢問(並寫回 `pipee.json`)。
3. 本地檢查:目標資料夾存在,且根目錄含 `index.html`(沒有就直接報錯,不上傳)。
4. 確保 site 存在:`POST /api/user/sites { slug }`
   - `201` 建立成功;`409 SLUG_TAKEN` 視為已存在(若屬別人,步驟 6 deploy 會回 403 擋下)。
5. 打包:資料夾壓成 ZIP buffer,`index.html` 在根;**排除** `.git/`、`node_modules/`、`pipee.json`。
6. 上傳:`POST /api/user/sites/:slug/deploy`,body = ZIP bytes,帶 Bearer token。
7. 印回傳的 live URL:`✓ Deployed → <url>`。

### `pipee whoami` / `pipee logout`

- `whoami`:讀 config 印 username + serverUrl;未登入則提示。
- `logout`:刪除 `~/.pipee/config.json` 的 token(或整檔)。

---

## 錯誤處理

| 情況 / API 回應 | CLI 訊息 |
|---|---|
| 無本地 token | `尚未登入,請先執行 pipee login` |
| 401 UNAUTHORIZED | `Token 失效,請重新 pipee login` |
| 402 QUOTA_EXCEEDED | `已達方案網站上限,請升級或刪站` |
| 403 FORBIDDEN | `這個 slug 屬於別的帳號` |
| 413 ARCHIVE_TOO_LARGE | `網站超過 50MB 上限` |
| 400 NO_INDEX_HTML | `根目錄缺少 index.html`(步驟 3 通常已先擋) |
| 400 TOO_MANY_FILES / FORBIDDEN_FILE | 直接轉述 server 訊息 |
| 連線失敗(ECONNREFUSED 等) | `連不上 <serverUrl>,確認 server 有開` |

所有錯誤以非零 exit code 結束,訊息寫 stderr,方便 Skill / CI 判斷。

---

## 套件結構

遵守 small-files、immutability、無 console.log(用統一輸出模組)風格:

```
pipee-cli/
  bin/pipee.js          # 進入點,解析 argv 並分派
  src/config.js         # 讀寫 ~/.pipee/config.json 與 pipee.json
  src/api.js            # fetch 包裝:login / createSite / deploy
  src/zip.js            # 打包資料夾成 ZIP buffer(含排除規則)
  src/output.js         # 統一 stdout/stderr 輸出(取代 console.log)
  src/commands/login.js
  src/commands/deploy.js
  src/commands/whoami.js
  src/commands/logout.js
  src/sdk.js            # 匯出 { login, deploy } 供 Skill / MCP 重用
```

- 依賴極簡:`adm-zip`(打包,與 server 同套)、`prompts`(互動輸入)。
- HTTP 用 Node 18 內建 `fetch`,不加 axios。
- `package.json`:`"bin": { "pipee": "bin/pipee.js" }`,`"engines": { "node": ">=18" }`。

---

## SDK 重用面

`src/sdk.js` 匯出純函式:

```js
async function deploy({ dir, slug, serverUrl, token }) { /* 回傳 { url, slug, size } */ }
async function login({ serverUrl, username, password }) { /* 回傳 { token, username } */ }
```

CLI 指令與未來的 Skill / MCP 都呼叫同一份 `deploy()`,部署邏輯只有一處。指令層只負責互動、讀設定、印訊息;SDK 層不碰 stdin/stdout。

---

## 測試策略(目標 80%+ 覆蓋)

- **單元**
  - `zip.js`:打包含/排除規則(`.git`、`node_modules`、`pipee.json` 不入包;`index.html` 在根)。
  - `config.js`:讀寫、檔案權限 `0600`、缺檔處理。
  - `api.js`:mock `fetch`,涵蓋 200 / 401 / 402 / 403 / 409 / 413 各狀態碼。
  - `sdk.deploy`:slug 不存在→自動建站→上傳的串接(mock api)。
- **整合**:對本地跑的 Pipee 真的 `login` → `deploy` 一個 fixture 站,assert 回傳 URL `GET` 得 200。
- **E2E(選)**:`npx pipee deploy` 對 fixture 站跑全流程。

---

## YAGNI / 不做的事

- 不做 `init` 腳手架(屬 Skill 層)。
- 不做 git push 管道(本層只 ZIP)。
- 不做 API token 管理(用 `login` 拿 JWT 即可)。
- 不做多帳號 profile 切換(單一 config 足夠;未來需要再加)。

---

## 後續層(本文件不實作,僅備忘)

- **② Skill `deploy-pipee`**:SKILL.md 教 Claude 做 Pipee 相容靜態站(單資料夾、`index.html`、相對路徑、不依賴 build step),完成時呼叫 `npx pipee deploy --yes`。
- **③ MCP server**:把 `sdk.deploy` 暴露成 `deploy_site` 工具。
