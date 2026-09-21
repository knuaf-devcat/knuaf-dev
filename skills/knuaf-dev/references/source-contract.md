# 자료 출처 계약

이 문서는 자료를 읽고 본문·표·재무 산출물에 연결하는 공통 계약이다. 파일별 파싱법은 [source-intake.md](source-intake.md), 절 상태와 저장은 [section-ledger.md](section-ledger.md), 제출 템플릿 CLI는 [excel-template.md](excel-template.md)에 둔다. 같은 규칙·사실·진행 상태를 별도 원장에 복제하지 않는다.

## 출처 우선순위와 역할

`project.json.sources[*].id`가 출처의 기계 식별자다. 아래 표의 ID는 현재
`reference-library/sources.json`에 등록된 자료와 맞춘다. 문서에서 `source_id`라고
부르는 경우에도 실제 레코드 키는 항상 `id`로 저장한다.

| id (`project.json`) | 자료 | 허용 역할 | 금지 |
|---|---|---|---|
| `official-writing-guide-pdf` | 2020 학교 공식 작성요령 PDF | **이 2020 판에서만 1–5쪽:** 작성 지침·판정 근거. **6쪽 이후:** 양식·예시 | 페이지 역할을 섞어 규칙을 만들기, 원문에 없는 규칙 보충 |
| `kim-wonseop-exemplar-pdf` | 김원섭 선배논문(교수 강의자료) 지황 PDF | 서술의 깊이·논증 연결·내러티브 품질 벤치마크 | 공식 규칙 우선순위 변경, 학생 사실·가격·연도·근거 복제 |
| `seo-minseo-finance-xlsx` | 서민서 재무 작성예시 XLSX (다른 작성자) | 사용자 제공 재무 작성예시·템플릿. 형식·수식·병합·시트명 보존 | 김원섭 자료와 같은 작성자라고 추정, 값·학생 정보 복제 |

공식 PDF와 교수 지시가 충돌하면 해당 페이지와 지시를 함께 기록하고 교수의 현재 지시를 우선한다. 이 2020 PDF의 1–5쪽 지침과 6쪽 이후 양식·예시는 각각 `authority`를 다르게 기록한다. 다른 연도·개정판 PDF에 이 페이지 분할을 자동 적용하지 않는다. 새 원본은 해시와 실제 페이지를 먼저 등록하고, 그 판의 규칙 위치를 다시 매핑한다. 김원섭 선배논문은 교수 강의자료라는 맥락을 기록하되 공식 규칙을 덮어쓰지 않는다. 서민서 XLSX는 템플릿이 제공되면 새 17시트를 처음부터 재조립하지 않고 복제한 뒤 명시된 입력 셀만 비운다.

### 현재 2020 자료의 판정 경계

`official-writing-guide-pdf`의 SHA-256은
`f60b58b7dcde86eab9f273dd50114ac296d009bd60abb940aaa866a54e866de2`이고 물리
페이지는 26쪽이다. 이 레코드에서만 1–5쪽을 텍스트로 확인한 작성 지침,
6–26쪽을 렌더로 확인한 표지·표·본문 양식·예시로 나눈다. 해시가 다르거나
페이지 수가 다른 PDF는 새 `revision`과 새 `physical_pages`를 등록한 뒤 규칙을
다시 검토한다.

## 출처 레코드

기계 판정 정본은 작업폴더의 `project.json` 하나다. `sources` 레코드에는 최소한 다음을 둔다.

아래는 코어 필드 형태를 보인 예시이며 꺾쇠표시 값은 `apply` 전에 실제
작업폴더 레코드·해시·fingerprint로 치환한다.

```json
{
  "id": "official-writing-guide-pdf",
  "kind": "official_pdf",
  "authority": "official_instruction",
  "path": "sources/official-writing-guide.pdf",
  "hash": "…",
  "revision": 1,
  "physical_page_count": 26,
  "physical_pages": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
    14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26],
  "extract_path": "sources/extracts/official-writing-guide-p1-5.md",
  "extract_scope": "physical-pages:1-5",
  "read_method": "pdf-text-plus-visual",
  "limits": "표·쪽 배치는 원본 렌더로 확인"
}
```

`path`는 작업폴더 기준 상대경로를 사용한다. 개인 절대경로는 문서·패키지에 넣지 않는다. 파일을 교체하거나 원본 해시가 달라지면 새 `revision`을 만들고 영향을 받는 절·표·출력을 다시 검토한다. 물리 페이지(`physical_pages`)와 발췌 범위를 생략하지 않는다.

## 페이지·절·표 작업 기록

`project.json.tasks`에 자료를 읽고 적용한 단위를 기록한다. 절 원장에는 같은 내용을 복제하지 말고 `task_id`와 source ID만 연결한다.

```json
{
  "id": "task-III-2-20260906-01",
  "section_id": "III-2",
  "source_refs": [
    {"id": "official-writing-guide-pdf", "revision": 1, "locator": "physical-pages:4-5"}
  ],
  "table_refs": ["table-investment-01"],
  "action": "apply",
  "adaptation": "본문 사례를 현재 농장 계획에 맞게 재서술",
  "reason": "공식 양식의 항목은 유지하되 학생 고유 사실은 별도 입력"
}
```

각 절·각 제출 표에는 최소 하나의 작업 기록이 있어야 한다. 원문 양식의 항목·표 구조를 바꾼 경우 `action: "adapt"`와 짧은 `reason`을 남긴다. 내용상 보완은 가능하지만 근거·규칙·수치의 출처를 바꾸지 않는다.

표지와 표의 항목·배치는 원문 양식을 가깝게 따른다. 본문 문장과 사례는
현재 계획에 맞게 소폭 보완할 수 있으며, 그때도 `action: "adapt"`와 보완
이유를 해당 task에 남긴다.

## 엑셀 map·receipt 연결

`gg_excel_template.py`의 `source-map.json`, `inspect-report.json`, blank-copy
receipt는 실행 증거 파일이다. 이 파일들이 `project.json`을 대신하는 별도
정본이 되지 않도록, 생성 직후 `project.json.outputs`에 상대경로와 해시를
등록하고 `source_refs`로 템플릿 출처와 revision, 실제 시트·셀 범위를 연결한다.
blank workbook도 같은 outputs 기록에 포함한다.

CLI가 호환성을 위해 map/receipt의 `source.sha256` 키를 쓸 수 있지만,
`project.json.sources[*].hash`가 canonical source hash다. 등록 시 다음처럼
어댑터를 거쳐 같은 값을 비교한다.

`outputs` 레코드는 [section-ledger](section-ledger.md)의 필수 필드
`id`, `format`, `path`, `file_hash`, `target_refs`, `input_fingerprint`,
`checks`를 따른다. `target_refs`는 코어가 요구하는
`{"collection":"sections|facts", "id":"실제 레코드 ID"}` 객체의 배열이어야
하며, 꺾쇠표시 예시나 task 문자열을 그대로 넣지 않는다. map·receipt 증거의
`format`은 최종 제출 형식이 아니므로, 해당 재무 task와 실제 절·사실을
연결한 뒤 파일·해시·검사 결과를 등록한다.

같은 실행을 재무 절에 적용했다면 `tasks`에도 연결한다. 예를 들어
`task-IV-xlsx-template-20260906-01`의 `source_refs`는
`seo-minseo-finance-xlsx`의 실제 revision과 시트·셀 locator를 가리키고,
`outputs`에는 map·receipt·blank workbook의 각 상대경로·파일 해시를 등록한다.
`target_refs`는 코어가 요구하는 `{collection, id}` 형식의 실제 `sections`·
`facts` 레코드로 채우며, task 연결은 `source_refs`와 task의 별도 기록으로
남긴다. 검사 증거는 `checks`의 `evidence_path`와 `evidence_hash`로 연결한다.
이전 receipt의 `status`를 읽어 현재 task나 output의 상태를 직접 덮어쓰지 않는다.

```json
{
  "id": "task-IV-xlsx-template-20260906-01",
  "section_id": "IV",
  "source_refs": [
    {"id": "seo-minseo-finance-xlsx", "revision": 1,
     "locator": "sheets:17;mapped-cells:explicit-inputs"}
  ],
  "table_refs": ["finance-template-01"],
  "action": "apply",
  "reason": "원본 시트·수식·서식·병합을 보존하고 매핑된 입력 셀만 비움"
}
```

최신 receipt가 실제 파일 해시와 검사 결과로 확인되면 그 output만 현재
후보로 남긴다. 과거 output은 삭제하지 않고 `superseded_by`를 가진 이력으로
보존한다.

`source.path`·`output.path`와 등록된 `outputs.path`에는 작업폴더 기준 상대경로만
남긴다. 현재 CLI가 원시 map/receipt 안에 절대경로를 쓸 수 있으므로,
`project.json`에 apply하기 전에 경로를 상대경로로 정규화하고 원시 파일을
문서·패키지에 복사하지 않는다. 이 경로 정규화는 계약상 필수 동작이며 현재
CLI의 모든 버전에서 자동으로 보장되는 기계 게이트라고 주장하지 않는다.
map/receipt의 `partial` 또는 `blank_template`은 당시 실행의
사실일 뿐 현재 상태 도장이 아니다. 이후 더 최신 receipt가 생성되면 이전
receipt는 `superseded`로 history에 보존하고 현재 판정에서 제외한다. 상태를
바꾸려면 실제 파일·해시·검사 결과를 확인한 새 apply 기록이 필요하다.

## 보존·검증 경계

- 원본 PDF/XLSX와 학생 답변은 읽기 전용으로 보존한다. 발췌본은 `sources/extracts/`에 추가하고 원본을 덮어쓰지 않는다.
- 발췌본이 있으면 같은 범위를 다시 파싱하지 않는다. 다만 (a) 원본 시각 검증이 필요하거나 (b) 원본 해시·페이지·추출 방법이 바뀌었거나 (c) 발췌 한계로 표·병합·각주를 판정할 수 없으면 원본을 다시 열 수 있다. 이때 기존 발췌본을 덮어쓰지 말고 새 revision과 보완 범위를 기록한다.
- XLSX 템플릿 복제는 제출 산출물 생성 단계의 통제된 읽기다. 원본 템플릿에 쓰지 않으며, 입력 셀 매핑·삭제 목록·복제 후 해시를 기록한다.
- 패키지에는 코드와 이 휴대용 계약만 넣는다. 실제 학교 파일, 선배 PDF, 학생 재무, 발췌 원자료는 넣지 않는다.

런타임은 `<workspace>/sources`와 `project.json.sources[*].id`·`hash`·물리 페이지를
사용한다. 사용자 컴퓨터의 절대경로나 특정 학교 파일명을 가정하지 않는다.

지침 전체 목록의 출처·적용·검토 연결은 [guideline-tracking.md](guideline-tracking.md)에 정의한다. 출처 인덱스나 페이지 카드는 찾기 위한 보기이며, 현재 파일은 project.json의 등록 경로와 해시로 선택한다.
