# 프로모션 prepare 수신자 계약 수정 배포 기록 (2026-09-17)

TrailBase / light-on-off의 3단계 지급 전환(다음 PR)에 전달하는 배포 기록.
게시 결과와 게시본 계약 실증까지 완료된 상태다.

## 확정된 소비 버전 (다음 TrailBase PR용)

| 패키지 | 버전 | 비고 |
|---|---|---|
| `@ait-kit/api-core` | **0.5.0** | prepare 수신자 필수 계약 포함 |
| `@ait-kit/api-client` | **0.5.0** | prepare 입력이 이제 프록시 경로를 그대로 통과 (기존 구현은 body를 버렸음) |
| `@ait-kit/api-cloudflare-service` / `@ait-kit/api-orpc` | 0.5.0 | 서버 고정 릴리스 그룹 동반 번업 (배포 코드 불변) |
| `@ait-kit/sdk` | 0.3.0 | 변경 없음 |

수정 PR: ait-kit #33 (`5f7c994`, squash — 브랜치 `fix/promotion-prepare-recipient`).
릴리스 커밋: `349a359` (release: version packages #34). 게시 워크플로에서
4종 0.5.0 게시 확인(minor — 호출자 수정이 필요한 계약 변경).

## 계약 요약 (0.5.0 기준)

- `promotionPrepareReward`는 `userKey` / `tossUserKey` / `anonKey` 중
  **정확히 하나**를 필수로 받는다. 누락·중복·빈값은 `INVALID_PROMOTION_RECIPIENT`
  (400)로 upstream 요청 **전에** 거절된다(stub 모드 포함).
- 선택한 수신자는 단일 식별 헤더(`x-toss-user-key` 또는 `x-anon-key`)로
  본문 없는 get-key 요청에 실린다. 값은 byte-for-byte 통과(앱 저장용
  접두사 추가/제거 없음), 로그·오류 메시지에 노출되지 않는다.
- prepare는 키 발급만 수행(execute/result 미호출). 성공은 키 발급 성공이지
  지급 성공이 아니다. 실패 envelope은 가상 key로 보충되지 않는다.
- 키는 실행 전 영속 저장. 키 만료는 공식 계약에 문서화되어 있지 않으며,
  만료가 과거 지급의 미실행을 증명하지 않는다. 이미 사용한 키 오류 시
  자동 재발급 없음 — 상태 조회로 해결.
- 레거시 `promotionRewardGrant`는 유지된다. TrailBase가 이를 사용하지
  않게 되는 전환은 다음 PR의 범위.

## 공식 스펙 대조 (독립 확인)

공식 문서 3개 언어판(EN/KO/ZH) 모두에서 get-key의 선언된 파라미터는
없고, execute/result에만 `x-toss-user-key`/`x-anon-key`(optional)가
선언된다. 이번 수정은 키가 발급된 수신자에게 귀속된다는 근거로
**키트 측 계약을 강화**한 것 — 공식 스펙이 get-key 헤더를 요구한다고
주장하는 것이 아님을 PR #33 본문에 명시했다.

## 게시본 실증 (이번 작업에서 직접 실행)

- `bun run verify:published:node -- --version 0.5.0`: 5개 mTLS 시나리오
  전부 PASS (설치 api-client/api-core 0.5.0, 해석 경로가 설치 디렉터리
  내부, 보고서 `/tmp/published-0.5.0-report.json`, 검증 커밋 기록).
- 독립 임시 프로젝트에 `@ait-kit/api-core@0.5.0`을 설치해 실행:
  수신자 없는 prepare → `INVALID_PROMOTION_RECIPIENT` 400 거절,
  수신자 1개 prepare → 키 발급 성공(stub 마커 포함).

## 후속 경계 (별도 작업)

- TrailBase proxy의 `@ait-kit` 핀 0.5.0 갱신 + prepare 호출처에 수신자
  전달로 전환 — 다음 PR.
- 게시 직후 npm 전파 지연(수 분)으로 첫 설치 시도가 ETARGET/E404로
  실패할 수 있음 — 재시도 후 확정된 버전으로 소비할 것.
