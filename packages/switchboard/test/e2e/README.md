# 预演体检 · 端到端复现（判据 1/2/5/6 + command 两向的证据生成器）

子系统说明见 [`../../docs/preflight.md`](../../docs/preflight.md)。

| 文件 | 作用 |
|---|---|
| `fixtures/good-plugin.mjs` | 正样本：合法插件，注册工具 `b2_probe_tool`（验 **tool** 分支） |
| `fixtures/cmd-plugin.mjs` | 正样本：合法插件，注册 host 命令 `preflight_probe_cmd`（验 **command** 分支） |
| `fixtures/bad-throws.mjs` | 坏样本①：模块装载期抛错 |
| `fixtures/bad-missing-dep.mjs` | 坏样本②：import 一个不存在的包 |
| `fixtures/silent-plugin.mjs` | 坏样本③/④：合法但**什么也不注册**（配对"声明了不存在的端点"） |
| `run-preflight-e2e.sh` | 生成 overlay + 跑 8 个场景 + 落盘原始报告 + 自检 |
| `summarize.mjs` | 把报告/清点结果打成可贴进报告的形状 |

## 跑法

```bash
# 1) 先起一个跑本包代码的控制面实例（见 docs/preflight.md §9；它的前置脚本**不替你满足**）
# 2) 再跑：
bash packages/switchboard/test/e2e/run-preflight-e2e.sh
```

环境变量（★ 全部可覆盖）：`PREFLIGHT_ADMIN`（默认 `http://127.0.0.1:31800` = 主仓控制面
admin 缺省口）、`PREFLIGHT_PROFILE`（默认 `web` = 主仓缺省 profile）、
`PREFLIGHT_DSH_HOME`（默认 `$HOME/.dsh`，用于自检 `profiles/<name>` 是否存在）、
`PREFLIGHT_OUT`（证据目录，默认 `<repo>/out/preflight-evidence`）。

★ 脚本先做**前置自检**：admin 无应答 / 没有 `?cmd=preflight-result` 通道 / profile 目录不存在，
三者任一 ⇒ **明确报错 + 打印用法并 exit 2**（不静默 `exit 0`）。要指向一个另起的实例
（例如与现役并行的那一份），用环境变量覆盖即可：

```bash
PREFLIGHT_ADMIN=http://127.0.0.1:31902 PREFLIGHT_PROFILE=rehearsal-r \
PREFLIGHT_DSH_HOME=/abs/isolated-dsh-home \
  bash packages/switchboard/test/e2e/run-preflight-e2e.sh
```

## 期望结果（逐场景）

| 场景 | 期望 | 抓它的体检项 |
|---|---|---|
| `A-positive` | **pass** | 全部绿（含新插件 `b2-good` 与它的工具 `b2_probe_tool`） |
| `A0-negctl` | reject | `tool`（声明了没装的东西 ⇒ 模型面工具表里没有） |
| `B-bad-throws` | reject | `boot` fatal（整棵树装载失败）+ `inventory` 不可达 |
| `C-bad-missing-dep` | reject | 同上 |
| `D-bad-ghost` | reject | 同上（声明的模块路径不存在） |
| `E-silent` | reject | **`tool`**（插件 `phase=active`、boot healthy，但它声明的工具没进模型面工具表） |
| `H-cmd-positive` | **pass** | `command`（插件注册的 `preflight_probe_cmd` 出现在命令注册表里） |
| `I-cmd-negative` | reject | **`command`**（同一个插件在跑，但声明了它没注册的 `preflight_ghost_cmd`） |

`E-silent` 是这条子系统存在的理由：**配置视角下它完全正常。**

`H-cmd-positive` / `I-cmd-negative` 是 `command` 判据的**两向**证据：契约里 `command` 是与
`tool` 平级的一等分支，只测"坏的被拒"会漏掉"正的根本没被测"，反之会漏掉"坏的没被拦"。
脚本自检**两向各查一条具体的 `command` 项**（不是只看总 verdict）。

## ★ 为什么 overlay 里写 `file://` URL

dsh 整机 boot 路径把 loader 条目的 `name` 直接交给其内部 ESM loader，**不做 `pathToFileURL`**
⇒ 写绝对 Windows 路径会得到
`ERR_UNSUPPORTED_ESM_URL_SCHEME: ... Received protocol 'c:'`（实测，见报告"踩过的坑"）。
脚本因此即时把 fixture 的绝对路径写成 `file:///…` 形式，而不是把本机路径硬编码进仓库文件。
