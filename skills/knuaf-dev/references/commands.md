# 명령 목록

**구현 파일을 열지 말 것.** `gg_core.py` 는 2,957줄이고 전부 읽으면 맥락이 3만 토큰
넘게 찬다. 명령 표면은 이 문서가 전부 담는다. 여기 없는 것은 `--help` 로 확인한다.

## 실행

```
<파이썬> <스킬>/scripts/gg.py <명령> <폴더> [옵션]
```

- `<파이썬>`: `scripts/gg_deps.py python <폴더>` 가 가리키는 인터프리터. 최소 3.10
  (3.9 이하면 `gg.py` 가 `{"status":"blocked"}` 를 찍고 종료 2).
- `<폴더>`: 작업폴더 절대경로. 모든 명령의 첫 위치 인자다.
- 출력은 항상 JSON 한 덩어리(`indent=2`). 실패도 JSON 이다.
- 종료 코드: `0` 정상 · `1` `check` 가 막는 항목을 찾음 · `2` 거절(`{"status":"blocked","reason":…}`).

## gg.py 명령

| 명령 | 필요한 옵션 | 하는 일 · 돌려주는 것 |
| --- | --- | --- |
| `init` | — | `project.json` 과 자기 하위 폴더만 만든다. 기존 파일은 건드리지 않아 학생 자료가 든 폴더에도 그대로 쓴다. |
| `doctor` | — | 설치·의존성·잠금 진단. `lock.verdict` 가 `stale_releasable` 이면 `unlock` 가능. 탐지일 뿐 기능 시험이 아니다. |
| `import` | `--out <새폴더>` | 기존 폴더를 새 폴더로 가져온다. 원본은 그대로. 수치·미결·중복·충돌은 `migration/inputs.json` 에 남고, 뒤이은 `check` 가 `migration-review` 항목을 낸다. |
| `status` | — | `{revision, checks, tasks, completion, skill_ready, guideline_ready, user_finish_pending, professor_approval_pending}`. 한 번에 현재 상태를 본다. |
| `next` | — | 다음에 할 작업 목록만. |
| `check` | `--scope all\|submission` | 검사 결과 배열. `submission` 은 제출후보 관문(`gate`). 막는 항목이 있으면 종료 1. |
| `apply` | `--change <JSON경로>` `--expected-revision N` | 정본을 바꾸는 유일한 길. 아래 계약을 따른다. |
| `export` | `--kind draft\|review\|submission_candidate` | 산출물을 뽑는다(기본 `review`). `{"path": …}`. |
| `question` | `--field <필드ID>` | `{action: ask\|help\|hold, field, notice}`. 질문 1회·도움 1회 뒤에는 그 작업만 보류된다. 호출 자체가 시도 횟수를 정본에 올린다. |
| `bundle` | `--scope <절ID>` | 한 절의 검토 꾸러미(절 본문·원자료·사실·규칙·지문·검토축·필수 발견항목). |
| `paper` | `--input <논문입력JSON>` `[--out]` `[--body <본문MD>]` | 학교 양식 본문을 만든다. 기본 출력 `build/검토전_본문.md`. **기존 산출물은 덮어쓰지 않는다**(있으면 거절). `--body` 를 주면 앞머리만 생성하고 Ⅰ–Ⅵ 골격은 쓰지 않는다. |
| `observe` | `--input <관측JSON>` `--observer <ID>` | 외부 검토 관측을 등록한다. |
| `lock-info` | — | 현재 잠금 상태. |
| `unlock` | — | 잔류 잠금 해제(`doctor` 가 `stale_releasable` 일 때만). |
| `history` | — | 정본 스냅샷 목록. |
| `restore` | `--revision N` `--expected-revision M` | 이전 스냅샷을 **새 개정으로** 되돌린다. 절 파일·`build/` 는 건드리지 않는다. |

## apply 변경 JSON

```json
{
  "request_id": "<이 변경을 가리키는 고유 문자열>",
  "ops": [ { "collection": "<아래 목록 중 하나>", "value": { "id": "<빈 문자열 아님>", … } } ]
}
```

- `--expected-revision` 이 현재 개정과 다르면 `개정 충돌` 로 거절한다. 최신 정본을 다시
  읽고 다시 만든다.
- 같은 `request_id` 를 같은 내용으로 다시 보내면 조용히 통과한다(재시도 안전). 내용이
  다르면 `동일 요청 ID의 내용 충돌` 로 거절한다.
- `collection` 은 이 아홉 중 하나다:
  `sources` · `facts` · `sections` · `questions` · `tasks` · `reviews` · `rules` ·
  `approvals` · `outputs`
- `value.id` 는 비어 있지 않은 문자열. 개정 번호는 앱이 매긴다(직접 넣지 않는다).
- 작업 결과로 넣을 때는 `result_of: {task_id, external_task_id, epoch, input_revision}`
  가 필요하고, 그 작업이 선언한 대상 밖은 바꿀 수 없다.
- 질문을 다시 여는 변경(`questions` 의 `decision_revision` 이 오름)에는
  `resume_reason` (`new_evidence` · `user_change` · `explicit_resume`) 과 실재하는
  `source_ref` 가 있어야 한다.

## check 결과 한 항목

```json
{ "check_id": "...", "target": "...", "status": "pass|fail|blocked",
  "severity": "error|warning", "reason": "...", "evidence": [],
  "owner": "skill|user|professor", "required_for": ["submission_candidate"],
  "input_revision": 19, "checker_version": "..." }
```

- `status`: `fail` 은 대조해서 틀렸다는 뜻이고, `blocked` 는 **대조할 수 없었다**는 뜻이다.
  둘을 섞지 않는다.
- `owner` 가 `user`·`professor` 인 항목은 스킬이 통과시킬 수 없다.
- 종료 코드 1 은 `severity: error` 이면서 `status != pass` 인 항목이 있을 때다.

## 다른 스크립트

필요할 때만 부른다. 전부 `--help` 가 있다.

| 스크립트 | 쓰는 자리 |
| --- | --- |
| `gg_deps.py` | 의존성 진단, 프로젝트 전용 venv 준비, 쓸 파이썬 경로 |
| `gg_kordoc.py` | HWP → 마크다운 (Kordoc 준비 포함) |
| `gg_office.py` | macOS·Windows Office 변환(DOCX·XLSX → PDF). `jobs`·`clean --job` 으로 작업영역 정리 |
| `build_docx.py` | 마크다운 → DOCX 미리보기 |
| `merge_sections.py` | 절들을 검토 꾸러미로 합치기 |
| `gg_school_paper.py` | 학교 Ⅰ–Ⅵ 본문 생성(= `gg.py paper` 가 부르는 것) |
| `gg_frontmatter.py` · `gg_frontmatter_layout.py` | 겉표지·표제면·제출서·인준서·목차 |
| `gg_school_excel.py` · `gg_school_verify.py` | 학교 17시트 재무 양식 생성·재계산 검증 |
| `gg_excel_template.py` · `gg_excel_fill.py` · `gg_excel_formula_patch.py` · `gg_excel_print.py` | 원본 양식 조사 → 빈 사본 → 셀 채우기 → 수식·인쇄 배치 |
| `gg_finance.py` | 단일 작목 연간 현금주의 재무 계산 |
| `gg_guidelines.py` | 학교 작성지침 대조(원문 근거 없으면 확정하지 않음) |
| `gg_school_format.py` · `lint_format.py` | 서식 검사(신명조·여백·쪽번호 등) |
| `lint_evidence.py` | 증거 검사 |
| `show_research.py` | "이 수치 어디서 나왔나" 에 근거 제시 |
| `gg_document.py` | 지원하는 마크다운 범위(제목·문단·표·이미지·강조) |
