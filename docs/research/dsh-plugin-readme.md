# 研究：DSH 外掛 README 的最佳實踐

日期：2026-10-03。問題：`dsh-opencode-free` 的 `README.md`／`README.zh-TW.md` 要符合哪些 DSH 套件慣例？

來源都是 `deepseek-ai/deepseek-harness` 的 `master` 分支（會變動，不是凍結的規格）；社群來源另列並標明。對照的是本 repo 目前的 README，沒有改動任何檔案。

## 一手來源說了什麼

### 1. 外掛的分發與安裝（[publish.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)）

- 外掛以 **bundle** 分發：`package.json` 宣告 `dsh.bundle.patch`；使用者用 `dsh plugin --profile <name> add <spec>` 安裝，`--dump-config` 會出現 `# == <套件名>` 層，`dsh plugin --profile <name> remove <套件名>` 同時移除依賴與層。
- 要和 host 共用實例的 dsh 套件，宣告在 `peerDependencies` **與** `devDependencies`。
- 從 git 安裝只拿到原始碼，需要 `prepare` 建置與使用者在 `pnpm-workspace.yaml` 加 `allowBuilds`；若不想要求這個授權，就發布到 npm（`lib/` 在 publish 時建好）或提供 `pnpm pack` 的 tarball。

### 2. 生態系可發現性（[DSH README](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md)）

- 「Add the `dsh-plugin` topic to your plugin repository for discoverability.」
- 官方 README 把使用者導向 [SAFETY.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md)：外掛屬第三方程式碼，「Review plugins, configuration, and proposed commands before allowing them to run.」

### 3. 套件 README 的職責與結構（[docs/AGENTS.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/AGENTS.md)、[cookbook/adding-a-package.md §4](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-a-package.md#4-write-the-package-readme)）

- Package README 的工作是「per-package contract: config, semantics, limitations, extension points, and Model Experience」；不放 JSDoc 重述、生成目錄的重述、其他套件的事。
- README 結尾的標準順序：`## Model Experience`（每個進入模型上下文的項目一個 H3，底下依序 `What the model sees`、`Token effect`、`KV Cache effect`），再接 `## Known Limitations and Deferred Work`。沒有上下文影響的套件用一句 `None, as …` 或 `Indirectly, through …`。
- 這是**官方 monorepo 內** `@deepseek-ai/dsh-*` 套件的規則，由 `verify-package-readme-*` 腳本強制；對外部外掛沒有強制力，屬可借鏡的慣例。
- 寫作規則（同樣是官方 repo 的規則）：只寫現況，歷史放 commit／ADR／postmortem；一事一處、其他地方連結；避免強調膨脹與段落牆；Markdown 一段一實體行（`verify-md-wrap`）。

### 4. 外掛管理介面讀什麼（[cookbook §5](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-a-package.md#plugin-display-metadata)、[dsh-plugin-manager README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/plugin-manager/README.md)）

- 選用的顯示資訊：`locale/en.json`（及 `zh.json` 等）的 `meta.title`／`meta.description`，`package.json` 要 export `./locale/*.json` 並放進 `files`；可另加 `icon`（SVG/PNG/JPEG/WebP，≤256 KiB）。缺少時標題退回 `package.json.name`，描述退回 `package.json.description`。
- Install 畫面用 `pnpm view` 的 npm 資訊（不讀 locale）；所以 `package.json` 的 `description` 就是使用者安裝前看到的文字。
- 這一項改的是 `package.json` 與新檔案，不是 README。

### 社群來源（非官方，僅供參考）

- [deepseekplugin.org 的收錄要求](https://deepseekplugin.org/en/docs/submit-plugin)：README 或 repo 描述要清楚說明是 DeepSeek Harness 外掛。
- 社群市場（例如 [dsh-manager](https://github.com/KYZHXL/dsh-manager)）以 npm 搜尋 `dsh-plugin` 標籤的套件。本專案 `package.json` 的 `keywords` 已含 `dsh-plugin`。

## 對照目前的 README

| 實踐 | 來源等級 | 現況 |
| --- | --- | --- |
| repo 有 `dsh-plugin` topic | 官方 README | 已符合（`gh repo view` 確認） |
| 說明是 DSH 外掛 | 社群 | 已符合（開頭第一段） |
| `dsh plugin add/remove`、`--dump-config` 驗證 | 官方 publish.md | 已符合（Install 一節） |
| 發布 npm 預建 `lib/`，不要求 `allowBuilds` | 官方 publish.md | 已符合（npm 安裝為主路徑） |
| peer 同時列在 `devDependencies` | 官方 publish.md | **未符合**：四個 peer 沒有列在 `devDependencies`（只有 `@types/node`、`tsx`、`typescript`），開發時靠 pnpm 預設自動安裝 peer 取得；這是 `package.json` 的事，不是 README |
| 提醒第三方外掛風險、連到 DSH SAFETY.md | 官方 README/SAFETY | **部分**：有「非官方、可能失效」警告，但沒說它會改寫行程內的 `fetch`／`node:http` 與請求內容的安全意涵，也沒連 SAFETY.md（README.md 的「What it patches in your process」講了前者，但 zh-TW 沒有這一節） |
| Model Experience：模型實際看到的改動、token 與 KV cache 影響 | 官方 monorepo 慣例 | **缺**：「How it works」提到 `pwsh` 以 `bash` 名稱送出、無工具請求補「inert placeholder tools」，但沒寫 compaction 提示被換成 OpenCode 版（`swapCompactionPrompt`）、佔位工具的 token 成本、改名是否穩定 KV 前綴 |
| Known Limitations 獨立成節 | 官方 monorepo 慣例 | **缺**：限制散落在警告框、Requirements、Troubleshooting |
| 只寫現況，歷史放別處 | 官方寫作規則 | **部分**：相容性表是現況；但內文有 `measured 2026-…` 類敘述與設計理由長段（例如 Usage 的雙時鐘解釋），官方規則會把理由移到 ADR |
| 中英 README 內容對等 | 本 repo 標準 D1 | **缺**：README.md 約 3,300 英文字、有「What it patches in your process」，zh-TW 沒有對應節 |
| 一段一實體行 | 官方 repo 規則 | 不採用為宜：本 repo 是固定換行；T4 要求保留既有風格 |
| `locale/*.json` 與 icon | 官方 cookbook（選用） | 沒有；不屬 README，另案 |

## 結論

1. 本 README 已滿足所有官方對**外部外掛**明確提出的要求（topic、安裝方式、分發形式）。
2. 可借鏡、但官方只對 monorepo 內套件強制的部分，最有價值的是兩節：**Model Experience**（這個外掛會改寫模型看到的工具名稱、補佔位工具、替換 compaction 提示，使用者有理由知道）與 **Known Limitations**。
3. 本 repo 自己的標準要求中英對等（D1），目前 zh-TW 缺「What it patches in your process」。
4. 「一段一實體行」與 `locale`／icon 不建議在這次 README 更新裡做：前者違反本 repo 的 T4（保留既有風格），後者是 `package.json` 變更。

## 決定（2026-10-03）

- 採用：兩份 README 加入 Model Experience 與 Known Limitations（依官方順序放在授權之前）；zh-TW 補上「它在你的行程裡修補什麼」；警告框連到 DSH SAFETY.md 並指出行程層級的包裝。
- 這次不做：搬移設計理由到 ADR（改寫幅度大）、一段一實體行（違反 T4）、`locale/*.json`／icon 與 peer 補進 `devDependencies`（屬 `package.json` 變更，不在本次 README 範圍）。
