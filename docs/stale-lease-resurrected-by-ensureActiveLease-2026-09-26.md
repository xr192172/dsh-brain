# ★★★ 控制面的 stale-lease recovery **被自己紧接着的那一行撤销了**（2026-09-26 实测坐实）

> 归属：**上游 `@deepseek-ai` 之外的、我们自己的 `packages/switchboard/` 代码**
> （`switchboard` 是本仓库的包，不是上游 `node_modules` 里的）⇒ **这次真的是我们的账**。
> 但**不是**我这次改坏的 —— 这两行**都在我动手之前就在那里**。

## 0. 结论（一句话）

`main.ts` 的启动序列里，**清 lease（178-189 行）与重新授予 lease（191 行）相邻**，
而后者取的是 **coordinator 内存里的 `this.active.inst`** —— 那个值**正是刚从陈旧文件读进来的（死）pid**。
⇒ **清掉之后立刻按原样写回去** ⇒ **stale-lease recovery 事实上是空转**。

## 1. 代码路径（逐字，`packages/switchboard/src/main.ts`）

```
169:  const staleLease = coord.getLease().current          ← 从【磁盘】读到的陈旧 lease
...
178:  if (staleLease.generation > 0 && staleLease.activeGen.pid > 0) {
179:    if (!pidAlive(staleLease.activeGen.pid)) {
180-182:   console.error(`[switchboard] stale lease detected: ... is dead — clearing lease`)
183:      coord.getLease().clear()                          ← ✅ 清掉了（文件被写成 generation:0）
184:    } else { console.log(`... lease recovery OK: ... alive`) }
188:  }
191:  coord.ensureActiveLease()                             ← ★★ 紧接着这一行
```

`packages/switchboard/src/coordinator.ts:185-189`：
```ts
ensureActiveLease(): void {
  if (!this.lease.isHeld()) {
    this.lease.grant(this.active.inst.gen, this.active.inst.port, this.active.inst.pid, ...)
    //               ^^^^^^^^^^^^^^^^ ★ 内存里的 active —— 启动时是从【陈旧文件】填的
  }
}
```

⇒ **`clear()` 把 `isHeld()` 变成 false ⇒ `ensureActiveLease()` 立刻 `grant()` ⇒
   而 `this.active.inst` 里的 pid 就是那个【已死的 9224】** ⇒ **写回**。
★ 注释（190 行）写的是"热重启时**磁盘 lease 可能被 clear，需重新授予活跃代**" ——
  作者的**意图**是"给那个真的刚起来的 bootstrap 代补一张票"，
  **但启动路径上 `this.active.inst` 还没被更新成新代** ⇒ 意图与实现相反。

## 2. 实测证据（三重，互相独立）

### 2.1 日志自己说它清了
`D:/project_develop/_arms/a/dshhome/logs/switchboard-run.err.log` **最后一行**逐字：
```
[switchboard] stale lease detected: gen=gen-33082 port=33082 pid=9224 is dead — clearing lease
```

### 2.2 但文件里 still 是那个死 pid，且**被刷新过**
`_arms/a/dshhome/switchboard/lease.json`（清完之后的读数）：
```json
{ "generation": 9,
  "activeGen": { "gen": "gen-33082", "port": 33082, "pid": 9224 },   ← ★ 还是 9224
  "writerToken": "edfa2453-…", "expiresAt": 1790410970902,           ← ★ 时间戳是【新的】
  "lastFencingSeq": 7155 }                                            ← ★ 也比旧读数大
```
- `pid=9224` ⇒ `tasklist /FI "PID eq 9224"` ⇒ **"没有运行的任务匹配指定标准"**（确认是尸体）；
- **`expiresAt` 与 `lastFencingSeq` 都是新的** ⇒ 这文件**不是"没人管的旧残留"**，
  而是**有活人在写它、且写的就是错的 pid** —— 这正是 `grant()` 的指纹
  （`lease.ts:58-65`：`generation+=1` / `activeGen=…` / `expiresAt=Date.now()+ttl` / `lastFencingSeq+=1`）。

### 2.3 与"谁在写"对得上
`lease.ts:6` 逐字：**"仅 Switchboard（协调器）持有并写本文件——这就是"单一写者"的物理锚点"**。
⇒ 写者只有 `LeaseStore`；而 `clear()` 之后唯一会立即 `grant()` 的就是 `ensureActiveLease()`。
⇒ **两条独立读数（日志 + 文件指纹）共同指向同一行。**

## 3. 后果

1. **每次重启臂，`lease.json` 都会被重新写成那个死 pid** ⇒ **僵尸 lease 是【自我修复不了】的**：
   恢复代码**看起来在跑**（日志都印出来了），**但净效果为零** —— 这是**假绿**的教科书形态
   （铁律 7/11：判据"为真"了，机制却什么都没做）。
2. 于是 `arm-up` 的旧判据（"lease 里 pid 死 ⇒ 拒跑并叫人手停"）**永远命中**；
   而按它去手停，就会打死**那个唯一健康的实例**（见 `docs/arm-a-zombie-lease-causal-chain-2026-09-26.md` §3）。
3. ★ 更隐蔽的后果：**`generation` 停在 9 不动**（因为 `clear()` 归零后 `grant()` 是 `+=1`
   从 0 → 1，但文件里显示的是**9**）——
   ⇒ 说明**实际落盘的 generation 与"活着的控制面自己报的 generation=1"长期不一致**；
   任何**拿 generation 当"换代次数/新鲜度"**的判据都会读到假值。

## 4. 修法（建议，**本棒未实施**）

**最小、单一职责的修法**：把"清"与"授予"的顺序/对象解耦，让 **`ensureActiveLease` 不要用于启动恢复**。

- **方案 A（最小）**：`main.ts` 里 `pidAlive` 判死之后，**同时把 coordinator 的 active 也置空**，
  再调 `ensureActiveLease()`；或者干脆**跳过** `ensureActiveLease()`（让它留给"真有一个刚 spawn 的 bootstrap 代"那条路径）。
- **方案 B（更稳）**：`ensureActiveLease()` 加一个前置断言 ——
  **`if (!pidAlive(this.active.inst.pid)) return`**（"我不给一个死进程发票"）。
  ★ 这条的好处：**把不变量写进函数自己**，不依赖调用点的顺序。**我倾向 B**。
- ★ **两种方案都必须配消融**：**把修复撤掉 ⇒ `lease.json` 必须重新出现"死 pid + 新时间戳"**。
  （这条消融**天然可判**：读文件里的 pid，拿去 `tasklist` 问它活没活。）

## 5. 与"上游 vs 我们"的归属（铁律 17）

- `packages/switchboard/**` 是**本仓库自己的包**（不是 `node_modules/@deepseek-ai/*`）
  ⇒ **这次是我们的账**，可以改、也应该改。
- 但**不是我 2026-09-26 这次改坏的**：`main.ts:178-189` 与 `ensureActiveLease()` 在
  **我今天任何改动之前**就在那里（我今天的改动只碰了 `scripts/arm-up.mjs` 与 `mgmt.ts` 的 env 剥离）。
  ⇒ 记录为**既有缺陷**，不是回归。

## 6. 诚实清单

- **实测**：§2.1 日志原文、§2.2 文件读数 + `tasklist` 死体确认、`clear()`/`grant()`/`ensureActiveLease()` 的源码。
- **推断（未实测）**：§0 的"下一条命令撤销上一条"这条**因果**，我是由
  「`clear()` 之后文件被刷新成同样的死 pid + 新的 expiresAt」**推**出来的 ——
  **我没有**在 `grant()` 里打日志直接抓到那一帧。
  ★ 但两条独立读数（err 日志 + 文件指纹）都指向同一行，且**没有第二条代码路径**能在
  `clear()` 之后立即写该文件（`lease.ts:6` 的单一写者）。
- **没做**：修法（§4）**一行都没改** —— 本棒的硬规则是"只改 `scripts/arm-up.mjs`"，
  且`packages/**` 的改动应当**单独一棒 + 自己的消融**。
