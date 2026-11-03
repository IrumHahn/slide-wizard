#!/bin/zsh
# 더블클릭으로 슬라이드 마법사를 켠다.
# 더블클릭으로 뜬 터미널은 nvm 설정을 안 읽어서 node 를 직접 찾는다.
cd "$(dirname "$0")"

find_node() {
  command -v node 2>/dev/null && return
  if [ -d "$HOME/.nvm/versions/node" ]; then
    local latest
    latest=$(ls "$HOME/.nvm/versions/node" | sort -V | tail -1)
    [ -x "$HOME/.nvm/versions/node/$latest/bin/node" ] && { echo "$HOME/.nvm/versions/node/$latest/bin/node"; return; }
  fi
  for p in /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -x "$p" ] && { echo "$p"; return; }
  done
  return 1
}

NODE=$(find_node)
if [ -z "$NODE" ]; then
  echo "❌ Node.js 가 없어요. https://nodejs.org 에서 LTS 를 설치한 뒤 다시 눌러 주세요."
  read -k 1 -s "?아무 키나 누르면 닫힙니다."
  exit 1
fi

( sleep 1.2 && open http://localhost:4900/ ) &
exec "$NODE" server.mjs
