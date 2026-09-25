#!/bin/sh
# first_line.sh —— 【最小「一等」skill】样本的那个脚本。
# 用法：first_line <path>   ⇒ 打印该文件的第一行**非空**内容；空文件则打印 (empty)
# 为什么要它：端到端演练要证明"skill 的 Script 真的能被跑"，所以它必须是个**真能跑**的东西。
first_line() {
  p="$1"
  if [ ! -f "$p" ]; then
    echo "(no such file: $p)"
    return 1
  fi
  line=$(grep -m1 -v '^[[:space:]]*$' "$p")
  if [ -z "$line" ]; then
    echo "(empty)"
  else
    echo "$line"
  fi
}

# 直接执行时（`sh first_line.sh <path>`）也走同一条逻辑
if [ "$(basename "$0")" = "first_line.sh" ] && [ -n "$1" ]; then
  first_line "$1"
fi
