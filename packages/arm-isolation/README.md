# arm-isolation — 臂间隔离层

独立于沙箱档位的策略插件，通过 ctx.tools.guard() 拦截跨臂路径访问。

## 设计目标
沙箱档位（dsh-sandbox-policy）只有 mode 与 workspaceRoot，没有 deny/allow 列表。
danger-full-access 是全开，做不到全开但只挡某个子树。
本层是 dev 模式的安全配套：沙箱放开，但两臂仍然互不可见。

## Config 契约
{ self?: string; arms?: Record<string, string>; extraDeny?: string[] }
- deny 集合 = arms 中【除 self 外】的所有 root + extraDeny
- self 缺省时不排除任何臂（= 全挡）—— fail-closed 方向
- arms 为空时 denyRoots 为空 = no-op（放行一切）

## 覆盖范围
1. FS 工具 arguments：read/write/edit/glob/grep/read_image 的路径字段
2. shell 命令文本：pwsh/bash 的 command 字段
3. 兜底扫描：所有工具 args 中的字符串字段递归扫描

## 拦不住的场景
1. 相对路径长回旋（../../_abA/...）- 解析后能拦，符号链接绕开可能漏
2. 通过中间程序间接访问（cat /tmp/_abA/secret）
3. 没走工具层的直接系统调用（fork/exec/ioctl）
4. 终端会话内的命令（terminal PTY 交互）
5. 进程间共享内存/管道

**结论：这层保证工具层的跨臂路径访问被拦，不是完全隔离。**

## 挂载说明
-id: arm-isolation
  name: '@dsh-brain/arm-isolation'
  config:
    self: A
    arms:
      A: 'D:/project_develop/_abA'
      B: 'C:/_abB-experiment-root'

profile 合成顺序：bundles -> cordis.patch.yml -> --patch overlays（最后 => 可覆盖）
overlay 由控制面在 dev 模式生成并注入（主线 R0 活）。
