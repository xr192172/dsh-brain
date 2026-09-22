# vendor/deepseek-tokenizer — 来源与版本声明

> 本目录只做一件事：把 **DeepSeek 官方开源 tokenizer** 固化进仓库，供 `scripts/ds-token-count.mjs`
> **离线**计算「DeepSeek 计价口径」的 token 数。不联网、不执行、不改任何用户级配置。

## 1. 资产清单（含哈希）

| 文件 | 字节 | sha256 | 出处 |
|---|---|---|---|
| `v4-flash/tokenizer.json` | 6,367,146 | `8f9f37ca37fdc4f5fd36d5cf4d3b0e8392edb4e894fd10cc0d70b4957c8633cf` | `deepseek-ai/DeepSeek-V4-Flash` 的 `tokenizer.json` |
| `v4-flash/tokenizer_config.json` | 801 | `6ac8c8dc065ed118161d02dd532749ae3f52c243deac27872134fae2f50d8547` | 同上仓库 |
| `lib/tokenizers.mjs` | 98,937 | `1c4a848f86156201c033d6cd08c4cf81ae1088552acec3367f31ef086edf5af0` | npm `@huggingface/tokenizers@0.2.0` 的 `dist/tokenizers.mjs` |
| `lib/LICENSE` | 11,357 | `c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4` | 同上包（Apache-2.0） |

目录合计 **6,478,241 字节（≈6.2 MiB）**。无 `node_modules`、无 `package.json`、无运行期依赖。

## 2. tokenizer.json 是不是**官方**的？—— 是

`deepseek-ai/DeepSeek-V4-Flash` 是 HuggingFace 上 **DeepSeek 官方组织**（`deepseek-ai`）的仓库。

**内容身份核验**（`git blob sha1` = `sha1("blob <len>\0" + content)`，可与 HF tree API 的 `oid` 直接对拍）：

```
HF API: https://huggingface.co/api/models/deepseek-ai/DeepSeek-V4-Flash/tree/main
        →  {"path":"tokenizer.json","size":6367146,"oid":"628e3364caad11bdf9e67cea06eae7878122811d"}

本地:   git blob sha1 = 628e3364caad11bdf9e67cea06eae7878122811d   ⇒ MATCH
        bytes         = 6367146                                  ⇒ MATCH
```

- `tokenizer.json` 在该仓库是**普通 git blob（非 LFS）**，所以 `oid` 就是内容的 sha1，是可验证的内容身份。
- 下载路径（两个独立镜像，字节一致）：
  - `https://hf-mirror.com/deepseek-ai/DeepSeek-V4-Flash/resolve/main/tokenizer.json`
  - `https://www.modelscope.cn/api/v1/models/deepseek-ai/DeepSeek-V4-Flash/repo?FilePath=tokenizer.json`
- ⚠️ `huggingface.co` 直连在本机被重置（`curl: (35) Connection was reset`），故走镜像。

**重新获取（一条命令）**：
```bash
curl -L -o vendor/deepseek-tokenizer/v4-flash/tokenizer.json \
  "https://hf-mirror.com/deepseek-ai/DeepSeek-V4-Flash/resolve/main/tokenizer.json"
# 期望 sha256: 8f9f37ca37fdc4f5fd36d5cf4d3b0e8392edb4e894fd10cc0d70b4957c8633cf
```

## 3. 加载器 `lib/tokenizers.mjs` 是不是**官方**的？—— 是 HF 官方，但是**纯 JS 重写**

- 包名 `@huggingface/tokenizers@0.2.0`，仓库 `https://github.com/huggingface/tokenizers.js`，LICENSE = Apache-2.0。
- 它是 **HuggingFace 官方的 JS 实现**，但**不是** HuggingFace 的 Rust 参考实现（`tokenizers` / Python 包）。
  ⇒ 严格说是「**官方实现的分词器格式的再实现**」，**不是**官方 Rust 的同一份代码。
- 因此**必须独立验算**（见第 5 节）：已用 Python `tokenizers` 0.23.1（**Rust 参考实现**）逐样本对拍，
  8/8 完全一致（含 123,937 字符中文文档、107,777 字符 tools JSON、18,152 字符源码）。
- 该文件**零外部 import**（已 grep 确认），故可直接 `import()`，不需要 `node_modules`。

## 4. ★ 为什么选 V4-Flash？以及「选哪个 DeepSeek」这件事为何不影响结果

HF `deepseek-ai` 下有多个不同版本的 `tokenizer.json`（都是**普通 git blob**）：

| 仓库 | tokenizer.json 字节 | git blob sha1 |
|---|---|---|
| `DeepSeek-V3` | 7,847,652 | `51083c600ec00c7f57ae1af7fef7108c52ce7376` |
| `DeepSeek-V3-0324` | 7,847,652 | `51083c600ec00c7f57ae1af7fef7108c52ce7376`（同 V3） |
| `DeepSeek-V3.2` | 7,847,502 | `9b4d31974a7e15e519ca5425ff2245a889779cf8` |
| `DeepSeek-R1` | 7,847,602 | `d81c3a6e2093a07ae6fa596d9b154f6669aafafd` |
| **`DeepSeek-V4-Flash`** | **6,367,146** | **`628e3364caad11bdf9e67cea06eae7878122811d`** ← 本目录固化 |
| `DeepSeek-V4-Flash-0731` / `DeepSeek-V4-Pro` / `DeepSeek-V4-Pro-Base` / `DeepSeek-V4-Flash-DSpark` | 6,367,146 | `628e3364caad11bdf9e67cea06eae7878122811d`（全部同 V4-Flash） |
| `DeepSeek-V4.1-Flash` | 6,367,257 | `6a15814dd25c934028034531da744c689f87ff21` |

★ **V3 与 V4-Flash 的差异已逐字段核验**：

| 字段 | V3 vs V4-Flash |
|---|---|
| `model.vocab`（128,000 项） | **deep-equal** |
| `model.merges`（127,741 项） | **deep-equal** |
| `pre_tokenizer` / `normalizer` / `post_processor` / `decoder` | **全部 deep-equal** |
| `added_tokens` | 818 → **1,283**（V4 **只增不减**，多出 465 个，全部是特殊标记：`<\|place_holder_mm_span_XXXX\|>`、`<｜image｜>`、`<｜table｜>`、`<｜box｜>` …） |

⇒ **对普通提示词文本，V3 与 V4-Flash 计数完全相同**（5 个样例 0% 偏差）。
⇒ 所以「到底该按 V3 还是 V4 口径」这件事，**不影响日常计数结果**；只有文本里真的出现上述特殊标记时才会有差别。
⇒ 默认取 **V4-Flash**（会话日志里 `model` 字段写的就是 `deepseek-v4-flash`）。
   为省 7.5 MiB 仓库体积，**未固化 V3**；需要时按上表 URL + blob sha1 一键重取即可。

## 5. ★★ 这个 tokenizer 代表**什么** —— 以及它**不代表什么**

★ **它代表**：DeepSeek **官方**分词器的**计价参考口径**。

★ **它不代表**「这次请求实际用的那个模型的分词器」。据 `docs/skill-as-agent-spec.md` §46（他人本任务前已查证）
与本目录的独立复核：
- `~/.dsh/profiles/exp-base/node_modules/@dsh-brain/key-pool-proxy/cordis.patch.yml`
  → `upstreamBase: https://apihub.agnes-ai.com`（实链路走 **AGNES**）
- `~/.dsh/profiles/exp-base/cordis.patch.yml:5-8`
  → `agent-default-model: {provider: agnes, model: agnes-2.5-flash}`（**profile 层把默认模型覆盖成 AGNES**）
- `~/.dsh/settings.yaml` 里**唯一**定义的 provider 是 `agnes`（`baseURL: http://127.0.0.1:3101/v1`），
  而 `agent-default-model` 仍写着 `provider: deepseek-official, model: deepseek-v4-flash` ⇒ **陈旧标签**。

⇒ 所以会话日志里的 `provider: deepseek-official / model: deepseek-v4-flash` 是**标签，不是实物**。
⇒ 用 DeepSeek tokenizer 计数，得到的是「**如果这是 DeepSeek 模型，按 DeepSeek 计价会算多少 token**」，
   **不是** provider 实际计费的 token 数。两者实测差 **+10% ~ +18%**（见 `out/w30-ds-tokenizer.md`）。

★ **风险标注**：
- 本 tokenizer 是**官方**的（非近似）✅
- 但它与**实际推理模型**（AGNES）的分词器**大概率不同** ⚠️
  ⇒ **不可**拿它去核对/反推 provider 的 `usage`；**不可**把两套数字混在同一张成本表里。
