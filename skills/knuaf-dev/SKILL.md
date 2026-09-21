---
name: knuaf-dev
description: >-
  한국농수산대학교(한농대·KNUAF) 창업논문·영농계획서와 동반 재무자료(XLSX·DOCX)를 학교
  원문에 따라 작성·검토한다. "시작하기", "이어서 하기", "고칠 부분 보기" 요청이나 창업논문·
  영농계획서·농업경영계획·졸업논문 재무계획 작업에 사용한다. Also use for KNUAF / Korea
  National University of Agriculture and Fisheries startup thesis, farm business plan,
  or farm financial-plan workbook work. 기존 답변과 원고를 보존하고 사실·목표·가정·계산을
  구분하며, 가능한 작업부터 진행한다. 일반 학술논문이나 정부지원 창업사업계획서(PSST)에는
  사용하지 않는다.
version: 0.1.0
license: MIT
---

# 창업논문 작성·검토

한 작업폴더에서 처음 응답할 때 아래 제작자 표시를 한 번 보여주고 도구 이름과 저장 위치를 알린다. 이어지는 세션에서 정본이 이미 있으면 다시 보여주지 않는다. 논문·엑셀 본문이나 학생 저자란에는 넣지 않는다.

> KNUAF-Dev · 창업논문 작성 도우미
> prod. 특용작물전공 24학번 김대욱 · 산업곤충전공 24학번 이준재

첫 사용에는 [문서 읽기 준비](references/parser-setup.md)에 따라 지금 쓸 수 있는 파싱 MCP·스킬·플러그인·CLI를 먼저 확인한다. 읽을 수 있는 기존 도구를 재사용하고, 없거나 기능이 부족할 때만 Kordoc을 자동 준비한다. 도구 선택·설치 명령을 학생에게 맡기지 않는다. 설치 준비는 작성 기준 선택과 별개이며, 자료를 자동으로 현재 원고로 채택하지 않는다.

학생에게 JSON·명령어·모델 등급을 배우게 하지 않는다. 현재 구현은 로컬 검토용이다. 스킬이 Ⅰ~Ⅵ 작성·내용검토·수치대조·DOCX·XLSX를 마쳐도 **한글 마무리와 교수 승인은 사용자 일이다.** 전체 수용·독립 내용검토·다른 환경 시험이 끝나기 전에 학교 최종 제출 완료라고 말하지 않는다. 자동 최종 승인은 지원하지 않는다.

## 시작·재개

첫 자료 질문 전에 [현재 작성물 선택](references/intake-selection.md)을 읽는다. 현재 원고·엑셀의 파일명/위치 또는 첨부를 먼저 받고(Q1a), 참고자료 폴더를 따로 받는다(Q1b). 지정한 원고의 현재성·작목/주제·작성 목적을 짧게 확인한 뒤(Q1c) 그 기준으로 간다. **폴더 안에 초안·엑셀·project.json이 있다는 것만으로** 현재 작성물을 고르거나 이어쓰기를 시작하지 않는다. 이미 확인된 선택·없음 답변은 재사용한다.

- **시작하기**: 사용자가 지정한 폴더가 곧 작업폴더다. 그 안에 새 하위 폴더를 만들지 말고 `gg.py init <폴더>`를 실행한다. `init`은 기존 파일에 손대지 않으므로 학생 자료가 든 폴더에도 그대로 쓴다. 원본 학교 지침·학생 답변은 읽기 전용으로 보존한다. 정본이 이미 있으면 "이어서 하기"로 간다.
- **이어서 하기**: `status`와 `next`를 실행하고 현재 정본·대상 절을 읽는다. 작성 대상 폴더에 `project.json`이 없으면 원본을 그대로 둔 채 `import <기존폴더> --out <새폴더>`를 쓴다. 가져온 뒤 `check`가 내는 `migration-review`(명령이 아니라 검사 ID다)를 따라 **보존된 원답변부터 대조해** 사실을 등록한다. 재인터뷰하거나 기존 검증을 자동 승격하지 않는다.
- **고칠 부분 보기**: `check`의 위치별 결과와 내용검토 결과를 구분해 설명한다.
- **검토본 받기**: `export --kind review`. 실제 경로와 미검증 항목을 알린다. 교수 승인으로 표시하지 않는다.

**명령·인자·출력 모양·`apply` 변경 JSON 계약은 [명령 목록](references/commands.md)에 전부 있다. 구현 파일(`scripts/gg_core.py` 등)을 열어 확인하지 않는다** — 2,957줄이라 한 번 읽으면 맥락이 3만 토큰 넘게 찬다. 없으면 `--help`를 쓴다. 명령은 이 스킬의 실제 `scripts/gg.py` 경로와 현재 Python 실행기를 쓰고, 특정 홈 경로나 다른 호스트 설치를 가정하지 않는다.

## 불변 조건

1. 기계 판정 정본은 `project.json` 하나다. 원답변·원문과 절 DRAFT는 파일로 보존하고 ID·위치·해시·개정으로 잇는다. 상태판·가정표·기존 검증 문자열은 승인 근거가 아니다.
2. 미제공·모름·명시적 없음·해당 없음·제공 거부를 합치지 않는다. 사실·관측·목표·가정·계산을 구분한다. 학교 지침이나 가격이 없으면 그 판정만 보류하고 관련 없는 초안은 계속 저장한다.
3. 질문은 field ID와 결정 버전으로 식별한다. 질문 1회 + 도움 1회 뒤에는 그 항목만 보류한다. 표현을 바꿔 횟수를 초기화하지 않는다. 세부는 [mid-work-questions](references/mid-work-questions.md)가 소유한다.
4. 수치·규칙·본문 변경은 의존 검토와 출력을 무효화한다. 계산 오류는 사용자 선택으로 통과시키지 않는다. 적자는 정직하게 서술할 수 있다.
5. 기계검사·내용검토·실제 출력검토·교수 승인은 별개다. 같은 작성자의 자가점검은 독립검토가 아니며, 없으면 보고서 첫 줄에 그 사실을 적는다. `submission_candidate`는 스킬 검사 완료·교수 확인 전이고, 한글 글꼴·여백·페이지 번호·HWP 저장은 `user_finish_pending`으로 남는다. 사용자 미완료가 Ⅰ~Ⅵ 작성과 DOCX/XLSX를 막지는 않는다. 자동 통과·N/A로 바꾸지 않는다.
6. 저수준 DOCX/XLSX는 검토 전이다. 제출 후보에는 현재 입력·출력 해시에 연결된 필수 검사와 증거가 필요하다. 도구 누락·실행 실패·손상·stale은 면제 사유가 아니다. HWP 제출이면 저장 후 재열기·렌더·표/인용/핵심 수치 대조가 필요하고, 그 확인은 사용자 소유다.
7. 작업은 모델 이름이 아니라 **역할**로 나눈다. 메인은 인터뷰·판단·통합, 자료 해석·출처 정리·학교 지침 대응·장별 초안·윤문은 자료 담당, 단순 추출은 로컬 도구. 독립 내용검토는 그 글을 쓰지 않은 담당이 한다. 사용자가 지정한 모델·effort가 최우선이고 임의로 낮추지 않는다. **담당에게 실제로 위임하기 직전에** [model-routing](references/model-routing.md)을 읽는다 — 담당을 따로 두지 않는 세션에서는 읽을 필요가 없다. 외부 모델·과금 경로를 자동 호출하거나 대체하지 않는다. 담당을 둘 수 없으면 메인이 같은 품질 계약으로 하고 실효 모델을 기록한다. 채팅 전용이면 자동 저장·기계검사·재계산 완료를 주장하지 않고 복사 가능한 인계 묶음을 준다.

## 인터뷰에서 작문으로

문항·되묻기·모름 처리·저장은 [interview-guide](references/interview-guide.md)가, 질문을 화면에 내놓는 형태는 [interview-ui](references/interview-ui.md)가 소유한다.

핵심 프로필이 잡히면 선택 이유·농장명 의미·경영철학·포부를 **작성자가 구성한다.** 인터뷰에 없는 문장이라는 이유만으로 금지하지 않되, 실제 과거 경험·계약·성과·수치의 창작과는 구분한다. 학생 본인의 1인칭으로 쓰고, 본문에서 법적 성명을 화자처럼 반복하지 말고 `본인` 또는 주어 생략을 쓴다. 사용자가 확정한 작목·사업지·규모·시설·운영방식은 **실제 사업계획으로** 서술하며, 증빙 미확보를 이유로 후보·검토 중·미결정으로 되돌리지 않는다.

서술 설계·문단 확장·시각자료 판단·확정 계획 취급·지번 처리는 [narrative-expansion](references/narrative-expansion.md)을 따른다. 내용 확장과 사실 대조를 마친 뒤 [한글 윤문 연결](references/korean-polishing.md)에 따라 `im-not-ai`의 `humanize-korean`을 적용한다.

재무는 제공된 학교 양식에서 어느 시트가 입력이고 어느 시트가 자동계산인지 먼저 확인한다 — [excel-template](references/excel-template.md)의 「입력 시트 역할」. 시트 번호·색을 기억으로 단정하지 말고 실제 시트명·탭 색·원본 해시를 본다.

## 필요한 문서

언제 읽는지만 적는다. 규칙 자체는 각 문서가 소유한다.

| 문서 | 언제 |
| --- | --- |
| [interview-guide](references/interview-guide.md) | 첫 질문 전. Q1~Q8 최소 문항·파생 질문·정본 등록. 문안을 그대로 복사하지 않는다 |
| [interview-ui](references/interview-ui.md) | 질문을 낼 때. 선택형·값 입력형·서술형과 진행 표시 |
| [workflow-order](references/workflow-order.md) | 진행 순서·자료가 부족할 때 |
| [section-ledger](references/section-ledger.md) | 정본·절·저장 |
| [source-contract](references/source-contract.md) | 출처 ID·해시·물리 페이지·작업 기록 |
| [source-intake](references/source-intake.md) | 자료 투입·발췌·재검토 |
| [research-routing](references/research-routing.md) | 가격 외 조사를 시작할 때. 누구에게 맡기는가 |
| [research-sources](references/research-sources.md) | 어느 사이트부터 여는가. 검색엔진부터 시작하지 않는다 |
| [price-research-routes](references/price-research-routes.md) | 가격 조사 전. 예전 관측을 현재 시세로 쓰지 않는다 |
| [mid-work-questions](references/mid-work-questions.md) | 작업 도중 질문·변경이 필요할 때 |
| [exemplar-quality](references/exemplar-quality.md) | 절 작성 전과 검토 때. 분량·키워드로 충족시키지 않는다 |
| [narrative-expansion](references/narrative-expansion.md) | 절 작성 전후. 길이·문단 수 목표를 두지 않는다 |
| [guideline-tracking](references/guideline-tracking.md) | 학교 지침을 등록·대조할 때. **무엇을 근거로 삼는지도 여기 있다** |
| [cross-review](references/cross-review.md) | 원문 대조 |
| [model-routing](references/model-routing.md) | 담당에게 위임하기 직전 |
| [output-tooling](references/output-tooling.md) | 산출물을 만들기 전 |
| [package-install](references/package-install.md) | 실행 의존성. `gg_deps.py doctor`가 설치 판정의 정본이다 |
| [excel-template](references/excel-template.md) | 학교 재무 양식을 다룰 때 |
| [commands.md](references/commands.md) | 명령을 쓸 때. 구현 파일은 열지 않는다 |
| [parser-setup](references/parser-setup.md) | 첫 사용에 문서 읽기 도구를 정할 때 |
| [korean-polishing](references/korean-polishing.md) | 윤문 단계 |

## 출력 지원 한계

DOCX·XLSX·Office 변환의 명령·플래그와 각 경로의 보장 범위는 [output-tooling](references/output-tooling.md)을 따른다. 산출물을 만들기 전에 읽는다. 생성·변환·기계검사 완료는 교수 승인이 아니며 제출 완료로 자동 승격되지 않는다. DOCX 생성 뒤 한글에서 할 일(글꼴·여백·페이지 번호)은 사람이 확인하기 전까지 완료로 표시하지 않으며, 그 셋이 Ⅰ~Ⅵ 작성을 막지도 않는다.

원본·개인 자료는 외부로 보내거나 패키지에 포함하지 않는다. 공개 배포·교수 전달·파서 준비 외의 추가 설치는 별도 승인 범위다. 사용자 결정에 따라 문서 읽기에 필요한 Kordoc 전용 캐시 설치는 첫 사용 준비에 포함한다.
