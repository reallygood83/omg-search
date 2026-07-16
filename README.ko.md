# Master of Knowledge

옵시디언 볼트를 Gemini File Search와 Agent 기반 지식 작업실로 바꿔주는 플러그인입니다. 내 노트에 질문하고, 답변에 사용된 소스 노트를 확인하고, Antigravity/AGY 작업을 옵시디언 안에서 실행한 뒤 결과를 다시 노트로 적용할 수 있습니다.

## 주요 기능

### Master Dashboard
- Chat, Agent, Budget, `_omg`, Graph, Settings 탭을 하나의 옵시디언 사이드바에서 사용
- Gemini 답변과 Agent 결과 모두 Sources, Apply, Copy 액션 지원
- Agent 결과를 원본 노트를 건드리지 않고 `_omg` 작업 공간 또는 설정한 출력 폴더에 저장

### 폴더 기반 자동 동기화
- 선택한 하나 이상의 폴더와 하위 폴더의 마크다운 파일을 Gemini File Search에 동기화
- 파일 생성, 수정, 삭제, 이름 변경을 추적
- SHA-256 해시 기반 변경 감지로 불필요한 API 호출 최소화

### 내 노트와 대화하기
- 동기화된 노트를 기반으로 답변하는 Chat 탭
- 답변에 사용된 소스 노트 표시
- 소스 노트로 바로 이동 가능
- Chat과 Agent 각각 새 대화 시작 버튼 제공

### Agent Workspace
- Agent 탭에서 Antigravity/AGY 작업 실행
- 현재 볼트 경로, 선택한 sync 폴더, Agent 출력 폴더, 웹 검색 설정, Obsidian writing skill 정보를 Agent 프롬프트에 전달
- Agent 결과도 Chat과 동일하게 Apply, Copy, Create Note, Select Note, Save 액션 사용

### Budget Guard
- 월간 Gemini API 예산 설정
- Chat에서 사용한 Gemini API 토큰 비용 추정 표시
- Agent/Antigravity 실행은 플러그인의 Gemini API 키를 사용하지 않으므로 예산에 포함하지 않음
- `_omg/logs/budget-YYYY-MM.jsonl` 로그를 기준으로 누적 사용량 보정

### File Search 업로드 진단
- 일반 API 키 검증과 별도로 File Search sync 가능 여부를 진단
- 모델 접근, File Search store 접근, Files API 업로드, File Search import 단계를 순서대로 확인
- Sync Dashboard에 error 파일만 생기는 경우 원인 파악에 유용
- 새 `AQ...` 형식 API 키에서 업로드/import `403`이 발생하는 경우를 구분하는 데 도움

## 설치

### BRAT 또는 수동 설치
1. 최신 릴리즈에서 `main.js`, `manifest.json`, `styles.css`를 다운로드합니다.
2. 볼트 안에 `.obsidian/plugins/master-of-knowledge` 폴더를 만듭니다.
3. 세 파일을 해당 폴더에 넣습니다.
4. 옵시디언 설정 > 커뮤니티 플러그인에서 Master of Knowledge를 활성화합니다.

### 소스에서 빌드
```bash
npm install
npm run build
```

## 초기 설정

1. [Google AI Studio](https://aistudio.google.com/app/apikey)에서 Gemini API 키를 만듭니다.
2. 옵시디언 설정 > Master of Knowledge로 이동합니다.
3. API 키를 붙여 넣고 **Verify**를 누릅니다.
4. 노트 동기화를 사용할 예정이라면 **Diagnose File Search**를 눌러 업로드/import 권한을 확인합니다.
5. Gemini에 동기화할 폴더를 선택합니다.
6. **Sync Now**를 눌러 초기 동기화를 실행합니다.

## 사용 예시

Chat:
- "최근 3일간 내가 관심을 가진 분야가 무엇이었던 것 같아?"
- "초등교사를 위한 옵시디언 활용 강의안을 작성해줘."
- "내 노트에서 AI 교육과 관련된 핵심 아이디어를 정리해줘."

Agent:
- "이 주제로 블로그 글을 작성하고 옵시디언 노트로 저장해줘."
- "동기화된 노트를 바탕으로 강의안 초안을 만들어줘."
- "웹 검색을 켜고 최신 자료까지 참고해서 보고서를 작성해줘."

## 설정 옵션

| 옵션 | 설명 | 기본값 |
| --- | --- | --- |
| API Key | Google Gemini API 키 | 필수 |
| Gemini Model | Chat에서 사용할 Gemini 모델 | `gemini-2.5-flash` |
| Sync Folders | Gemini File Search에 동기화할 폴더 | 없음 |
| Corpus Display Name | Gemini File Search store 이름 | `Obsidian Vault` |
| Workspace Folder | 로그, 그래프, 작업 파일 저장 폴더 | `_omg` |
| Agent Output Folder | Agent가 생성한 노트 저장 폴더 | `_omg/agent` |
| Monthly Budget | 월간 Gemini API 예산 표시용 값 | `7` |
| Auto Sync | 파일 변경 시 자동 동기화 | 켜짐 |
| Sync Debounce | 변경 후 동기화 대기 시간 | `3000` |

## API 키와 File Search 주의사항

일반 **Verify** 버튼은 Gemini 모델 목록 호출이 가능한지만 확인합니다. 하지만 Sync는 추가로 File Search store, Files API upload, File Search import 엔드포인트를 사용합니다.

따라서 Verify는 통과하지만 Sync Dashboard에 error 파일만 생길 수 있습니다. 이 경우 설정에서 **Diagnose File Search**를 실행하세요.

진단 단계:

- `models`: Gemini 모델 호출 자체가 실패
- `file_search_store`: File Search store 생성/조회 실패
- `files_upload`: Files API 업로드 실패
- `import_file`: 업로드된 파일을 File Search store로 import 실패

특히 새 Google AI Studio 키가 `AQ...`로 시작하고, `files_upload` 또는 `import_file` 단계에서 `403`이 발생한다면 폴더 선택 문제가 아니라 Gemini File Search와 새 Auth key 호환 문제일 수 있습니다. 이 경우 새 Google Cloud 프로젝트/키를 테스트하거나, 기존 `AIza...` 키가 있다면 비교 테스트해보는 것이 좋습니다.

참고:

- [Gemini API key docs](https://ai.google.dev/gemini-api/docs/api-key)
- [Gemini File Search docs](https://ai.google.dev/gemini-api/docs/file-search)
- [AQ key File Search discussion](https://discuss.ai.google.dev/t/new-aq-api-keys-failing-to-upload-to-file-search-store/140817)

## 문제 해결

### API key is invalid / Verify 실패
- [Google AI Studio](https://aistudio.google.com/app/apikey)에서 새 키를 발급하세요 (보통 `AIza`로 시작).
- Google Cloud 프로젝트에서 Generative Language / Gemini API 사용이 가능한지 확인하세요.

### Verify는 되는데 Sync만 실패 / importFile HTTP 401 (v2.0.37+)
1. API 키 **Application restrictions = None** (Referrer/IP 제한 시 models는 되고 File Search만 막힐 수 있음).
2. 키/프로젝트를 바꿨다면 **Reset store** 후 **Sync Now**.
3. Verify는 이제 models + File Search Store를 함께 검사합니다.
4. 업로드는 `uploadToFileSearchStore` 우선, 실패 시 Files API + `importFile` 폴백.
5. 계속 실패하면 **Diagnose File Search**로 단계를 확인하세요.

### Sync Dashboard에 error 파일만 생김
- sync 폴더가 올바르게 선택되었는지 확인합니다.
- **Diagnose File Search**를 실행해 실패 단계를 확인합니다.
- API key가 `AQ...`이고 401/403이 발생하면 File Search 호환/제한 문제 가능성이 있습니다.

### Chat이 내 노트를 제대로 쓰지 않는 것 같음
- Sync Dashboard에서 synced 파일 수를 확인하세요.
- 선택한 sync 폴더 안의 노트만 Gemini File Search 대상으로 사용됩니다.
- 답변 아래 Sources가 나오는지 확인하세요.

### Agent가 느리거나 응답이 없음
- Agent Timeout 값을 늘려보세요.
- Antigravity/AGY CLI 경로를 설정에서 Auto-detect하거나 직접 지정하세요.
- Agent는 Gemini API 예산에 포함되지 않습니다.

## 라이선스

MIT

## Credits

- [Obsidian Plugin API](https://github.com/obsidianmd/obsidian-api)
- [Google Gemini API](https://ai.google.dev/)
