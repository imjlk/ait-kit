# Node mTLS 수정 버전 배포 및 TrailBase 소비 버전 확정 (2026-09-16)

TrailBase 후속 작업에 전달하는 배포 기록. 게시 결과와 설치 검증까지
완료된 상태이며, 소비 버전은 실제 릴리스 결과로 확정했다.

## 확정된 의존성 버전

| 패키지 | 버전 | 비고 |
|---|---|---|
| `@ait-kit/api-client` | **0.4.1** | Node mTLS 응답 변환 settlement 수정 포함. `dependencies`가 `@ait-kit/api-core@0.4.1`을 정확히 핀 |
| `@ait-kit/api-core` | **0.4.1** | 고정 릴리스 그룹 동반 버전업 (IAP·메시지 응답 검증은 0.4.0 내용, 0.4.1은 그룹 동기화) |
| `@ait-kit/sdk` | 0.3.0 | 변경 없음 — SDK 추가 릴리스는 만들지 않았다 |

수정 PR: ait-kit #28 (`3993c4e`, squash — 브랜치 `fix/node-mtls-response-settlement`).
릴리스 커밋: `490c590` (release: version packages #29). 게시 워크플로 실행
35082733890 성공 (api-core/api-client/api-cloudflare-service/api-orpc 0.4.1
게시, `@ait-kit/sdk@0.3.0`은 "version already exists"로 스킵 — 재게시 아님).

## 실제 검증한 런타임

- Bun 1.4.0 / Node.js 26.4.0: 소스 스위트 + 게시본 소비 검사 (로컬)
- CI 고정: Bun 1.4.2 / Node.js 24 (필수 검사 흐름)

## 게시본 설치·실행 검사 결과

### 원본 검사 (릴리스 직후, 2026-09-16)

임시 프로젝트에 npm 게시본 `@ait-kit/api-client@0.4.1`을 설치해
(로컬 tarball·workspace 경로 아님) 코드 PR #28의 테스트 실행기
(`test/helpers/node-runtime-check.mjs`)를 수정 없이 재사용해 실행:

- 정상 mTLS 200 요청 ✓
- 상태 코드 600 → `NodeMtlsTransportError`/`REQUEST_FAILED` reject,
  원본 변환 예외 `cause` 보존 ✓
- 실패 후 같은 transport 인스턴스로 정상 200 재요청 ✓
- 실행기 exit 0, 미처리 예외 없음, watchdog 미발동 ✓

방식 한계(이후 대체됨): 실행기가 repo의 빌드 디렉터리를 참조하므로,
게시본 dist를 repo dist 위치로 심볼릭 링크해 연결한 뒤 복원하는 방식이었다.
"완전 독립 설치 검사"로는 아래 재현 가능한 검사가 후속을 대신한다.

### 재현 가능한 게시본 검사 (2026-09-16, `test/unify-node-mtls-consumer-verification` PR)

`bun run verify:published:node -- --version 0.4.1` — 루프백 mTLS 서버에
대한 동일 5-시나리오 계약(200 + 클라이언트 인증서 확인, 전체 기한
TIMEOUT, body 중단 REQUEST_FAILED, 600 변환 실패 cause 보존, 실패 후
재사용)을 임시 소비 프로젝트의 **공개 `/node` export**로 실행. repo
dist 교체·심볼릭 링크 없음. 결과: 전 시나리오 PASS, 설치본
api-client 0.4.1 / api-core 0.4.1 확인, 해석 경로가 설치 디렉터리
내부임을 파일 단위로 확인, 자식 exit 0. JSON 보고서(요청·설치 버전,
해석 경로, 시나리오별 결과, 런타임, 검증 코드 커밋) 생성. 이 검사는
동일 커밋부터 누구나 같은 명령으로 재실행할 수 있다.

### 증거 구분

- 소스·PR에서 확인: settlement 수정 로직과 회귀 테스트(PR #28),
  릴리스 manifest·게시 워크플로 로그(PR #29 실행 35082733890).
- GitHub Actions에서 확인: 게시 워크플로 성공과 4종 0.4.1 게시,
  CI의 빌드본·tarball·타입 검사.
- 이번 작업에서 직접 실행: 위 재현 가능한 게시본 검사(독립 설치).
- 이전 완료 보고에서 전달받고 독립 재현하지 않은 것: 원본 검사의
  심볼릭 링크 방식 상세(재현 스크립트가 일회성 /tmp 드라이버였음).

tarball 확인: `dist/node/index.js`에 변환 실패 처리 포함,
`dist/node/index.d.ts`에 `.js` 지정자 포함.
연결 의존성 `@ait-kit/api-core@0.4.1` 설치 확인.

### 타입 검사 범위 구분

- `/node` 단독: 0.4.1부터 `dist/node/index.d.ts`의 `.js` 지정자로
  Bundler와 NodeNext 모두 통과 (PR #28).
- 서버 패키지 전체(api-core 루트·api-client 루트·api-orpc·
  api-cloudflare-service와 조합): extensionless 선언 체인(TS2834)이
  NodeNext를 깨뜨렸고, PR ait-kit #30(`bfa780c`,
  `fix(packages): make server API declarations compatible with NodeNext`)이
  수정했다. **이 수정은 0.4.1에 포함되지 않았다** — 다음 서버 릴리스
  (Sampo 릴리스 PR로 확정된 번호)부터 배포된다. 0.4.1의 NodeNext
  소비는 `/node` 단독 조합만 지원한다.

## REQUEST_FAILED 오류 계약

유지됨. 공개 시그니처·옵션·오류 코드 변화 없음. `REQUEST_FAILED`에
"완전히 수신된 응답의 fetch Response 변환 실패"가 포함되는 것으로
의미가 확장됐고, 기존 소비자의 REQUEST_FAILED 처리가 그대로 연결된다.
TIMEOUT/ABORTED/RESPONSE_TOO_LARGE 등 기존 분류는 그대로다.
전송 실패는 "외부 지급·발송 미실행"을 의미하지 않으며 자동 재시도도 없다.

## TrailBase 후속 작업 경계

- HTTPS 경로: 이 수정 버전(`@ait-kit/api-client@0.4.1`)의 `/node`를
  사용한다. proxy `package.json`의 정확 핀(`0.4.1`) 갱신.
- TrailBase에 남은 일반 HTTP 전달 경로(로컬/테스트 업스트림)의
  hop-by-hop 헤더 문제 등은 별도 수정 — 이번 수정 범위 아님.
- 메시지 UNKNOWN 보존·프로모션 원장 연결은 Rust 쪽 작업.
- SDK 0.3.0 소비 업데이트(ait-rn/ait-web)와 로컬 광고 cleanup 수정도
  별도 작업.
