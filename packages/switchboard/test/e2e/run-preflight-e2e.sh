#!/usr/bin/env bash
# 格⑮ · 预演体检的**端到端复现脚本**（判据 1/2/5/6 + command 两向的证据生成器）。
#
# 前置（★ 本脚本**不替你满足**）：一个**跑着本包代码**的控制面实例（见 docs/preflight.md §9）。
#   PREFLIGHT_ADMIN     控制面 admin（默认 http://127.0.0.1:31800 = 主仓控制面 admin 缺省口）
#   PREFLIGHT_PROFILE   预演 profile 名（默认 web = 主仓缺省 profile）
#   PREFLIGHT_DSH_HOME  目标 profile 所在的 DSH_HOME（默认 $HOME/.dsh）
#   PREFLIGHT_OUT       证据输出目录（默认 <repo>/out/preflight-evidence）
#
# ★ 它**不**做这两件事，避免"看起来全绿"：
#   · 不替你起控制面（那是运维动作）；
#   · 前置缺失（admin 不通 / 没有 preflight 通道 / profile 目录不存在）⇒ **明确报错 + 用法**，
#     绝不"静默 exit 0"。
#
# 它做这些事：
#   ① 在临时目录里**生成 overlay**（`--patch` 文件），里面的插件路径按**本机绝对路径**即时写成
#      `file:///` URL —— 因为 dsh 的整机 boot 路径不做 pathToFileURL，绝对 Windows 路径会被
#      Node ESM loader 以 ERR_UNSUPPORTED_ESM_URL_SCHEME 拒绝（实测）。
#   ② 依次跑 8 个场景并把**原始应答**逐份落盘：正样本 1 个 + 负对照 1 个 + 坏样本 4 个
#      + command 两向 2 个。
#
# 用法：
#   bash packages/switchboard/test/e2e/run-preflight-e2e.sh
#   # 指向一个另起的、跑本包代码的实例（推荐；不打扰现役）：
#   PREFLIGHT_ADMIN=http://127.0.0.1:31902 PREFLIGHT_PROFILE=rehearsal-r \
#   PREFLIGHT_DSH_HOME=/abs/isolated-dsh-home \
#     bash packages/switchboard/test/e2e/run-preflight-e2e.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd -W)"
FIX="$HERE/fixtures"
REPO="$(cd "$HERE/../../../.." && pwd -W)"
ADMIN="${PREFLIGHT_ADMIN:-http://127.0.0.1:31800}"
PROFILE="${PREFLIGHT_PROFILE:-web}"
DSH_HOME="${PREFLIGHT_DSH_HOME:-$HOME/.dsh}"
OUT="${PREFLIGHT_OUT:-$REPO/out/preflight-evidence}"
TMP="$OUT/e2e-overlays"
mkdir -p "$TMP"

usage() {
  cat >&2 <<'EOF'
用法：bash packages/switchboard/test/e2e/run-preflight-e2e.sh

环境变量（★ 全部可覆盖）：
  PREFLIGHT_ADMIN     控制面 admin（默认 http://127.0.0.1:31800）
  PREFLIGHT_PROFILE   预演 profile 名（默认 web）
  PREFLIGHT_DSH_HOME  目标 profile 所在 DSH_HOME（默认 $HOME/.dsh）
  PREFLIGHT_OUT       证据输出目录（默认 <repo>/out/preflight-evidence）

前置（三条缺一不可，不满足时本脚本报错退出，绝不静默返回 0）：
  1) 有一个**跑着本包代码**的控制面实例在 PREFLIGHT_ADMIN 上监听；
  2) 该实例有 preflight 通道（?cmd=preflight-result 能应答）；
  3) PREFLIGHT_DSH_HOME/profiles/PREFLIGHT_PROFILE 目录存在（预演代按它装配）。

怎么满足前置：见 packages/switchboard/docs/preflight.md §9（如何起一个与现役并行的控制面）。
EOF
}
fatal() { echo "FATAL: $1" >&2; echo >&2; usage; exit 2; }

# ★ 路径必须是 **Windows 形式**（`C:/…`），不能是 MSYS 形式（`/c/…`）：
#   `--patch` 的值会经 URL query 传给控制面、再由 dsh（原生 Windows 程序）去读文件。
#   Git Bash 的 `pwd` 默认给 MSYS 路径 ⇒ dsh 读不到 ⇒ 每个场景都会以"patch 读不到"失败，
#   从而**看起来像判据全绿**。这里用 `pwd -W` 拿 Windows 形式，并在下面自检。
case "$TMP" in
  [A-Za-z]:/*) : ;;
  *) fatal "overlay 目录不是 Windows 形式路径（$TMP）—— --patch 会读不到，判据会假绿" ;;
esac

# ── 前置自检（★ 不满足 ⇒ 明确报错 + 用法，绝不静默） ────────────────────────────
echo "== 前置自检 =="
echo "  admin   = $ADMIN"
echo "  profile = $PROFILE"
echo "  dshhome = $DSH_HOME"
echo "  out     = $OUT"
health="$(curl -s -m 5 "$ADMIN/?cmd=health" 2>/dev/null || true)"
if [ -z "$health" ]; then
  fatal "控制面 admin 无应答：$ADMIN/?cmd=health（实例没起？端口不对？用 PREFLIGHT_ADMIN 指向你的实例）"
fi
echo "  health  = $health"
presult="$(curl -s -m 5 "$ADMIN/?cmd=preflight-result" 2>/dev/null || true)"
case "$presult" in
  *'"stage"'*) echo "  preflight 通道 = 在" ;;
  *) fatal "该实例没有 preflight 通道：$ADMIN/?cmd=preflight-result 未返回 stage（这份代码还没合入/没重建？）" ;;
esac
if [ ! -d "$DSH_HOME/profiles/$PROFILE" ]; then
  fatal "profile 目录不存在：$DSH_HOME/profiles/$PROFILE（预演代按它装配；用 PREFLIGHT_PROFILE / PREFLIGHT_DSH_HOME 指定）"
fi
echo "  profile 目录 = 在"
echo

fileurl() { printf 'file:///%s' "$1" | sed 's#\\#/#g'; }

mkpatch() { # $1=file name, $2=entry id, $3=fixture file
  cat > "$TMP/$1" <<EOF
- insert:
    - id: $2
      name: '$(fileurl "$3")'
      config: {}
EOF
}

mkpatch add-good.yml        b2-good        "$FIX/good-plugin.mjs"
mkpatch bad-throws.yml      b2-bad-throws  "$FIX/bad-throws.mjs"
mkpatch bad-missing-dep.yml b2-bad-missing-dep "$FIX/bad-missing-dep.mjs"
mkpatch bad-ghost.yml       b2-ghost       "$FIX/ghost-endpoint-does-not-exist.mjs"
mkpatch silent.yml          b2-silent      "$FIX/silent-plugin.mjs"
mkpatch cmd-good.yml        preflight-cmd  "$FIX/cmd-plugin.mjs"

echo "overlays = $TMP"
echo

run_one() { # $1=case name, $2=query
  local name="$1" query="$2"
  echo "=== [$name] ?cmd=$query"
  curl -s -m 10 "$ADMIN/?cmd=$query" > "$OUT/$name.accept.json"
  cat "$OUT/$name.accept.json"; echo
  for _ in $(seq 1 45); do
    sleep 2
    curl -s -m 10 "$ADMIN/?cmd=preflight-result" > "$OUT/$name.raw.json"
    if grep -q '"stage":"done"' "$OUT/$name.raw.json"; then break; fi
  done
  node "$HERE/summarize.mjs" rep "$OUT/$name.raw.json" > "$OUT/$name.txt" 2>&1
  cat "$OUT/$name.txt"
  echo
}

verdict_of() { sed -n 's/^verdict= \([a-z]*\).*/\1/p' "$OUT/$1.txt" | head -1; }

P="$TMP"
# 负对照：不装任何插件，却声明"应当有 b2_probe_tool" ⇒ 必须 red（证明判据不是橡皮图章）
run_one "A0-negctl" "preflight&profile=$PROFILE&tools=b2_probe_tool"
# 正样本：装入新插件并声明它 → 必须 pass，且它的工具出现在模型面工具表
run_one "A-positive" "preflight&profile=$PROFILE&patch=$P/add-good.yml&plugins=b2-good,switchboard,capability-bridge,tool-evolution,design-canvas-bridge&tools=b2_probe_tool,tool_apply,list_capabilities,tool_score,design_canvas_index"
# 坏样本①：启动即抛错
run_one "B-bad-throws" "preflight&profile=$PROFILE&patch=$P/bad-throws.yml&plugins=b2-bad-throws&tools=tool_apply"
# 坏样本②：缺依赖
run_one "C-bad-missing-dep" "preflight&profile=$PROFILE&patch=$P/bad-missing-dep.yml&plugins=b2-bad-missing-dep&tools=tool_apply"
# 坏样本③：声明一个不存在的端点（loader 条目的模块路径不存在）
run_one "D-bad-ghost" "preflight&profile=$PROFILE&patch=$P/bad-ghost.yml&plugins=b2-ghost&tools=tool_apply"
# 坏样本④：插件合法但"声明的工具"没真的注册
run_one "E-silent" "preflight&profile=$PROFILE&patch=$P/silent.yml&plugins=b2-silent&tools=b2_ghost_tool"

# ── command 判据的**两向**（契约里 command 是一等判据分支，两个方向都要有证据）──────
# H-cmd-positive：插件真的注册了 preflight_probe_cmd ⇒ command 项必须绿 ⇒ 整个 pass
run_one "H-cmd-positive" "preflight&profile=$PROFILE&patch=$P/cmd-good.yml&plugins=preflight-cmd&commands=preflight_probe_cmd"
# I-cmd-negative：同一个插件在跑，但**声明一个它没注册的命令** ⇒ command 项必须红 ⇒ reject
run_one "I-cmd-negative" "preflight&profile=$PROFILE&patch=$P/cmd-good.yml&plugins=preflight-cmd&commands=preflight_ghost_cmd"

echo "ALL DONE"
echo

# ── 自检：不"弱化判据"，也不"看起来全绿"。任一不符合即 exit 1。 ────────────────
rc=0
expect_verdict() {
  local name="$1" want="$2" got
  got="$(verdict_of "$name")"
  if [ "$got" = "$want" ]; then echo "  [OK ] $name -> $got"
  else echo "  [RED] $name -> $got（期望 $want）"; rc=1; fi
}
expect_verdict A-positive pass
expect_verdict A0-negctl reject
expect_verdict B-bad-throws reject
expect_verdict C-bad-missing-dep reject
expect_verdict D-bad-ghost reject
expect_verdict E-silent reject
expect_verdict H-cmd-positive pass
expect_verdict I-cmd-negative reject

# 正样本必须真的抓到"工具面"证据（新插件的工具进了模型面工具表），且丢弃干净。
# 用逐字段 grep（不假设 JSON 的空格形态）：
if grep -q '\[OK  \] tool    tool:b2_probe_tool' "$OUT/A-positive.txt" \
   && grep -q '"stopped":true' "$OUT/A-positive.raw.json" \
   && grep -q '"pidGone":true' "$OUT/A-positive.raw.json" \
   && grep -q '"adminDead":true' "$OUT/A-positive.raw.json"; then
  echo "  [OK ] A-positive 含 tool:b2_probe_tool 的绿项，且 discarded 三项全真"
else
  echo "  [RED] A-positive 缺少工具面绿项或丢弃取证不干净"; rc=1
fi

# ★ command 两向必须**同时**成立：只查"坏的被拒"会漏掉"正的根本没被测"；
#   只查"正的过"会漏掉"坏的没被拦"。两向各查一条**具体**的 command 项。
if grep -q '\[OK  \] command command:preflight_probe_cmd' "$OUT/H-cmd-positive.txt" \
   && grep -q '\[RED \] command command:preflight_ghost_cmd' "$OUT/I-cmd-negative.txt"; then
  echo "  [OK ] command 两向：preflight_probe_cmd 被接受 + preflight_ghost_cmd 被拒"
else
  echo "  [RED] command 两向不成立（正样本无 command 绿项 或 负样本无 command 红项）"; rc=1
fi

echo
if [ "$rc" = 0 ]; then echo "E2E 自检通过（2 正样本 + 6 负样本，判据 1/2/5/6 + command 两向的证据齐）"; else echo "E2E 自检失败"; fi
exit "$rc"
