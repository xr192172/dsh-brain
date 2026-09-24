#!/usr/bin/env bash
# 格⑮ 重放臂**新增**的两种坏装配（判据 5 的"多造几种"）+ 独立丢弃核验。
#
# 与 run-preflight-e2e.sh 分开跑，理由：主脚本的 6 场景是**逐字沿用 B2**、已单独取证；
# 这两条是本臂**自己加的**，放进主脚本会让"主脚本是否仍与 B2 同形"这件事变模糊。
#
#   F-bad-apply-throws : 模块可装载，但 apply() 装配期同步抛错
#   G-bad-dup-id       : 一次 overlay 里插两条**同 id** 的条目（重复 loader entry id）
#
# 用法：bash packages/switchboard/test/e2e/run-preflight-e2e-extra.sh
#   PREFLIGHT_ADMIN / PREFLIGHT_PROFILE / PREFLIGHT_OUT 与 run-preflight-e2e.sh 同一套（同一缺省）。
#   ★ 本文件只在**重放臂**里可用：末尾调用的独立丢弃核验器 `out/_replay/run/verify-discard.mjs`
#     是重放臂的取证工具；主仓若保留本文件，需自备一个等价的核验器（见该脚本的文件头说明）。
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd -W)"
FIX="$HERE/fixtures"
REPO="$(cd "$HERE/../../../.." && pwd -W)"
ADMIN="${PREFLIGHT_ADMIN:-http://127.0.0.1:31800}"
PROFILE="${PREFLIGHT_PROFILE:-web}"
OUT="${PREFLIGHT_OUT:-$REPO/out/preflight-evidence}"
TMP="$OUT/e2e-overlays"
mkdir -p "$TMP"

case "$TMP" in
  [A-Za-z]:/*) : ;;
  *) echo "FATAL: overlay 目录不是 Windows 形式路径（$TMP）" >&2; exit 2 ;;
esac
fileurl() { printf 'file:///%s' "$1" | sed 's#\\#/#g'; }

cat > "$TMP/bad-apply-throws.yml" <<EOF
- insert:
    - id: b2-bad-apply-throws
      name: '$(fileurl "$FIX/bad-apply-throws.mjs")'
      config: {}
EOF

# 同 id 两条：dsh 的 loader 以条目 id 为键 ⇒ 这是"重复 entry id"这一经典崩法的表达。
cat > "$TMP/bad-dup-id.yml" <<EOF
- insert:
    - id: b2-dup
      name: '$(fileurl "$FIX/good-plugin.mjs")'
      config: {}
    - id: b2-dup
      name: '$(fileurl "$FIX/silent-plugin.mjs")'
      config: {}
EOF

run_one() {
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
run_one "F-bad-apply-throws" "preflight&profile=$PROFILE&patch=$P/bad-apply-throws.yml&plugins=b2-bad-apply-throws&tools=tool_apply"
run_one "G-bad-dup-id" "preflight&profile=$PROFILE&patch=$P/bad-dup-id.yml&plugins=b2-dup&tools=b2_probe_tool"

echo "ALL DONE"
echo
rc=0
for n in F-bad-apply-throws G-bad-dup-id; do
  got="$(verdict_of "$n")"
  if [ "$got" = "reject" ]; then echo "  [OK ] $n -> reject"
  else echo "  [RED] $n -> $got（期望 reject）"; rc=1; fi
done

echo
echo "=== 独立丢弃核验（不读报告自述的 discarded 字段，自己探 PID/端口）==="
DISCARD="$DIR/verify-discard.mjs"
if [ ! -f "$DISCARD" ]; then
  echo "  [SKIP] 独立丢弃核验器不在（$DISCARD）⇒ 跳过这一步"
  echo "  [SKIP] ★ 跳过【不等于】通过 —— 其余判据仍照跑（本步只是额外核验，不构成通过证据）"
else
node "$DISCARD" \
  "$OUT/F-bad-apply-throws.raw.json" "$OUT/G-bad-dup-id.raw.json" \
  "$OUT/A-positive.raw.json" "$OUT/A0-negctl.raw.json" \
  "$OUT/B-bad-throws.raw.json" "$OUT/C-bad-missing-dep.raw.json" \
  "$OUT/D-bad-ghost.raw.json" "$OUT/E-silent.raw.json" || rc=1
fi

echo
if [ "$rc" = 0 ]; then echo "EXTRA 自检通过（+2 坏样本，且 8 次预演的进程都已真死）"; else echo "EXTRA 自检失败"; fi
exit "$rc"
