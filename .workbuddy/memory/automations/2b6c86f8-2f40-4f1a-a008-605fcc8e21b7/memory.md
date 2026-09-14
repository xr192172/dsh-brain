# automation: 换代后体检 + 两根 MCP 探针（DC 新 dist 进工具面）

## 任务目标
把 design-canvas 新 dist 推进 DSH 模型工具面：触发 fast 换代 → 铁律 9 换后体检 → 两根 MCP 回归探针必须 exit 0。

## 执行历史

### 2026-09-14 16:50–16:53（首次执行，成功）
- 前置核对：06b633f 是 design-canvas 【真身】 D:\project_develop\design-canvas 的 HEAD（16:47 提交，工作区干净）。
  ★ 教训：dsh-brain/design-canvas-dev 是【副本】，里面【没有】06b633f；找 dist/commit 一律先认 kernelDir 指向的真身。
- dist 已新构建：dist/src/* mtime 16:45，含 06b633f 的零前置逻辑。
- 换代：GET /?cmd=restart → stage=started, fast=true；9s 后 result/status 报 success。
  gen-3084(pid 31004, port 3084) → gen-3085（pid 22852, port 3085, lease generation 19→20）。
- 换后体检（铁律 9）：gen-3085/boot.log 本次 BOOT 段（at=2026-09-14T08:50:48.015Z）干净；
  capability-bridge 带 registry config OK、design-canvas-bridge 带完整 config + 7 工具全注册 OK、MCP server started OK；
  crash-investigation\ 无 16:50 之后新增文件；pid 22852 实测 LISTENING 127.0.0.1:3085，
  并在 16:50:49 拉起子进程 pid 27064（node，109MB）= MCP stdio server。
- 探针：probe-dc-capability-map-mcp.mjs PASS（60 工具/6 线）exit 0；probe-dc-zero-setup.mjs PASS（5 项）exit 0。
- 无回滚。

## 复用要点 / 坑
1. 换代只看 ?cmd=result 会漏 —— 必须配合 boot.log 与 crash-investigation。
   注：boot.log 里含【历史】失败痕迹，但都排在最新 “===== BOOT ” 标记【之前】；
   判据是「标记之后那段」是否含 invalid config / failed to apply loader entry。
2. boot.log 末行 “dsh web: http://127.0.0.1:3080” 是【显示口径】（配置默认 web 端口），不是 gen 端口；
   gen 端口以 lease.activeGen.port + netstat 为准（已知 quirk，非故障）。
3. 进程 CommandLine 在本机 CIM 里读不到（22852/27064 的 CMD 均空）→ 判存活靠
   Get-Process -Id + netstat -ano + CreationDate 对齐 boot 时刻，不要靠 CMD 匹配。
4. Bash 里 find ... -newermt 在 MSYS 路径下会失败（路径被当参数）→ 用 node 读目录 + 比对 mtime。
5. 探针只证明「dist 正确」；证明「进了模型工具面」要额外看宿主是否拉起 MCP 子进程。
6. 写记忆文件别在 bash 双引号里塞反引号（会被命令替换）→ 用脚本文件。
