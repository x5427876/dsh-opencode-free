# dsh-opencode-free

[![npm version](https://img.shields.io/npm/v/dsh-opencode-free.svg)](https://www.npmjs.com/package/dsh-opencode-free)
[![npm downloads](https://img.shields.io/npm/dw/dsh-opencode-free.svg)](https://www.npmjs.com/package/dsh-opencode-free)
[![CI](https://github.com/x5427876/dsh-opencode-free/actions/workflows/ci.yml/badge.svg)](https://github.com/x5427876/dsh-opencode-free/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/dsh-opencode-free.svg)](LICENSE)

[English](README.en.md) | 中文

讓 DeepSeek Harness 直接使用 OpenCode Zen 的免費模型，不需要安裝 OpenCode。插件預設使用匿名免費額度，也可從 `OPENCODE_API_KEY` 讀取 Zen API key。

[npm 套件](https://www.npmjs.com/package/dsh-opencode-free) | [GitHub 原始碼](https://github.com/x5427876/dsh-opencode-free) | [問題回報](https://github.com/x5427876/dsh-opencode-free/issues)

> OpenCode Zen 的免費模型可能有用量限制、限時供應或資料使用條款。請勿傳送機密資料，並先閱讀 [OpenCode Zen 隱私說明](https://opencode.ai/docs/zen#privacy)。

## 快速開始

不需要 API key。直接安裝到指定 profile：

```sh
dsh plugin --profile web add dsh-opencode-free@0.1.1
```

插件會加入 `opencode-zen-free` provider。從模型選單選擇任一免費模型即可使用。

## 免費模型

目前 catalog 包含：

| 模型 | Model ID | 輸入 |
|---|---|---|
| Big Pickle | `big-pickle` | 文字 |
| Ling 3.0 Flash Fin Free | `ling-3.0-flash-fin-free` | 文字 |
| MiMo V2.5 Free | `mimo-v2.5-free` | 文字、圖片 |
| Nemotron 3 Ultra Free | `nemotron-3-ultra-free` | 文字 |
| Nemotron 3.5 Lightning Free | `nemotron-3.5-lightning-free` | 文字 |
| Muse Spark 1.2 Free | `muse-spark-1.2-contributor-free` | 文字、圖片 |
| Muse Spark 1.3 Free | `muse-spark-1.3-contributor-free` | 文字、圖片 |

預設清單來自已安裝的 `pi-ai` catalog，只顯示成本為零的模型。OpenCode 可能隨時調整供應項目。

## 相容版本

支援 DeepSeek Harness `0.1.7-alpha.1`。

## 設定

若要使用自己的 Zen API key：

```sh
export OPENCODE_API_KEY='your-key'
```

也可直接掛載插件並覆寫設定：

```yaml
- id: opencode-free
  name: dsh-opencode-free
  config:
    apiKeyEnv: OPENCODE_API_KEY
    baseURL: https://opencode.ai/zen/v1
    retryPolicy:
      mode: normal
      maxRetries: 2
```

支援的設定：

| 欄位 | 預設值 | 用途 |
|---|---|---|
| `apiKeyEnv` | `OPENCODE_API_KEY` | Zen API key 的 credential reference |
| `baseURL` | `https://opencode.ai/zen/v1` | Zen API endpoint |
| `reasoning` | Muse Spark 使用 `xhigh` | 預設推理等級 |
| `maxTokens` | 未設定 | 單次輸出上限 |
| `timeoutMs` | `180000` | 請求逾時 |
| `streamIdleTimeoutMs` | `300000` | 串流閒置逾時 |
| `models` | 免費 catalog | 明確指定可用 model ID |

## 開發

```sh
pnpm install
pnpm run check
pnpm pack --dry-run
```

## 授權

[MIT](LICENSE)
