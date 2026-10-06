#!/bin/bash
# 断点续传循环：每次重新取签名 URL（GitHub 重定向地址有效期短），带 -C - 续传
OUT=deliverables/ximo-os-image/ximo-os-0.1-raw.zip
TOKEN=$(gh auth token)
TARGET=380580134   # 压缩后工件字节数（gh api 实测）
for i in $(seq 1 40); do
  cur=$(stat -c %s "$OUT" 2>/dev/null || echo 0)
  if [ "$cur" -ge "$TARGET" ]; then echo "DONE size=$cur"; exit 0; fi
  AID=$(gh api repos/ximo888ok-netizen/ximo-Agent/actions/artifacts --jq '.artifacts[]|select(.name=="ximo-os-0.1-raw" and (.size_in_bytes<400000000))|.id' 2>/dev/null | head -1)
  [ -z "$AID" ] && { echo "no artifact id"; sleep 10; continue; }
  LOC=$(curl -s -o /dev/null -w '%{redirect_url}' -H "Authorization: Bearer $TOKEN" "https://api.github.com/repos/ximo888ok-netizen/ximo-Agent/actions/artifacts/$AID/zip")
  [ -z "$LOC" ] && { echo "no signed url"; sleep 10; continue; }
  curl -fL -C - --retry 3 --retry-delay 2 --retry-all-errors -m 300 -o "$OUT" "$LOC" >/dev/null 2>&1
  now=$(stat -c %s "$OUT" 2>/dev/null || echo 0)
  echo "attempt $i: $now / $TARGET bytes"
  [ "$now" -ge "$TARGET" ] && { echo "DONE size=$now"; exit 0; }
  [ "$now" -le "$cur" ] && sleep 6
done
echo "INCOMPLETE size=$(stat -c %s "$OUT" 2>/dev/null || echo 0)"
exit 1
