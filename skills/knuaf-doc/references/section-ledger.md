# 정본과 절 원장

`project.json`이 기계 판정 정본이다. sources/facts/sections/questions/tasks/reviews/rules/approvals/outputs 컬렉션을 사용한다. 원답변·원문 파일은 출처 위치와 해시로 연결한다. 출처 ID·권한·물리 페이지·재검토 예외는 [source-contract.md](source-contract.md)에 정의한다. 상태판·가정표는 보기이며 정본 대신 편집하지 않는다.

## 작업폴더 구성

`gg.py init`이 만드는 구조다. 여기 없는 원장 파일을 새로 만들지 않는다.

| 경로 | 내용 | 누가 쓰나 |
|---|---|---|
| `project.json` | 기계 판정 정본. 모든 컬렉션 | `gg.py apply`만 |
| `.gg-lock/owner.json` | 쓰기 잠금. pid·host·token·획득 시각 | 잠금 관리자 |
| `.gg-observations/` | 검토 관측 기록 (`observe` 명령) | `gg.py observe` |
| `.venv/` | 프로젝트 전용 실행환경 | `gg_deps.py ensure` |
| `sections/*.md` | 절 본문. DRAFT 경계 안쪽만 편집 대상 | 작성자 |
| `sources/` | 원답변·학교 원문·참고자료 원본 | 작성자 (읽기 전용 보존) |
| `sources/extracts/` | 실제로 읽은 자료의 발췌본 | 자료 담당 |
| `sources/guidelines/inventory.json` | 학교 지침 항목 목록 | `gg_guidelines.py` |
| `audit/model-routing/` | 위임 호출 기록 (요청/실효 모델 구분) | 메인 |
| `migration/revision-N.json` | 이전 정본 스냅샷 | `apply`가 자동 |
| `migration/original-sections/`, `comparison.json`, `inputs.json` | 가져오기 보존본과 대조 결과 | `gg.py import` |
| `build/<개정>/<종류>/` | 발행 산출물과 `manifest.json` | `gg.py export` |
| `build/검토전_본문.md`, `검토전_논문.docx`, `검토전_재무.xlsx` | 저수준 생성물 (검토 전) | 생성 스크립트 |

`audit/model-routing/`의 기록은 감사 증거이며 `project.json`의 품질 상태를
대신하지 않는다. 기록된 문자열 자체는 승인 근거가 아니다.

기존 절 원장에 STATUS, INPUT, RESEARCH, FACTS, DRAFT, OPEN 블록이 있으면 보존한다. 상태·적용 여부의 정본은 project.json이며, 이 블록의 유무나 체크 표시만으로 준수를 판정하지 않는다. 편집 본문은 다음 명시적 경계 안에 둔다. 내부 Markdown 제목은 본문을 끊지 않는다.

```text
## DRAFT
<!-- gg:draft:start -->
실제 본문
<!-- gg:draft:end -->
## OPEN
```

절 상태는 empty/drafting/review_ready이며 승인 상태와 다르다. 병합은 명시적 order 순서로 DRAFT만 가져온다. 표·그림 번호와 최초 학명은 최종 본문 전역에서 검사한다.

각 절과 제출 표는 `project.json.tasks`의 작업 기록(`task_id`, `source_refs`, `table_refs`, `action`, 필요 시 `reason`)을 하나 이상 연결한다. 규칙·사실·작업 원장을 Markdown에 다시 정의하지 않는다. 양식 항목을 본문에 맞게 보완한 경우에도 작업 기록에 이유를 남긴다.

문체 선택·서술 설계 메모는 별도 원장이나 승인 체계로 만들지 않는다. [narrative-expansion.md](narrative-expansion.md)의 답변 카드와 서술 설계는 기존 fact/source ID와 작업 기록에 연결한 형태로 읽는다. 판정 상태는 `project.json`이 소유한다.

## 저장

`gg.py apply <폴더> --change <변경.json> --expected-revision N`으로 저장한다. 변경 객체는 request_id와 ops 배열을 가지며 각 op는 collection/value다. 동일 요청의 동일 내용은 한 번만 반영하고 충돌 요청·낡은 개정·기존 잠금은 거부한다. 이전 정본은 migration/revision-N.json에 남고 정본은 임시파일 fsync 후 원자적으로 교체한다. 정본에는 `project_id`(init 시 생성)와 `parent_hash`(직전 정본 해시)가 기록되어 갈라진 사본을 구분한다. `gg.py history <폴더>`는 스냅샷 목록과 해시 일치 여부를 보여주고, `gg.py restore <폴더> --revision N --expected-revision M`은 스냅샷을 새 개정으로 되돌린다(현재 상태를 먼저 스냅샷으로 저장하며 절 파일·원문·build/는 건드리지 않는다).

현재 코어는 외부 편집 파일의 해시를 감지한다. 원문·DRAFT 파일 자체의 편집은 정본 트랜잭션과 별도이므로 단일 파일쓰기 주체를 유지하고 버전 파일을 먼저 저장해 등록한다. 불완전한 작업은 자동 승인하지 않는다.

잠금이 남으면 `gg.py doctor`(또는 `lock-info`)로 소유 기록을 확인한다. 소유 기록에는 pid·host·token·획득 시각이 있다. 살아 있는 작성자의 잠금을 삭제하지 않는다. `gg.py unlock <폴더>`는 같은 기기이고 소유 프로세스가 종료된 경우(`verdict: stale_releasable`)에만 해제하며, 다른 기기의 잠금·실행 중인 잠금·소유 기록이 없거나 손상된 잠금은 보존하고 거부한다. 임시파일·이전 개정·현재 정본을 대조하고 사용자의 원문을 보존한 뒤 복구한다. 자동 잠금 탈취는 하지 않는다.

`submission_candidate` 후보의 잠금은 PID뿐 아니라 호스트·획득별 토큰과 디렉터리 식별자를
대조한다. 교체되거나 소유 기록이 불명확한 잠금은 보존한다. 소유 기록
작성은 기존 원자적 쓰기를 사용하며 실패 시 자기 임시파일과 빈 잠금
디렉터리를 정리한다. 소유 파일 해제는 획득한 디렉터리 핸들에 묶는다(POSIX). Windows에는 디렉터리 핸들 기반 API(`dir_fd`)가 없어 경로 기반으로 동작하며, 심볼릭 링크·정션을 거부하고 각 단계 전후로 디렉터리 식별자를 다시 비교하는 약한 보장으로 대체한다. 하드링크를 지원하지 않는 볼륨(exFAT·일부 네트워크 드라이브)에서는 발행 파일을 원자적 복사로 대신하고 해시를 재검증한다.
강제종료 후 남은
잠금은 자동 해제하지 않는다(사용자가 `unlock`을 명시적으로 실행해야 한다). 이 기록은 악의적인 동등 권한 사용자의
파일 위조를 막는 인증 수단이 아니다.

외부 작업 결과의 변경 객체에는 `result_of`를 기록한다. `task_id`는
제품 작업 ID이며, `epoch`, `external_task_id`, `input_revision`은 해당
작업의 `execution` 기록과 같아야 한다. `execution.status=running`인
관측된 실행만 반영한다. 취소·미관측·이전 실행 결과는 현재 개정번호를
제시해도 거부한다. 이 메타데이터를 실제 실행에 연결하는 책임은 실행
어댑터에 있으며, 일반 수동 apply를 외부 실행 증명으로 취급하지 않는다.
재개 시 외부 호출을 자동 재발행하지 않는다.

`epoch`는 1 이상의 정수이고 `input_revision`은 0부터 현재 개정까지의
정수다. bool·null을 정수로 인정하지 않는다. 외부 작업 ID는 비어 있지
않은 문자열이어야 하며 원결과와 등록된 실행 양쪽을 검사한다.

## 가져오기·재개

원본과 겹치지 않는 새 폴더에 `gg.py import <원본> --out <새폴더>`를 실행한다. 인터뷰·가정·증거·바이너리 원본과 절 본문의 바이트 해시를 대조한다. 절 원본은 `migration/original-sections/`, 본문 대조는 `migration/comparison.json`, 수치 토큰·미결·중복 ID·잘못된 JSONL·값 충돌·이전 경로는 `migration/inputs.json`에 보존한다. 이전 절대경로를 따라가지 않으며 심볼릭 링크와 모호한 DRAFT 경계는 거부한다.

임시 형제 폴더에서 변환·저장·보존 대조를 마친 뒤 새 폴더를 공개한다. 실패 시 원본을 변경하지 않는다. 프로세스 강제 종료로 `.gg-import-*` 또는 빈 대상 폴더가 남을 수 있으므로 실행 주체·현재 파일을 대조하고 다른 작성자의 폴더를 자동 삭제하지 않는다. 기존 대상에는 덮어쓰지 않고 새로운 경로로 재시도한다.

가져오기 상태는 `preserved_pending_semantic_mapping`이며 사실·검토는 비어 있다. `migration-review` 작업에서 보존된 원답변·가정·증거를 먼저 읽고 단위·기간·충돌을 대조해 정본 사실로 등록한다. 요약의 verified/확정/경험 없음 문자열은 원답변이나 새 승인으로 승격하지 않는다. 의미 매핑은 자동화되지 않았지만 같은 답변을 다시 인터뷰하는 이유가 되지 않는다.

재개는 status → next → 대상 절·관련 원문 순서다. 기계검사만으로 의미 검토를 마쳤다고 표시하지 않는다. 제출 후보는 독립 검토와 파일별 필수 출력 검사를 통과한 현재 버전에만 허용하며 교수 승인은 별도다. `status`의 `user_finish_pending`은 한글 글꼴·여백·페이지 번호·HWP 저장이고, `professor_approval_pending`은 교수 승인 근거 미기록이다. 둘 다 스킬 Ⅰ~Ⅵ·DOCX/XLSX 완료를 막지 않으며 자동 통과하지 않는다.

## 규칙·출력 검사 등록

규칙의 source_refs에는 출처 id, revision, locator가 필요하다. 적용 규칙의 locations는 section_id와 실제 본문 quote를 가진다. applicable=false는 na_reason, depends_on 및 applies_when의 fact_id/revision/operator/value를 등록한다. 현재 조건 연산자는 equals이며 현재 제공된 사실 값과 비교해 조건이 거짓인 경우에만 N/A가 인정된다. 도구가 없거나 사실이 미제공이면 N/A가 아니다.

규칙의 `applies_to`는 적용 대상의 `collection`·`id` 참조 목록이다.
해석 가능한 비어 있지 않은 목록만 지문 범위를 좁힌다. 대상 또는
그 의존성에 해당하는 규칙은 지문에 포함한다. 범위가 없거나 비었거나
참조를 해석할 수 없는 구형 규칙은 전역으로 처리한다. 규칙 ID의 이름은
범위 판정에 사용하지 않는다. 이 필드는 적용 여부의 `applies_when`과
다르며, 기존 학교 규칙을 임의로 비해당 처리하는 수단이 아니다.

rules의 output_formats에는 최종 제출 formats와 source_refs를 기록한다. outputs에는 id, format, path, file_hash, target_refs, input_fingerprint, checks를 기록한다. 출력 target_refs는 모든 절과 사실을 포함해야 하며 fingerprint는 공통 코어로 계산한다. 각 check에는 check_id, status, file_hash, input_fingerprint, evidence_path, evidence_hash가 필요하다. 실제 검사 보고서를 보존한 뒤 등록하며 임의의 pass 문자열로 실행을 대신하지 않는다.

제출 후보 게이트는 독립검토 6종(`content`, `logic`, `calculation`, `docx`, `xlsx`, `render`) 각각에 대해 유효한 검토 기록(다른 검토자, 현재 지문, 해결된 findings)을 요구한다. `logic`은 논증·인과·일관성 검토, `calculation`은 계산 입력·결과 검토, `docx`·`xlsx`·`render`는 각 출력물의 실제 파일·렌더 검토다. DOCX 필수 검사는 structure/font/render, XLSX는 structure/recalculation/crosscheck/render, HWP는 reopen/render/crosscheck다. HWP 필수검사는 사용자 소유(`user_finish`)로 표시하고 스킬 제출 후보 차단에서 분리한다. 글꼴·HWP 도구 부재를 N/A로 바꾸지 않는다. 제출 후보는 검증된 출력 파일을 복사하고 manifest에 해시를 남긴다. 독립 검토 기록이나 출력검사 기록 등록만으로 증거의 진실성을 자동 판정하는 것은 아니므로 원문·전체 페이지에 대한 실제 내용검토가 별도로 필요하다.

전체 지침 목록과 항목별 적용·독립검토 연결은 [guideline-tracking.md](guideline-tracking.md)를 따른다. `output_formats`만 등록된 상태는 전체 학교 지침 적용의 증거가 아니다.

검토의 `provenance_path`·`provenance_hash`는 실행 어댑터가 확보한
`gg-review-observation/1` 기록을 연결한다. 이 기록은 서로 다른
`author_session`·`reviewer_session`, 작성자·검토자 ID, `target_refs`,
`input_fingerprint`, `report_hash`, `observed_by`, 실제 검토한
`review_kinds` 목록을 포함한다. 내용 검토만 관측했다면 계산·렌더
검토로 재사용할 수 없다. 기록이 없거나 맞지 않으면 독립 검토 미확인으로
차단한다. 합성 관측 기록은 인터페이스 시험일 뿐 실제 독립 검토의 증거가
아니다. 현재 배포본에는 관측 기록을 자동으로 만드는 실행 어댑터가 포함되지 않으며, `gg.py observe`는 검토자가 작성한 기록을 등록하는 입구다. 같은 OS 쓰기권한을 가진 사용자의 위조를 막는 인증 경계는 아니다.

## 교수 승인 기록과 발행 충돌

`submission_candidate` 후보의 교수 승인 범위는 `scope=project_outputs`와 유효한 `superseded_by`
계보가 산출하는 현재 출력 집합의 `target_refs`로 명시한다. 유효한 이력
출력은 승인 대상에서 제외하며, invalid 계보나 stale 상태의 현재 출력이
남아 있으면 어떤 승인 기록도 성립하지 않는다. 실제 근거 파일의 `evidence_path`와
`evidence_hash`, 대상의 `input_fingerprint`, 명시적인
`human_confirmation.explicit=true` 및 `confirmed_by` 기록을 대조한다.
`input_revision`은 승인 등록 직전 입력 개정이며 `apply`가
`registered_revision`을 기록한다. 등록 뒤 다른 상태 변경이 있으면
보수적으로 다시 확인한다. 구형 경로 문자열만 있는 승인은 승격하지 않는다.
이 기록은 실제 교수의 신원 인증을 보장하지 않으며 작성자가 대신 만들지 않는다.

이미 완결된 발행 결과는 기존 계약대로 덮어쓰지 않는다. 소유권이
확인되지 않은 미완결 대상도 삭제하지 않고 충돌로 반환한다.
준비본을 검증한 뒤 대상 폴더를 배타적으로 만들고 파일을 덮어쓰기 없이
연결한다. `manifest.json`을 마지막에 발행하여 완결 표식으로 삼는다.

부분 발행의 `.publication.json`은 준비본과 같은 파일 식별자로 연결된
소유 기록이다. 재실행은 이 소유권, 프로젝트 해시, 현재 입력 지문,
준비본의 파일별 해시를 확인한 경우에만 남은 발행을 이어간다.
이미 발행한 파일은 같은 파일인지 대조하고 교체하지 않는다. 복제된
소유 기록·본문 변조·원입력 변경은 보존한 채 거부한다. 잠금 수동
복구와 외부 모델 호출 재발행은 이 기능에 포함하지 않는다.
단순 재실행 성공이나 합성 초안 신호 시험만으로 모든 Office·제출
후보 강제종료 경계가 검증됐다고 표시하지 않는다.

발행(신규 발행과 중단 복구 모두)의 직접 입력 지문은 sources/facts/sections
전부와 `output_lineage`가 유효 history로 판정하지 않은 outputs 전부를
결합한다. current·invalid 출력은 stale·파일명·날짜와 무관하게 직접 입력에
남고, 유효한 계보의 history 출력만 직접 선택에서 빠진다. 직접 입력의
`depends_on`·`target_refs`가 history 출력을 가리키면 지문의 재귀 해석이
그 출력까지 그대로 따라간다 — 직접 선택 제외가 의존 참조의 무시는 아니다.

history 출력의 파일이 없어도 발행은 진행되지만 등록·해시·계보 기록을 지우거나
새 파일로 위장하지 않는다. 과거 바이트를 확보하지 못한 출력은 과거 보관의
한계로 따로 보고하며, 현재 원고·계산·출처에 필요한 파일이면 계속 blocker다.
최신 끝단 누락·변조, stale만인 current 누락, invalid 계보, 원자료·절 누락은
기존 검증 그대로 발행을 거부한다.

기존 출력 레코드에 처음 `superseded_by` 이력을 연결하는 메타데이터 전용
갱신은 `apply`의 전용 경로로만 받는다. 서버가 관리하는 `revision`과
`superseded_by`를 제외한 모든 필드·키 존재가 저장 레코드와 같아야 하며,
id/path/format/file_hash/target_refs/input_fingerprint/checks/stale를 숨겨
바꾸는 면제는 없다. 기존 링크가 있는 레코드의 재연결·해제와 다른 필드를
함께 바꾸는 갱신·신규 등록은 이 경로를 쓰지 않고 기존 엄격 검증을 그대로
받는다. 원 출력 파일이 존재하면 등록 해시와 실제 바이트가 같아야 하고,
파일 부재만 기존 유실로 허용하며 원 path/hash와 유실 사실은 보존한다.
루트 밖 경로·읽기 오류·다른 바이트를 유실로 바꾸지 않는다. 연결 대상은
현재 정본에 있고 같은 형식이며 유효한 계보 체인을 이루어야 한다 — 자기
참조·순환·대상 부재·형식 불일치·stale 끝단은 거부다. 체인 끝단은 저장된
stale 표시를 믿지 않고 실제 target_refs로 계산한 입력 지문이 등록값과
같고 실제 파일이 등록 해시와 일치해야 한다. 같은 요청의 뒤 변경이나
stale 재계산이 끝단을 무효화하면 기록 전 최종 상태에서 요청 전체가
거부되며, 이미 있던 무관한 invalid는 유지하되 이 연결로 다른 출력이 새로
invalid가 되는 것은 허용하지 않는다. 이력 연결은 검토·출력의 현재성
세탁이 아니며 필수 gate·검토 무효화는 계속 작동한다.
