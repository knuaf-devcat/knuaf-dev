# knuaf-doc

한국농수산대학교 창업논문·영농계획서와 동반 재무자료를 학교 공식 작성지침에 맞춰 작성·검토하는 로컬 도구입니다. Codex CLI/앱의 플러그인, 또는 Claude Code의 스킬로 동작합니다. 코드 어디에서도 모델이나 네트워크를 호출하지 않습니다.

## 이 도구가 하는 일

- 학교 공식 PDF 지침과 원답변을 근거로 창업논문 Ⅰ~Ⅵ장을 작성·검토합니다.
- 사실·목표·가정·계산을 구분해서 관리하고, 원문 근거 없는 주장을 자동으로 통과시키지 않습니다.
- 재무계획 엑셀(XLSX)과 논문 워드(DOCX) 산출물을 만들고, 사용자가 등록한 학교 원문에서 분해한 지침 항목과 대조합니다.
- 생성된 결과물은 지도교수 승인과 학교 제출 절차를 대신하지 않습니다. 최종 책임은 항상 작성자 본인에게 있습니다.

## 설치

**Python 3.10 이상이 필요합니다.** macOS 기본 `python3`(3.9)로는 첫 명령에서 "Python 3.10 이상이 필요함" 안내와 함께 종료됩니다. `python3.13` 등 최신 인터프리터를 쓰거나 `scripts/gg_deps.py ensure <작업폴더>`로 프로젝트 전용 `.venv`를 만드세요.

- **Codex**: 이 저장소를 플러그인으로 등록하면 `.codex-plugin/plugin.json`이 `skills/knuaf-doc`를 스킬로 노출합니다. 설치 방법은 Codex CLI/앱의 플러그인 설치 안내를 따르세요.
- **Claude Code**: `.claude-plugin/plugin.json`이 같은 스킬을 가리킵니다. 저장소를 플러그인 마켓플레이스로 추가하거나, `skills/knuaf-doc` 폴더를 `~/.claude/skills/knuaf-doc`로 복사하면 됩니다. 기본 모델 위임(`references/model-routing.md`)은 호스트에 지정 모델이 없으면 메인 모델이 수행하고 `unverified`로 기록합니다.

`app/`(데스크톱 동반 GUI)과 `tests/`는 스킬 패키지에 포함되지 않는 개발용 디렉터리입니다.

### 실행 의존성

`skills/knuaf-doc/scripts/requirements-runtime.txt`에 선언되어 있습니다.

```
openpyxl>=3.1,<4
python-docx>=1.1,<2
pypdf>=6,<7
```

Windows에서 네이티브 Office 자동화를 쓰려면 `pywin32`가 추가로 필요합니다(아래 플랫폼 지원 참고). 설치 방법은 `skills/knuaf-doc/references/package-install.md`를 참고하세요.

## 플랫폼 지원

핵심 로직(사실 관리·지침 검사·DOCX/XLSX 생성)은 순수 Python이며 Python 3.10 이상에서 macOS와 Linux(UTF-8 로캘)로 검증되었습니다. 잠금(`.gg-lock`)과 가져오기(`import`)의 Windows 경로는 이식을 마쳤고, 해당 분기를 강제로 켜는 테스트가 모든 OS에서 실행됩니다(`tests/test_core_lock.py`, `tests/test_core_migrate.py`). **다만 실제 Windows 기기에서의 실사용 검증은 아직 없습니다.** CI 매트릭스에 `windows-latest`가 있으므로 워크플로를 원격 저장소에서 한 번 실행하면 확인됩니다.

다만 "네이티브 Office로 실제 재계산·페이지 렌더까지 검증"하는 마무리 단계(`scripts/gg_office.py`)는 실제 Word/Excel 앱을 직접 구동합니다.

| 플랫폼 | 구현 | 실사용 검증 |
|---|---|---|
| macOS | AppleScript(osascript) | 완료 — 실제 Word/Excel로 반복 검증됨 |
| Windows | COM 자동화(pywin32) | 코드만 작성됨. 실제 Word/Excel로 실행한 검증은 아직 없음(정적 검사만). 코어 로직은 위 설명대로 별개 |

Windows에서 실제로 써보고 문제를 발견하시면 이슈나 PR로 알려주세요.

## 동반 앱 (GUI)

`app/`에는 비개발자 학생용 데스크톱 동반 앱(Electron + Python 사이드카)이 있습니다. 에이전트가 인터뷰·작문을 하는 동안
저장 상태·검사 결과(기계검사/내용검토/출력검토/교수승인 4레인)·다음 할 일·산출물을 보여주고, 잔류 잠금 해제·정본 스냅샷
복원·패키지 준비(`.venv`)·DOCX/XLSX 생성·Office 렌더를 버튼으로 제공합니다. 앱 안에 AI는 없고 아무것도 기기 밖으로 보내지 않습니다.
자세한 구조와 빌드 방법은 [app/README.md](app/README.md)를 보세요.

## 개발·테스트

```bash
python3.13 -m venv .venv-dev && .venv-dev/bin/pip install pytest pytest-timeout -r skills/knuaf-doc/scripts/requirements-runtime.txt
.venv-dev/bin/python -m pytest          # tests/ — 잠금·정본·인코딩·출력 스크립트·사이드카 프로토콜
```

CI(`.github/workflows/ci.yml`)는 ubuntu/macos/windows × Python 3.10/3.13에서 같은 테스트를 돌리고, Python 3.9에서는 안내 종료만 확인합니다.

## 학교 공식 지침 원문

저작권이 불확실한 학교 공식 PDF/발췌본은 이 저장소에 포함되어 있지 않습니다. 사용자가 자신의 학교 공식 원문을 직접 준비해서 등록해야 합니다.

## 라이선스

MIT. 자유롭게 가져다 쓰고, 수정하고, PR을 보내주세요. 자세한 내용은 [LICENSE](LICENSE)를 참고하세요.

## 기여

이슈와 PR을 환영합니다. 특히 아래 영역의 실사용 검증/피드백이 필요합니다.

- Windows 환경에서 네이티브 Office 자동화 실제 동작 확인
- 다른 학교/다른 판 지침 PDF에 대한 호환성

