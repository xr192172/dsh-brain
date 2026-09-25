# scripts/delegation —— 把 DSH 会话当子代理用的一整套工具

> ★ **为什么在这个目录**：这一套原本住在 `out/` 下 —— 而 `out/` 是 **gitignore** 的
> ⇒ **不受版本控制 = 下一个会话看不到 = 等于不存在**（本项目"做完实质东西必须登记"那条纪律）。
> 2026-09-25 提升为受控脚本。
>
> ★ 配套 skill：`~/.workbuddy/skills/dsh-delegate-loop`（流程与坑）+ `verify-delegated-work`（核验产出）。

## 一、主入口

### `dsh-delegate.mjs` —— 派活 + 监督 + 采读数
```
node scripts/delegation/dsh-delegate.mjs --prompt <任务书> --tag <标签> --cwd <工作目录> \
  --preset standard --expect <交付文件> --rounds 3 [--budget-ms 2400000] [--stall-ms 420000]
```
做七件：建会话 → 选 preset（**回读断言**）→ 记 `before.asOfSeq` → 发指令 → 轮询到 settled
（`running:false` **且 `asOfSeq` 前进**）→ **`--expect` 交付文件不存在就自动追问**（最多 `--rounds` 轮）→ 采读数。

**退出码**：0 = 跑完且交付文件已产出；1 = 发不出去/超预算；3 = 用法错；4 = preset 回读不一致；
5 = settled 但**零工具调用**（疑似空跑）；6 = **有未决审批**（会话在等人点"允许"）；7 = settled 但 `--expect` 始终没产出。

★★ **四条已冻结的实测结论**（文件头注释里有全文，改之前先读）：
1. `session.prompt` 的形状**不是** `{sessionId, text}` —— 那样会 **HTTP 200 但什么都不做**；
   正解 `{sessionId, mode:'steer', content:[{type:'text',text}], clientTimeZone}`，端点 `POST /api/<method>`。
2. 完成判据**必须叠加 `asOfSeq` 前进**，只看 `running:false` 会把"还没起跑"判成完成。
3. **权限档位与审批应答都没有 RPC 通道** ⇒ **绝不提权**（提权 = 永久卡死，实测多轮）。
4. **运行时上下文每个 step 重发一次**，其中的「【代际身份】…【切换已完成】…恢复一切正常服务」
   会让 worker 读成"换代了，等指令"而**停工** ⇒ 这就是 `--expect`/`--rounds` 存在的原因。

## 二、半路纠正

### `steer.mjs` —— 向正在跑（或已停）的会话注入消息
```
node scripts/delegation/steer.mjs <sessionId> --from-file <文案文件>
```
- 对**正在跑**的会话：在下一个 step 边界注入；
- 对**已 settled** 的会话：**会重新起一个回合** ⇒ ★ **DSH 的"中断—继续"是天生就有的**，不需要另造机制。
- 典型用途：补边界（禁提权 / 隔离 `DSH_HOME` / 禁 `tool_apply`）、缩范围（"只做 ③④⑤"）。

## 三、观察与核验

| 脚本 | 用途 |
|---|---|
| `wait-sessions.mjs` | 前台带时限等待若干会话跑完（**不结束回合**；只在有变化时打印） |
| `last-say.mjs` | 读某会话**最近的 assistant 文本**（诊断停工点最有效） |
| `dump-session.mjs` | 导某会话的事件流（诊断协议/事件形状） |
| `audit-delegates.mjs` | ★ **委派审计**：越界写 / "上线换代"类工具 / 危险 git / 碰别的臂 / **工具失败率** |
| `find-injection.mjs` | 定位"运行时上下文重注入"发生在哪些 seq |
| `list-external-deps.mjs` | 查某脚本有没有**第三方依赖**（判断无 `node_modules` 的工作树能否跑） |

★★ **审计器的两个口径**（不写清会误判）：
- 它报的是**"企图"，不是"既成事实"** ⇒ 判"有没有真越界"**还要查目标文件在不在**。
- `git push` 之类正则**会误匹配写在报告正文里的字样** ⇒ 判据落在"命令开头/`&&`/`;` 之后"。

## 四、探针（当时的一次性实验，留着当证据）

| 脚本 | 结论 |
|---|---|
| `probe-permission.mjs` | **权限档位没有 RPC 通道**（12 个候选名全 404）；经 prompt 发 `/permission` 只当普通消息 |
| `probe-approval-answer.mjs` | **审批也没有编程应答通道**（17 个候选 + 4 个列举面全 404）⇒ 提权必挂 |

## 五、与具体任务绑定的（**不是通用工具，别当通用工具用**）

- `ablate-l2-behavioral.mjs` —— 针对 `_l2/wt` 的**行为级消融**（驱动真 CLI 看真 verdict）。
  它证明了一件通用的事：**"只读源码文本"的消融是弱判据**，会给出**假结论**
  （实测：改 `verdict` 字段门纹丝不动 ⇒ 那个字段是死码；真正的闸门是 `add(..., ok)`）。
- `test-dev-mode.mjs` —— 验证控制面 dev 模式启动参数（`DSH_SWITCHBOARD_DEV`）落到子代 env，含**向后兼容**判据。

★ 这两份留在本目录是**当范本**：新任务要写判据时，先看它们**怎么把判据写成行为型**。

## 六、已知限制

- `dsh-delegate.mjs` 只连**现役前门**（`:3080`），不自己起实例、不杀进程。
- `audit-delegates.mjs` 的输出默认落 `out/delegation/`（gitignore）。
- 这套工具**不替代** `verify-delegated-work` 的核验清单：核验必须**独立复算**，
  不能只跑子代理自己的脚本（那只能证明它没算错自己那套口径）。
