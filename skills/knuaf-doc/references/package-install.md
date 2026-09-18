# Python 패키지 의존성 선언과 준비

문서 읽기 도구 준비는 [parser-setup.md](parser-setup.md)를 따른다. 이 문서는 산출물 생성에 필요한 Python 패키지 의존성의 선언·확인·설치 계약이다.

## 선언된 의존성

스킬이 필요로 하는 패키지는 설치된 것처럼 보이는 환경에서 찾지 않고 `scripts/requirements-runtime.txt`와 `scripts/runtime-deps.json`에 명시한다. `runtime-deps.json`에는 배포판 이름, 버전 범위, 실제 import 이름, 용도, 사용하는 스킬 스크립트를 함께 둔다.

| 배포판 | import 이름 | 용도 |
|---|---|---|
| openpyxl | `openpyxl` | XLSX 읽기·생성 — 재무 workbook·학교 양식 검사·출력 검증 |
| python-docx | `docx` | DOCX 생성 — 앞표지·본문 렌더 |
| pypdf | `pypdf` | PDF 구조 검증 — 보낸 PDF 페이지 확인 |

## 정직한 확인

다른 환경에 설치돼 있다는 표시는 이 프로젝트의 실행 증거가 아니다. 호스트 사용자 site-packages·다른 가상환경에 패키지가 있어도, 이 프로젝트를 실행하는 인터프리터에서 `import`가 되지 않으면 미설치로 본다. 호스트의 site-packages를 프로젝트로 복사하거나 경로를 임의로 추가해 "있는 것처럼" 만들지 않는다.

`scripts/gg_deps.py doctor <작업폴더>`는 선언된 각 패키지를 현재 인터프리터와 프로젝트 전용 환경(`<작업폴더>/.venv`)에서 실제로 `import`하고, 설치된 배포판 버전이 `runtime-deps.json`의 선언 범위 안인지 함께 검사한다. 버전을 읽을 수 없거나 안정된 숫자 점 형식(예: `3.1.5`)이 아니면 비교 불가로 보고(`installed-version-unchecked`) 준비로 세지 않는다. `ready`는 선택된 인터프리터가 선언된 모든 패키지를 불러오고 버전이 범위 안일 때만 `true`다.

## 프로젝트 전용 환경 준비

설치가 필요하면 프로젝트 폴더 안의 `.venv`에만 설치한다. 전역 site-packages, 다른 프로젝트 환경, 사용자 홈의 패키지는 변경하지 않는다.

1. `python3 <스킬>/scripts/gg_deps.py doctor <작업폴더>`로 현재 상태를 확인한다.
2. `python3 <스킬>/scripts/gg_deps.py ensure <작업폴더>`로 `<작업폴더>/.venv`를 만들고 선언된 `requirements-runtime.txt`를 설치한다. 로컬 wheel 폴더가 있으면 `--no-index --find-links <wheel폴더>`로 네트워크 없이 설치한다.
3. `ensure`는 pip 실행 뒤 반드시 새 venv 인터프리터로 각 패키지를 실제 `import`하고 버전 범위까지 검증한다. 설치 실패·네트워크 없음·wheel 부재·버전 비교 불가는 실패로 보고하며 성공처럼 기록하지 않는다.
4. 이후 의존성이 필요한 스크립트는 `python3 <스킬>/scripts/gg_deps.py python <작업폴더>`가 출력하는 인터프리터(`.venv`가 있으면 그 안의 python)로 실행한다.

네트워크도 로컬 wheel도 없으면 `ensure`는 실패를 보고하고, 그 사유를 작업폴더 감사 기록에 남긴다. 설치가 불가능한 의존성이 필요한 산출물(XLSX·DOCX·PDF 검증)은 만들지 않거나 "의존성 미설치로 보류"로 기록한다.

## 제외 대상

학교 원문 추출물·예시본·개발 도구는 이 의존성 선언에 포함하지 않는다. 문서 읽기 파서(Kordoc 등)는 Python 패키지가 아니라 [parser-setup.md](parser-setup.md)의 기존 도구 우선 절차를 따른다.
