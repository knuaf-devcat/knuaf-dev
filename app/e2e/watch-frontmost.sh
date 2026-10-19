#!/usr/bin/env bash
# e2e 를 도는 동안 맥 화면의 '맨 앞 앱'과 '화면에 창이 있는 앱(창 소유자)'을 0.5초 간격으로 한 줄씩
# 남긴다. 숨김 실행(KNUAF_E2E_HIDDEN=1)이 화면을 건드리지 않았는지 나중에 기록으로 증명하는 관측
# 장치다. macOS 전용 — 윈도우에서는 돌지 않는다(REPORT-HIDDEN '윈도우 영향' 참고).
#
#   app/e2e/watch-frontmost.sh <기록 파일> [초]
#
# 맨 앞 앱은 System Events 의 frontmost(창을 맨 앞으로 올리는 spec 과 같은 잣대)로, 화면에 보이는
# 창은 CoreGraphics 의 CGWindowList(on-screen, layer 0 = 앱 창)로 읽는다. CGWindowList 는 앞→뒤
# 순서라 `onscreen` 의 첫 항목이 맨 앞 창의 소유자다. 창을 하나하나 열거하는 System Events 의
# `windows` 는 접근성 권한을 요구해 쓰지 않는다 — 이 스크립트는 권한 없이 돈다.
#
# 이름만으로는 부족하다: 같은 기계에서 다른 워크트리(p2)의 e2e 도 'Electron' 이라는 이름으로 창을
# 띄운다(실측 16:27). 그래서 창 소유자와 맨 앞 앱을 모두 `이름#pid` 로 적고, 이 워크트리의 e2e 가
# 띄운 Electron 본체 pid 를 `mine=` 에 같이 적어 둔다 — 겹치는 pid 가 위반이다.
# (System Events 의 `visible` 은 쓰지 않는다. 창을 한 번도 띄우지 않은 프로세스도 뜨고 pid 로
#  귀속할 수도 없어, 딴 워크트리의 Electron 과 우리 앱을 구분하지 못한다.)
#
# 세 조회를 동시에 띄운 뒤 0.5초를 채우므로 간격은 실질 0.5초다. 조회가 0.5초를 넘기면 그만큼
# 늘어난다 — 기록 파일 끝의 samples/elapsed 로 확인한다.
set -u

out=${1:?사용: app/e2e/watch-frontmost.sh <기록 파일> [초]}
limit=${2:-0}
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
pattern="$root/app/out/main/index.js"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

exec >>"$out" 2>&1
echo "# 시작 $(date '+%F %T') 간격목표=0.5s 상한=${limit}s 우리앱=${pattern}"
SECONDS=0
n=0
while :; do
  n=$((n + 1))
  # 1) 맨 앞 앱의 이름#pid
  osascript -e 'tell application "System Events"
set p to first application process whose frontmost is true
return (name of p) & "#" & (unix id of p)
end tell' >"$tmp/front" 2>/dev/null &
  front=$!
  # 2) 화면에 보이는 앱 창의 소유자(이름#pid), 앞→뒤 순서
  osascript -l JavaScript -e '
ObjC.import("CoreGraphics");
function run(){
  var info=$.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly|$.kCGWindowListExcludeDesktopElements,$.kCGNullWindowID);
  var n=$.CFArrayGetCount(info), seen=[], out=[];
  for(var i=0;i<n;i++){
    var d=ObjC.castRefToObject($.CFArrayGetValueAtIndex(info,i));
    if(ObjC.unwrap(d.objectForKey("kCGWindowLayer"))!==0) continue;
    var o=ObjC.unwrap(d.objectForKey("kCGWindowOwnerName"))+"#"+ObjC.unwrap(d.objectForKey("kCGWindowOwnerPID"));
    if(seen.indexOf(o)<0){seen.push(o); out.push(o);}
  }
  return out.join(",");
}' >"$tmp/win" 2>/dev/null &
  win=$!
  # 3) 이 워크트리의 e2e 가 띄운 Electron 본체 pid — 딴 워크트리(p2)의 Electron 과 구분한다
  ps -ax -o pid=,command= >"$tmp/ps" 2>/dev/null &
  psp=$!
  sleep 0.5
  wait "$front"; frc=$?
  wait "$win"; wrc=$?
  wait "$psp"; prc=$?
  # 조회가 실패했거나 빈손이면 그 표본을 숨기지 않고 ERR 로 남긴다 — 분석기가 위반 0 과 섞지 않도록.
  f_val=$(tr -d '\r\n' <"$tmp/front")
  w_val=$(tr -d '\r\n' <"$tmp/win")
  m_val=$(awk -v p="$pattern" 'index($0, p) { print $1 }' "$tmp/ps" | tr '\n' ',')
  [ "$frc" -eq 0 ] || f_val=ERR
  [ "$wrc" -eq 0 ] || w_val=ERR
  [ "$prc" -eq 0 ] || m_val=ERR
  [ -n "$f_val" ] || f_val=ERR
  [ ! -s "$tmp/ps" ] && m_val=ERR
  # onscreen 은 빈 목록이 정상일 수 있다(화면에 앱 창이 하나도 없음) — 실패는 종료 코드로만 판정한다.
  printf '%s\tsample=%d\tfront=%s\tonscreen=%s\tmine=%s\n' \
    "$(date '+%H:%M:%S')" "$n" "$f_val" "$w_val" "$m_val"
  if [ "$limit" -gt 0 ] && [ "$SECONDS" -ge "$limit" ]; then break; fi
done
echo "# 끝 $(date '+%F %T') samples=${n} elapsed=${SECONDS}s"
