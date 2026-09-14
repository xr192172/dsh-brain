# 爆仓会话浓缩复盘：design-canvas 翻译 Go Hub → TS dsh-hub

> 会话：`session-28f50f57`（工作区 `D:\project_develop\elv`）
> 复盘依据：全量解压该会话 57652 行 / 3918 万字符，问询它的 60 份 compaction checkpoint、事件直方图、工具调用与失败记录。

## 1. 它到底在干什么

用户交付 `dsh-hub-handoff.zip`（构建计划 + spike），交给 dsh agent 用 **design-canvas 把老 Go Hub(`internal/hub/v2`)翻译重制为 TS 项目 `dsh-hub`**。全程 41 轮 / 1812 步，主线：

1. 读 zip 文档 + spike；读 Go 源码（protocol.go 747 行 / router.go 255 行 / builtin_services.go / hub.go）。
2. 用 design-canvas `import_project` 导入 `go-hub-v2-protocol`（57 节点 / 591 符号），`extract_contracts` 提取契约。
3. 在 `D:\project_develop\elv\dsh-hub\` 手写生成 TS：`protocol.ts` / `router.ts` / `hub.ts` / `services/*` / `persistence.ts` / `server.ts` + React 前端（**绕过 scaffold 手写**）。
4. 中途反复处理 design-canvas 更新（git pull，撞 `.git/FETCH_HEAD` 权限）+ 配置 key-pool(3101) 让 translate 走本机密钥池。

→ 正是那个后来我们验收通过的 `elv/dsh-hub`。

## 2. 数据画像

| 项 | 值 |
|---|---|
| 轮 / 步 | 41 轮 / **1812 步** |
| 工具调用 | **pwsh 1965** · **read 1042** · job_output 681 · edit 373 · explore_code 174 · grep 121 |
| 窗口 / 峰值 | `contextWindow 128000` → 撑到 ~167K（**净超窗 ~39K**）|
| 压缩次数 | compaction **65 次**（start=end 各 65、summary 60、prune 32）|
| 压缩量 | 单次最大 shadowed **79718**；**60 次累计 shadowed ≈ 1,923,612 tokens** |
| 压缩失败 | 5 次：3×`summarization produced no text summary content` + 1×`Stream ended without finish_reason` + 1×`Request was aborted` |

## 3. 它具体怎么涨的

**根因不是"没装压缩"，而是"压了 60 次还追不上 + 关键一刻摘要自己崩了"。**

1. **工具结果洪峰（主放大器）**：1965 pwsh + 1042 read + 681 job_output 的大段输出**几乎原样堆进表面**——`tool-result-pruner`（阈值 4096）只跑了 32 次，绝大多数步不加料。单步可注入数万 token，**在 pre-step 压缩检查的间隙直接顶穿窗口**。
2. **正反馈消耗**：60 次压缩共清掉约 192 万 token，但每轮新增更大；越到后面越接近临界。
3. **爆仓瞬时自愈失灵（致命点）**：当表面积逼近/越过窗口，compaction 走"调**同一模型**给自己摘要"→ 那刻该模型也被塞爆 → 末端连续出现 **3 次 "summarization produced no text summary content"**（order 5194/32510/32542），于是 overflow 恢复也缩不动 → **你看到的"回答截断、发继续不压"**。

→ **结论：是"压缩依赖同一模型自摘要，压力下来时它自己先输"形成的死锁，不是没有压缩。** 这与"窗口 128K 却涨到 167K"完全自洽。

## 4. 修复指向（供后续落地）

- **A. 入口堵**：把 `tool-result-pruner` 从"懒触发"改成**每步注入即对超阈值结果做 head+tail 裁剪 / 落文件**，消除"一步顶穿窗口"。
- **B. 抗爆收缩**：把单趟摘要改为**分段 80% 多趟**（摘要拼后段再摘要），每趟只喂一小段，永不一次性塞爆摘要模型。
- **C. 确定性兜底**：当 summarizer 失败/超时/空跑时，退到**按规则裁最老 surface 段**（保留 recent tail，不拆 tool-call/result），保证爆仓也物理缩小、永不死锁。