#!/bin/bash
# Web Bluetooth は file:// では動かない（セキュアコンテキスト必須）。localhost で配る。
#   ./start.sh            → この Mac の Chrome だけ（MESH・マイク可）
#   ./start.sh 8790 lan   → 同じWi-Fiの iPad からも開ける（http://<MacのIP>:8790/）
#                           ※ iPad 側は非セキュア扱いなので「こえ」「スリープ抑止」は使えない（指で描く・花火は動く）
#                           ※ iPad は Safari も Chrome も Web Bluetooth 非対応。MESH は Mac 側の Chrome でつなぐ
cd "$(dirname "$0")"
PORT=${1:-8790}
BIND=127.0.0.1
if [ "$2" = "lan" ]; then
  BIND=0.0.0.0
  IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)
  echo "iPad で開く → http://${IP:-<MacのIP>}:${PORT}/"
fi
echo "Chrome で開く → http://127.0.0.1:${PORT}/"
( sleep 1; open -a "Google Chrome" "http://127.0.0.1:${PORT}/" 2>/dev/null || open "http://127.0.0.1:${PORT}/" ) &
# caffeinate: サーバーが動いている間、Mac のディスプレイをスリープさせない（天井プロジェクターが暗転しない）
exec caffeinate -di python3 -m http.server "$PORT" --bind "$BIND"
