# M1 실검증 체크리스트 (M1-15)

> `POST /api/analyses` 실제 실행 전, 무엇이 준비됐고 무엇이 막고 있는지를
> **코드와 실측 결과 기준으로** 정리한 문서. 추측으로 쓴 항목은 없다.

- 작성일: 2026-07-09 (M1-14 완료 시점, commit `e7eac27`) / 갱신: 2026-07-10 (M1-16, S6 반영)
- 실측 환경: 로컬 dev 서버(`next dev`) + 원격 Supabase REST 프로브
- 전체 상태 요약은 `docs/M1_STATUS.md` 참조 — **M1 개발 완료, 실 API 검증만 대기**

---

## 1. 실측 결과 요약 (2026-07-09)

| 항목                                                              | 결과                                                                                                              | 확인 방법                                                                                     |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL` / `ANON_KEY`                           | ✅ 설정됨                                                                                                         | `.env.local` 직접 확인                                                                        |
| `SUPABASE_SERVICE_ROLE_KEY`                                       | ✅ 입력됨 (07-09), write 실측 성공                                                                                | 공고 insert 성공 (posting_id 59603e48-…)                                                      |
| `ANTHROPIC_API_KEY`                                               | 🔶 입력됨 (07-09), 크레딧 부족                                                                                    | 아래 "Anthropic API 키" 행 참조                                                               |
| 원격 DB 테이블 5종 (postings/extractions/snapshots/analyses/jobs) | ✅ 존재                                                                                                           | REST 프로브 — 전부 HTTP 200 + `[]` (RLS가 anon 행 차단, 테이블 미존재면 42P01 에러가 났을 것) |
| `POST /api/analyses` 무세션 호출                                  | ✅ 401 `{"error":"로그인이 필요합니다"}`                                                                          | dev 서버 기동 후 curl 실측                                                                    |
| `GET /api/analyses`                                               | ✅ 405 (POST만 export)                                                                                            | curl 실측                                                                                     |
| 단위 테스트                                                       | ✅ 14파일 / 175건 통과 (2026-07-10)                                                                               | `npm test`                                                                                    |
| S6 결과 화면 `/analyze/[jobId]`                                   | ✅ dev 렌더 HTTP 200 (진행 로딩 상태 표시)                                                                        | dev 서버 + curl 실측 (2026-07-09)                                                             |
| Anthropic API 키                                                  | 🔶 키 유효하나 **크레딧 부족 400** (2026-07-10 재확인)                                                            | haiku max_tokens=1 프로브 — req_011CcsCRJpAQL9qwCJ9x6Zxx                                      |
| auth.users에 사용자 존재 여부                                     | ❓ 미확인                                                                                                         | service key 없이는 조회 불가                                                                  |
| Realtime publication 등록 여부                                    | ❓ 미확인 (마이그레이션 7절에 포함돼 있고 마이그레이션은 적용됨 — 대시보드 Database > Publications에서 확인 필요) | 원격 확인은 service key 필요                                                                  |

## 2. 실행 경로 의존성 지도 (코드 근거)

`POST /api/analyses` 1건이 완주하려면 아래가 순서대로 전부 충족돼야 한다:

| #   | 의존성                              | 코드 근거                                                                 | 현재 상태                                           |
| --- | ----------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------- |
| 1   | 세션 쿠키 (로그인 사용자)           | `app/api/analyses/route.ts:38-44` — `auth.getUser()` null이면 401         | ❌ 로그인 화면 없음(M2). 세션을 만들 UI 경로가 없다 |
| 2   | `SUPABASE_SERVICE_ROLE_KEY`         | `lib/supabase/service-role.ts:20-25` — 빈 값이면 즉시 throw               | ✅ 입력됨 (write 실측 성공)                         |
| 3   | `ANTHROPIC_API_KEY`                 | `lib/ai/client.ts:11-17` — 빈 값이면 즉시 throw                           | 🔶 입력됨 — **크레딧 부족 400** (충전 필요)         |
| 4   | 프로필 스냅샷 행 (요청 사용자 소유) | `lib/ai/analysis-pipeline.ts:115-122` — 없으면 `snapshot_not_found` (404) | ❌ 생성 함수·UI 없음(M2 범위). 수동 insert 필요     |
| 5   | 가입 트리거·RLS 등 스키마           | 마이그레이션 1개에 전부 포함                                              | ✅ 적용됨 (1절 프로브로 간접 확인)                  |

**의존성 없이 이미 동작하는 것** (실측 완료): 라우트 배선(401/405), proxy.ts 세션 갱신 경로(요청이 프록시를 통과함 — dev 로그에 `proxy.ts: 908ms` 기록).

## 3. 확인 항목별 판정

| 확인 항목                 | 지금 실검증 가능?                 | 차단 요인 / 방법                                                                                                                                                                                                                          |
| ------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| extract cache **miss**    | 🔶 키만 채우면 가능 (세션 불필요) | `npm run extract:posting -- --file scripts/fixtures/sample-posting-backend.txt` — service-role 직접 사용이라 세션·스냅샷 불필요. 차단 요인: 2·3번 키                                                                                      |
| extract cache **hit**     | 🔶 키만 채우면 가능               | 위 명령을 `--posting-id <직전 uuid>`로 재실행 → `cache hit — LLM 호출 없음` 출력 확인. 또는 `npm run lookup:url`                                                                                                                          |
| `analyzeMatch` 실행       | ❌ 현재 불가                      | 실행 경로가 파이프라인(라우트) 하나뿐 → 1~4번 전부 필요. 스크립트 진입점 없음                                                                                                                                                             |
| score 계산·저장           | ❌ 현재 불가                      | 동일 — `saveMatchAnalysis`는 파이프라인에서만 호출된다                                                                                                                                                                                    |
| `analysis_jobs` 상태 갱신 | ❌ 현재 불가                      | 동일 — `createAnalysisJob`~`done/failed`는 파이프라인에서만 호출된다                                                                                                                                                                      |
| Realtime 이벤트 수신      | ❌ 현재 불가                      | 구독(`lib/realtime/analysis-jobs.ts`)은 **로그인된 browser 클라이언트** 전제(RLS: 본인 잡만 select). 구독 화면은 S6(`/analyze/[jobId]`)로 준비됨 — 남은 것은 세션 + 잡을 만들 파이프라인 실행. publication 등록 여부도 대시보드 확인 필요 |

정리: **매칭 이후 구간(match→score→save→jobs→Realtime)은 전부 `POST /api/analyses` 뒤에 있고, 그 문이 세션(1)과 스냅샷(4)으로 잠겨 있다.** 구조화 구간만 기존 스크립트 덕에 문 밖에서 검증 가능하다.

## 4. 실검증 절차 (준비되는 대로 위에서 아래로)

### A. 지금 즉시 (키 없이)

- [x] `npm test` — 175건 통과 확인 (2026-07-10 기준)
- [x] 무세션 `POST /api/analyses` → 401 확인 (라우트·프록시 배선)
- [x] 원격 테이블 존재 확인 (REST 프로브)
- [x] S6 화면 `/analyze/<uuid>` dev 렌더 200 확인 (2026-07-09)

### B. 키 2종 입력 후 (세션 불필요)

- [x] `.env.local`에 `SUPABASE_SERVICE_ROLE_KEY`(대시보드 Settings > API Keys > secret), `ANTHROPIC_API_KEY`(Anthropic Console) 입력 (2026-07-09)
- [ ] **cache miss**: `npm run extract:posting -- --file scripts/fixtures/sample-posting-backend.txt` → `cache miss (no_extraction) — LLM 호출` + extraction_id 출력 확인. 소요·token_usage 기록
  - 2026-07-09 실측: **Anthropic 크레딧 부족으로 400** (`credit balance is too low`, req_011CcrcaLKVTtNXksRAAvqqb) — 크레딧 충전 후 재시도 필요.
    부수 확인 완료: ① service key로 공고 insert 성공(posting_id 59603e48-…) ② cache_miss(no_extraction) 판정 정상 ③ API 오류가 `llm_error`로 정규화되어 실패 처리됨 — 오류 경로 실전 검증
- [ ] **cache hit**: 출력된 posting_id로 `npm run extract:posting -- --posting-id <uuid>` 재실행 → `cache hit — LLM 호출 없음` 확인
- [ ] 대시보드 Table Editor에서 `jobConfirm_posting_extractions` 행·발췌 컬럼(company_name/deadline_date)·`latest_extraction_id` 포인터 확인
- [ ] 대시보드 Database > Publications에서 `supabase_realtime`에 `jobConfirm_analysis_jobs`가 있는지 확인

### C. 임시 사용자 + 스냅샷 준비 (M2 전 수동 경로)

SQL Editor에서 (service 권한으로 실행):

- [x] 임시 사용자 생성 + 가입 트리거 확인 (2026-07-10 실측 완료)
  - 사용자: m2-verify@example.com (e199ef0c-c80c-4c56-8fc8-a026b5776314)
  - `jobConfirm_profiles` 자동 생성 확인 (가입 트리거 정상, completeness 0)
  - 비밀번호 로그인(anon key) + 로그인 세션의 RLS 본인 조회까지 통과
  - 해결한 장애: 최초 시도는 **500 "Database error creating new user"** — 원인은 공유 DB의
    타 프로젝트 트리거 `on_auth_user_created`(`handle_new_user`)가 `set search_path = ''`
    상태에서 `profiles`를 비수식 참조 → 42P01로 가입 트랜잭션 롤백.
    `alter function public.handle_new_user() set search_path = public;`으로 해결 (사용자 실행)
- [ ] 프로필 스냅샷 수동 insert:
  ```sql
  insert into "jobConfirm_profile_snapshots" (user_id, snapshot, content_hash)
  values (
    '<위 사용자 uuid>',
    '{"desired_job":"백엔드 개발자","desired_conditions":{},
      "educations":[],"experiences":[{"company":"A사","role":"백엔드","period_months":48,"description":"Python API 개발"}],
      "skills":[{"name":"Python","level":null,"years":4}],
      "certificates":[],"languages":[],"projects":[]}'::jsonb,
    'manual-snapshot-1'
  ) returning id;
  ```

### D. 전체 파이프라인 실검증 (2가지 경로)

- [ ] **경로 1 — 라우트 우회 (세션 불필요, 먼저 권장)**: `runAnalysisPipeline`을 직접 호출하는 일회성 실행 —
  ```
  npx tsx --conditions=react-server --env-file=.env.local -e "
  import('./lib/ai/analysis-pipeline').then(async (m) => {
    const { createAnthropicClient } = await import('./lib/ai/client');
    const { createServiceRoleSupabaseClient } = await import('./lib/supabase/service-role');
    const r = await m.runAnalysisPipeline(
      { anthropic: createAnthropicClient(), supabase: createServiceRoleSupabaseClient() },
      { userId: '<사용자 uuid>', profileSnapshotId: '<스냅샷 uuid>', pastedText: require('fs').readFileSync('scripts/fixtures/sample-posting-backend.txt','utf8') }
    );
    console.log(r.job.step, r.analysis.score, r.analysis.grade);
  });"
  ```
  검증 포인트: 반환 `job.step === 'done'`, `jobConfirm_match_analyses` 행 1건(score/grade/score_breakdown/버전 3종/token_usage), `jobConfirm_analysis_jobs` 행이 done + posting_id 연결
- [ ] **경로 2 — 라우트 경유 (세션 필요)**: M2 로그인 화면이 생기면 브라우저에서 로그인 → 같은 요청을 `fetch('/api/analyses', ...)`로 실행 → 200 응답과 위 검증 포인트 재확인. (세션 쿠키를 수동 조립하는 방법은 `@supabase/ssr` 쿠키 포맷에 결합되므로 권장하지 않는다)
- [ ] **Realtime**: 경로 2 실행 중 브라우저 콘솔에서 `subscribeToAnalysisJob(browserClient, jobId, console.log)` — step 변경 이벤트(fetching→…→done) 수신 확인. RLS상 반드시 로그인 세션이 있어야 한다
- [ ] **실패 분기**: 50자 미만 pastedText(`lib/scraper/index.ts`의 `MIN_BODY_LENGTH=50`) → job이 `failed`/`fetch_failed`인지, 존재하지 않는 snapshotId → 404 + 잡 미생성인지

## 5. 결론 — 가능/불가 범위

**지금 가능** (실측 완료 포함):

- 단위 테스트 전체, 라우트 401/405 배선, 원격 스키마 존재 확인
- (키 입력 즉시) 구조화 cache miss/hit 실검증 — 기존 스크립트로 세션 없이 가능

**현재 불가능 — 원인별**:

1. ~~키 미입력~~ → 2026-07-09 입력 완료. 단 **Anthropic 크레딧 부족(400)** — 충전 전까지 LLM 호출 전 구간 차단 (2026-07-10 재확인)
2. 로그인 세션을 만들 수단 없음 (로그인 UI는 M2) → 라우트 경유 검증·Realtime 구독·S6 실데이터 렌더
3. 프로필 스냅샷 생성 경로 없음 (M2) → 매칭 이후 전 구간. 수동 SQL insert로 우회 가능 (4-C)
4. 매칭~Realtime 구간은 파이프라인 외 진입점이 없음 → 라우트 우회 실행(4-D 경로 1)으로 검증

## 6. 환경 변수·명령어 요약

**필요 환경 변수** (`.env.local` — 전부 입력됨, Anthropic은 크레딧 충전 필요):

| 변수                                                         | 상태                    | 용도                         |
| ------------------------------------------------------------ | ----------------------- | ---------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✅                      | 클라이언트·세션              |
| `SUPABASE_SERVICE_ROLE_KEY`                                  | ✅ (write 실측 성공)    | 파이프라인 공유 테이블 write |
| `ANTHROPIC_API_KEY`                                          | 🔶 키 유효, 크레딧 부족 | LLM 2단계 호출               |

**검증 실행 명령어**:

| 명령                                                                            | 용도                               | 전제                      |
| ------------------------------------------------------------------------------- | ---------------------------------- | ------------------------- |
| `npm test` / `npm run lint` / `npm run build`                                   | 정적 검증 전체                     | 없음                      |
| `npm run dev` 후 무세션 `curl -X POST /api/analyses`                            | 라우트 401/400 분기                | 없음                      |
| `npm run extract:posting -- --file scripts/fixtures/sample-posting-backend.txt` | 구조화 cache miss (LLM #1 실호출)  | **크레딧**                |
| `npm run extract:posting -- --posting-id <uuid>`                                | 구조화 cache hit (LLM 미호출)      | 위 실행 1회               |
| `npm run lookup:url -- <url>`                                                   | url_hash 캐시 조회                 | service key               |
| 4-D 경로 1의 tsx 원라이너                                                       | 전체 파이프라인 (match·score·jobs) | 크레딧 + 체크리스트 C     |
| 브라우저 `/analyze/<jobId>`                                                     | S6 진행·결과 화면 + Realtime 수신  | 위 실행 + 로그인 세션(M2) |

---

_이 문서는 M1-15에서 작성, M1-16에서 갱신된 스냅샷이다. 크레딧 충전·M2 진행에 따라 체크박스를 갱신한다._
