# delegate 운용 계약

이 문서는 `delegate` 명령을 사용할 때의 계약이다 — 위임 방식 자체를 강제하지 않는다. 직접 작업에도 같은 게이트·검토 규칙이 적용된다.

`delegate`는 모델·벤더·CLI·과금 경로를 선택하지 않는다. 호출자가 실행기 wrapper를 `DELEGATE_RUNNER`로, 작성자 식별자를 `DELEGATE_ACTOR_ID`로 넘긴다.

## 경계

- 메인 worktree·보호 브랜치(`PROTECTED_BRANCHES`)·dirty worktree에서는 실행이 차단된다 — 보조 worktree에서만 돈다.
- 스펙에 비밀값·자격증명을 섞지 않는다. egress 전 시크릿 스캔(`SECRET_SCAN_CMD`)이 게이트다.
- 전수 게이트 없이 실행하지 않는다 — `.harness.conf`의 `HARNESS_GATE`(또는 TYPECHECK+TEST+LINT 자동 합성)나 `DELEGATE_GATE`가 필요하다. 없으면 fail-closed로 중단된다.
- 실행 실패 후 다른 실행기·과금 경로·인증정보로 자동 대체하지 않는다.
- 실패 산출물을 자동 삭제하거나 강제 초기화하지 않는다 — 동결된 변경은 그 자리에 보존되고 처분은 사용자가 결정한다.
- 위임 작성자와 같은 ID로 최종 검토 도장을 발급하지 않는다.

## 실행기 계약

- 실행기는 하나의 실행 가능한 wrapper다. 현재 디렉터리는 격리 worktree다.
- 완성된 작업 지시는 표준입력(stdin)으로 받는다.
- 결과 파일은 worktree에 남기고, 상태와 진단은 표준출력·표준에러로 낸다.
- 하네스는 실행기의 내부 모델·도구·추론 강도·재시도 정책을 해석하지 않는다.
- OS 격리는 필수다 — macOS `sandbox-exec`, Linux `bwrap`. 백엔드 부재·거부는 실행 전 차단이며 비격리 폴백은 없다.

```sh
DELEGATE_RUNNER=/absolute/path/to/runner \
DELEGATE_ACTOR_ID=worker-1 \
delegate --file spec.md
```

exit 코드: `0` 성공 · `2` 가드/사용오류 · `3` 인너 소진 · `4` 전수 백스톱 실패 · `5` 침묵의 가짜성공 — 3·4·5는 산출물을 보존한 채 동결.

성공하면 변경은 staging된 채 worktree에 남는다 — `delegate`는 커밋하지 않는다. 검토 증거는 커밋된 HEAD에 묶인다. 커밋 후 작성자와 다른 검토자가 그 HEAD를 검토하고 설치된 `mark-reviewed` 명령으로 증거를 남긴다.

```sh
mark-reviewed \
  --author-id worker-1 \
  --reviewer-id reviewer-1 \
  --summary "명세 정합성과 경계값 확인"
```
