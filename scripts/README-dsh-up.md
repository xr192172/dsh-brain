# `dsh-up.cmd` —— 为什么这个文件必须「纯 ASCII + CRLF」

> 这份文档是**中文说明的家**。`dsh-up.cmd` 本体只留英文 ASCII 注释。

## 1. 它是什么

DSH 的一键启动器。用户 2026-09-25 的原话（大意）：

> 能不能把它统一成一个像桌面应用一样的东西 —— 点一下图标后端就起来了？我不是让你打包成
> Electron（太重），但至少给我**一个简单的触发器**。现在这些参数调来调去，每次都不一样，
> 显得我们很不专业。

⇒ 所以：**唯一入口** `scripts/arm-up.mjs`，`dsh-up.cmd` 只是它的壳。**不需要任何参数**，
且"启动成功"的定义是**自检全绿**。

## 2. 它为什么必须纯 ASCII —— ★★★ 一个藏了很久的间歇 bug

### 现象

同一个文件、同一条命令、同一个工作目录，**25 次里有 1 次**（≈4%）会多输出两行：

```
The system cannot find the path specified.
'll-desktop-icon.mjs' is not recognized as an internal or external command,
```

（实测：`node out/_repeat.mjs 25` → `有杂讯：1/25`；bash 通道 15 次里也是 1 次。）

### 机制

`cmd.exe` 是**流式读取并切分**批处理文件的。文件里的 `chcp 65001` **要等它被读到才生效**，
可是**在那之前** cmd.exe 已经在用**当前 OEM 代码页**（本机是 936）解释前面那些行了。

本文件原来在注释里写了 `★` / `⇒` / 中文。这些字符在 UTF-8 里是**多字节**，在 936 下
字节边界会落到**错误的位置** ⇒ 偶发把相邻的 ASCII 片段切出来当命令执行
（`install-desktop-icon.mjs` 被切出尾巴 `ll-desktop-icon.mjs`）。

### ★ 为什么它藏了这么久

1. **只有 4% 的概率**，95% 的时候完全正常；
2. 双击启动时**窗口一闪而过**，根本没人看输出；
3. 它**不改变退出码**（实测 `EXIT=0`），所以"成功/失败"的判据不受影响
   ⇒ 任何只看退出码的检查都发现不了它。

### ★★ 纪律

- **`.cmd` / `.bat` 里不许出现任何非 ASCII 字节**（> 0x7F），一个都不许。
- **只加 `chcp 65001` 是不够的** —— 它生效时 cmd.exe 已经把文件读完了。
- 要写中文说明，就**写进本文件**（同目录的 `.md`），或写成 `rem  see <路径>`。
- 顺带：每一行必须是 **CRLF**。LF-only 行会让 cmd.exe **吃掉 `rem` 前缀**，
  把注释里的英文单词当命令跑（这一条更致命，见下）。

## 3. 判据

`scripts/check-cmd-lineendings.mjs` 两条都查：

| 判据 | 内容 | 消融自证 |
|---|---|---|
| **A** | 所有 `.cmd`/`.bat` 的**纯 LF 行数 = 0** | 把任一 `.cmd` 改回 LF ⇒ 必红 |
| **B** | 所有 `.cmd`/`.bat` 的**非 ASCII 字节数 = 0** | 往任一 `.cmd` 塞一个 `★` ⇒ 必红 |

> ⚠️ 判据 B 的**假绿陷阱**：不要只匹配字面量 `★`。第一版（当时叫"检验名称"）就是只认常量名，
> 消融时把名字一换就骗过了。**要匹配字节本身**（`b > 0x7f`）。

## 4. `--stop`（2026-09-26 补）

用户问："所以现在我要把所有的那些 node 窗口和你的后台任务全都关掉吗？"

**不用。** 这台机器当时跑着 ~16 个 node 进程，其中只有 6 个属于本项目
（而且是**三个独立的 switchboard**）。`taskkill /IM node.exe` 会把别人的活一起杀掉。

⇒ `--stop` 是**按路径圈定**的（见 `scripts/arm-stop.mjs`）：
只杀命令行里含本仓库路径 **且** 含 `/switchboard/` **且** 匹配 `main.js` 的进程，
再补上它们的子进程（**先子后父**）。命令行里没有本仓库路径的 node，
**一个都不碰**（有 11 条行为测试盯着这条不变量）。

★ 还有一条硬规则：**读不到进程列表就拒绝执行**，不猜。
（"通道不可用 ≠ 读数为 0"。）

## 5. 底座 bug（2026-09-25 修）

原来写的是 `cd /d "%~dp0.."`。`%~dp0` 是**这个 .cmd 自己所在的目录**：

- 本文件在 `scripts\` 里时，`..` = 仓库根 ✅
- 但**拷到桌面**后，`..` = `C:\Users\Admin\` ⇒ 去找 `C:\Users\Admin\scripts\arm-up.mjs` ❌

⇒ 正解：留一个**标记行** `set "DSH_REPO_OVERRIDE="`，
由 `install-desktop-icon.mjs` 把**绝对仓库路径**写进桌面那一份。

相关文件：`scripts/arm-up.mjs` · `scripts/arm-stop.mjs` · `scripts/install-desktop-icon.mjs` ·
`scripts/check-cmd-lineendings.mjs` · `scripts/relaunch-switchboard.cmd`
