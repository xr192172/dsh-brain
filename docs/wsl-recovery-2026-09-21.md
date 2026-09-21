# WSL 卡死恢复清单（2026-09-21 只读诊断结论）

> **一句话：不需要重装 WSL，也不需要重置 Docker Desktop。只是一个进程卡住了。**
> 诊断是**只读**做的（服务/特性/注册表/进程），没有改动你机器上任何东西。

---

## 1. 根因（有证据）

| 项 | 实测 | 说明 |
|---|---|---|
| **`WSLService`** | **State = `Stop Pending`；Status = `Degraded`；PID = 6552** | ★★ **卡死点** |
| `wslservice.exe` 进程 | **还活着**（pid 6552，29.4 MB） | SCM 认为"正在停止"，进程却没死 |
| **后果** | 任何 `wsl.exe` 调用**挂住** ⇒ `context deadline exceeded` | Docker Desktop 的报错就是这个 |
| "重启服务"失败（"不在计算机上"） | **必然** | Stop Pending 期间服务不可控 |

**为什么"依赖 WSL 的 Docker 能跑，WSL 却不行"**：Docker Desktop 现在用的就是 **WSL2 后端** ⇒ **同生共死**。
之前 `docker 28.0.4` 能用，是因为那时 `wslservice` 还正常。**这不是两个问题，是一个。**

## 2. 底层都是好的（所以**不要**重装/重置）

| 检查项 | 结果 |
|---|---|
| `Microsoft-Windows-Subsystem-Linux` | **已启用（InstallState=1）** ✅ |
| `VirtualMachinePlatform` | **已启用（=1）** ✅ |
| `Microsoft-Hyper-V-All` | **已启用（=1）** ✅ |
| `vmcompute` / `hns` | **Running** ✅ |
| Store 版 WSL 包 | **已安装（2.7.14.0）** ✅ |
| 服务二进制 | `C:\Program Files\WSL\wslservice.exe` ✅ |
| 已注册发行版 | **`Ubuntu-24.04`（WSL2）** + `docker-desktop`（WSL2）✅ **数据都在** |
| 内核文件 | `C:\Windows\System32\lxss\tools\{init,initrd.img,bsdtar,ext4.vhdx.gz}` 齐全 ✅ |

## 3. 修复顺序（**全部要"以管理员身份运行"**）

```powershell
# ① 掐掉卡死的进程（连子进程一起）
taskkill /F /IM wslservice.exe /T
# ② 启动服务
sc start WSLService          # 或： net start WSLService
# ③ 清干净并逐条验证
wsl --shutdown
wsl --status
wsl -l -v                    # 应看到 Ubuntu-24.04 与 docker-desktop
wsl -d Ubuntu-24.04 -- echo ok   # 应打印 ok
```

- **② 起不来 ⇒ 直接重启机器**。Stop Pending 几乎必被重启清掉。**别在服务上反复纠缠。**
- 机器重启后：**先** `wsl -d Ubuntu-24.04 -- echo ok` 通过，**再**启动 Docker Desktop（它会自动恢复）。

## 4. ★ 卡死前史（这是"为什么会半死"的答案）

前几个会话留在 `out/` 里的留档：

| 时间 | 事实 |
|---|---|
| 09-20 16:04 | Docker 的 `settings-store.json` 里 **`WslUpdateRequired = True`**、`AutoDownloadUpdates = False` |
| 09-20 16:05 | 跑 `wsl --update`，**`elevated=False`（没提权）**，正常与 `--web-download` **两次都失败**；当时 `wsl -l -v` **还能用** |
| 09-21 11:27 | WSL 提供程序日志**无数据**；Application 里只有 2 条 `P=WSL Id=0`（09-20 16:06/16:08） |

⇒ **链条**：一次**未提权**的 `wsl --update` 失败 ⇒ 留下半更新状态（`WslUpdateRequired=True`）
⇒ 今天服务一重启 ⇒ **卡在 Stop Pending**。
⇒ **推论**：`wsl --update` **必须提权**。**清掉卡死之后，先做管理员 `wsl --update`**，再谈别的。

## 5. 明确**不要做**的三件事

1. ❌ **不要** `dism /online /enable-feature …` 重新启用特性（**已经是启用状态**）。
2. ❌ **不要**重装或 `wsl --unregister` `Ubuntu-24.04`（**发行版与数据都在**）。
3. ❌ **不要**点 Docker Desktop 的 **"Reset to factory defaults"**（会删 WSL 里的 docker-desktop 数据，**而这里根本不是数据问题**）。

## 6. 备件（**仅当**清掉卡死之后 Store 包仍坏时才用；链接均已实测）

| 资源 | 链接 |
|---|---|
| WSL2 内核更新包 x64 | `https://wslstorestorage.blob.core.windows.net/wslblob/wsl_update_x64.msi` |
| WSL 官方发行包（MSI / msixbundle / 内核） | `https://github.com/microsoft/WSL/releases` |
| 手动安装文档（上面那个 MSI 的权威出处） | `https://learn.microsoft.com/en-us/windows/wsl/install-manual` |
| 故障排查（错误码对照） | `https://learn.microsoft.com/en-us/windows/wsl/troubleshooting` |
| Ubuntu 24.04（Store） | `https://apps.microsoft.com/detail/9NZ3KLHXDJP5` |

## 7. ★ "下载慢"这件事**不用靠下载解决，换镜像就行**

今天 `uv sync --all-extras` 卡死 19 分钟、缓存零写入：根因是它去拉 **litellm 的 sdist ⇒ 触发 Rust 工具链引导**，
从官方源以 **≈19 KB/s** 爬。**实测可达的镜像**：

```bash
pip config set global.index-url https://pypi.tuna.tsinghua.edu.cn/simple   # 200
export UV_DEFAULT_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple           # 200
export RUSTUP_DIST_SERVER=https://mirrors.tuna.tsinghua.edu.cn/rustup      # 200
# 阿里 PyPI：https://mirrors.aliyun.com/pypi/simple/  # 200
# 中科大 PyPI 返回 403，别用
```

★ 而且 **VeRO 根本不需要 `--all-extras`**：用 **`uv sync --extra harbor --no-dev`** 秒级过（详见 `docs/vero-integration-findings.md` §2）。

## 8. 为什么这一步是主线的**硬前置**

- VeRO 的 `command` 后端在 **Windows 上直接失败**（`LocalSandbox` 的 POSIX 假设把 `/tmp/…` 解析成 `D:\tmp\…`）；
- Windows 上**能用**的 `DockerSandbox` **没被接到 CLI**（`vero optimize` 无 `--sandbox`）；
- **上游 DSH `minimal`（唯一干净的工具面下界）同样只支持 POSIX**。
⇒ **WSL 修好 = 一次解开三件事**（VeRO 端到端、上游 minimal 实测、容器里的 Linux 评测）。
