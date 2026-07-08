# 기술 아키텍처 — Next.js + Supabase

> [PRD](./PRD.md)와 [AI 분석 설계](./AI_ANALYSIS_DESIGN.md)를 Next.js + Supabase 스택 위에 구현하기 위한 기술 결정 문서.

- 문서 버전: v1.0 (2026-07-08)
- 확정 스택: **Next.js (App Router, TypeScript) + Supabase (Postgres/Auth/Realtime/Storage)**

---

## 목차

1. [스택 구성 요약](#1-스택-구성-요약)
2. [전체 아키텍처](#2-전체-아키텍처)
3. [핵심 기술 결정](#3-핵심-기술-결정)
4. [Supabase 스키마 & RLS 정책](#4-supabase-스키마--rls-정책)
5. [프로젝트 구조](#5-프로젝트-구조)
6. [환경 변수](#6-환경-변수)
7. [MVP 구현 순서 (기술 관점)](#7-mvp-구현-순서-기술-관점)

---

## 1. 스택 구성 요약

| 레이어 | 선택 | 용도 |
|---|---|---|
| 프론트엔드 | Next.js 15+ (App Router, TypeScript) | 전 화면. Server Components 기본, 인터랙션 영역만 Client Components |
| 스타일 | Tailwind CSS | 반응형 웹 (모바일 대응) |
| 백엔드 | Next.js Route Handlers (`app/api/*`) | 수집·분석 파이프라인, 외부 API 프록시 |
| DB | Supabase Postgres | 설계 문서 7장의 9개 테이블 |
| 인증 | Supabase Auth | 이메일 + Google OAuth (카카오는 확장) |
| 실시간 | Supabase Realtime | 분석 진행 상태 푸시 (잡 테이블 구독) |
| 파일 | Supabase Storage | (확장 단계) 이력서 PDF 업로드 |
| LLM | Anthropic Claude API (`@anthropic-ai/sdk`) | 기본 모델 `claude-opus-4-8`, structured outputs |
| 배포 | Vercel | Next.js 호스팅 |

## 2. 전체 아키텍처

```
브라우저 (Next.js 프론트)
   │  ① URL 입력 → POST /api/analyses
   │  ④ Supabase Realtime 구독 (analysis_jobs 행 변경 = 진행 상태)
   ▼
Next.js Route Handler (Node runtime, Vercel)
   ├─ ② 전처리: URL 정규화 → url_hash 캐시 조회 → 수집(fetch) → 정제
   ├─ ③ LLM 파이프라인 실행 (스트리밍 호출)
   │     [1] 공고 구조화  ──▶ posting_extractions
   │     [2] 프로필 매칭  ──▶ match_analyses
   │     [3] 점수 산출 (서버 규칙)
   │     각 단계 완료 시 analysis_jobs.step 업데이트 → Realtime으로 클라이언트 반영
   ▼
Supabase Postgres (RLS 적용)
```

- **인증 흐름**: 클라이언트는 Supabase Auth 세션(`@supabase/ssr`)으로 로그인. Route Handler는 요청의 세션 쿠키로 사용자를 식별하고, DB 접근은 RLS를 통과하는 사용자 클라이언트 + 공유 테이블 기록용 service-role 클라이언트를 구분해 사용한다.
- **ANTHROPIC_API_KEY는 서버 전용**. 클라이언트에서 LLM을 직접 호출하는 경로는 만들지 않는다.

## 3. 핵심 기술 결정

### 3.1 분석 실행 위치: Next.js Route Handler (MVP)

분석은 LLM 2회 호출로 수십 초가 걸린다. 선택지 비교:

| 선택지 | 판단 |
|---|---|
| **Next.js Route Handler (Node) — 채택** | Vercel Fluid Compute 기준 장시간 실행 가능. 코드가 한 저장소에 있고 Anthropic SDK 스트리밍을 그대로 쓴다. MVP에 가장 단순 |
| Supabase Edge Functions | 실행 시간 제한과 Deno 런타임 제약. 굳이 백엔드를 둘로 쪼갤 이유 없음 |
| 별도 잡 큐 (Trigger.dev, Inngest 등) | 재분석 일괄 처리·트래픽 증가 시 도입. MVP에서는 과설계 |

- Route Handler는 `export const maxDuration = 300` 으로 실행 시간을 확보하고, Claude 호출은 항상 스트리밍(`client.messages.stream`)으로 해 HTTP 타임아웃을 피한다.
- **진행 상태 전달은 응답 스트림이 아니라 DB를 경유한다**: `analysis_jobs` 행의 `step` 컬럼을 갱신하고 클라이언트는 Supabase Realtime으로 구독. 이렇게 하면 사용자가 페이지를 이탈·새로고침해도 진행 중인 분석을 다시 붙어서 볼 수 있다.

### 3.2 수집(스크래핑) 전략

- 1차: Route Handler에서 서버사이드 `fetch` + HTML 파싱(cheerio) — 사람인·원티드 어댑터 + 범용 본문 추출.
- JS 렌더링이 필요한 사이트: MVP에서는 지원 목록에서 제외하고 **붙여넣기 폴백**으로 유도 (설계 문서 8장). 헤드리스 브라우저(Playwright) 도입은 서버 비용·복잡도 대비 폴백 사용률을 보고 결정.
- robots.txt 확인·요청 간격 제한을 수집 모듈에 내장 (PRD 7.2 법무 리스크).

### 3.3 진행 상태: `analysis_jobs` 테이블 + Realtime

설계 문서의 파이프라인 단계를 그대로 잡 상태로 노출한다.

```
analysis_jobs
  id, user_id, posting_id,
  step: queued → fetching → extracting → matching → scoring → done | failed
  error_code, created_at, updated_at
```

- 클라이언트는 `postgres_changes`로 자신의 잡 행을 구독 → 단계 UI 갱신.
- `failed` 시 `error_code`(fetch_failed / not_a_posting / llm_error / quota_exceeded)로 폴백 UI 분기.

### 3.4 Supabase 클라이언트 사용 규칙

| 클라이언트 | 키 | 사용처 |
|---|---|---|
| 브라우저 클라이언트 | anon key | 화면 조회·취준탭 CRUD (RLS로 보호) |
| 서버 클라이언트 (세션 쿠키) | anon key + 사용자 세션 | Server Components·Route Handler에서 사용자 소유 데이터 접근 |
| service-role 클라이언트 | service_role key | **공유 테이블 쓰기 전용**: job_postings, posting_extractions (사용자 소유가 아니므로 RLS 우회 필요). Route Handler 내부에서만 사용, 절대 클라이언트 노출 금지 |

## 4. Supabase 스키마 & RLS 정책

테이블 정의는 [AI 분석 설계 7장](./AI_ANALYSIS_DESIGN.md#7-데이터-저장-설계) 기준. Supabase 반영 시 결정 사항:

### 4.1 스키마 조정

- `users` 테이블은 별도로 만들지 않고 **`auth.users` + `public.profiles`** 구조를 따른다. 프로필 행은 가입 트리거(`on auth.users insert`)로 자동 생성.
- 상태 enum(`application_status`, `job_step` 등)은 Postgres `enum` 타입으로 정의.
- 발췌 컬럼(company_name, deadline_date 등)은 `generated column` 또는 저장 시 복제로 구현하고 인덱스를 건다 (칸반 정렬·D-day 쿼리).
- 마이그레이션은 Supabase CLI(`supabase/migrations/*.sql`)로 버전 관리하고 저장소에 커밋한다.

### 4.2 RLS 정책 원칙

| 테이블 | 정책 |
|---|---|
| profiles, profile_snapshots | `user_id = auth.uid()` 본인만 select/insert/update |
| match_analyses, applications, application_status_history, usage_logs, analysis_jobs | 본인만 select. **insert/update는 Route Handler(서버)만** — 점수·쿼터를 클라이언트가 조작 못 하게 write 정책은 열지 않고 서버 경유 |
| job_postings, posting_extractions | 인증 사용자 select 허용 (공유 캐시). write는 service-role만 |

- 모든 테이블에 RLS를 **기본 활성화**하고 정책이 없는 접근은 전부 차단(deny-by-default).
- 취준탭의 상태 변경(드래그&드롭)은 예외적으로 클라이언트 직접 update를 허용하되, `application_status_history` 기록은 DB 트리거로 자동 적재해 이력 누락을 막는다.

### 4.3 Realtime 노출 범위

- Realtime publication에는 `analysis_jobs`만 추가한다 (필요 최소). 나머지 테이블은 일반 쿼리로 충분.

## 5. 프로젝트 구조

```
job-confirm/
├─ app/
│  ├─ (marketing)/            # 랜딩 (비로그인)
│  ├─ (auth)/login, signup/
│  ├─ (app)/                  # 로그인 필수 영역 (미들웨어 가드)
│  │  ├─ analyze/             # S4 공고 입력 + S5 진행 + S6 결과
│  │  ├─ board/               # S7 취준탭 칸반 + S8 카드 상세
│  │  ├─ profile/             # S9 프로필 관리
│  │  └─ settings/
│  └─ api/
│     ├─ analyses/route.ts    # POST 분석 시작 (파이프라인 진입점)
│     └─ analyses/[id]/rerun/ # 재분석
├─ lib/
│  ├─ supabase/               # 클라이언트 3종 팩토리 (browser/server/service-role)
│  ├─ scraper/                # 사이트 어댑터 + 범용 추출기 + 정제
│  ├─ ai/
│  │  ├─ extract.ts           # 1단계 구조화 (프롬프트 + 스키마)
│  │  ├─ match.ts             # 2단계 매칭
│  │  ├─ score.ts             # 3단계 점수 산식 (순수 함수 — 단위 테스트 대상)
│  │  ├─ schemas.ts           # structured outputs JSON 스키마 (버전 상수 포함)
│  │  └─ prompts/             # 버전별 프롬프트 (prompt_version과 1:1)
│  └─ quota.ts                # 쿼터 판정
├─ supabase/
│  ├─ migrations/             # SQL 마이그레이션 (스키마의 단일 진실)
│  └─ seed.sql
└─ docs/                      # PRD, 설계 문서
```

- `lib/ai/score.ts`는 LLM 없이 동작하는 순수 함수로 분리 — 산식 변경 시 단위 테스트로 검증한다.
- 프롬프트는 코드와 함께 버전 관리하고, 파일명/상수로 `prompt_version`을 명시해 DB 기록과 일치시킨다.

## 6. 환경 변수

| 변수 | 노출 범위 | 용도 |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | 클라이언트 | Supabase 프로젝트 URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 클라이언트 | RLS 전제의 공개 키 |
| `SUPABASE_SERVICE_ROLE_KEY` | **서버 전용** | 공유 테이블 쓰기 |
| `ANTHROPIC_API_KEY` | **서버 전용** | Claude API |

- `.env.local`은 gitignore, `.env.example`에 키 목록만 커밋.

## 7. MVP 구현 순서 (기술 관점)

PRD 5.4의 마일스톤을 스택에 맞춰 구체화:

1. **M1 — 분석 코어**
   - Next.js 프로젝트 스캐폴드 + Supabase 프로젝트 생성 + 마이그레이션(9개 테이블 + analysis_jobs + RLS)
   - `lib/scraper` (원티드·사람인 + 범용 + 붙여넣기), `lib/ai` 3단계 파이프라인, 점수 산식 단위 테스트
   - `/api/analyses` + 진행 상태 Realtime + 결과 화면(S6)
   - *이 시점에 내부 테스트 가능 (인증은 임시 계정 1개로)*
2. **M2 — 계정·프로필**: Supabase Auth(이메일+Google), 온보딩 위저드(S3), 프로필 관리(S9), 프로필 스냅샷 연결
3. **M3 — 취준탭**: 칸반(S7)·카드 상세(S8), 드래그&드롭 상태 변경 + 이력 트리거, D-day
4. **M4 — 런칭 준비**: 쿼터, 피드백 수집, 랜딩 + 비로그인 체험(구조화까지), Vercel 배포·모니터링

---

*이 문서의 결정은 MVP 기준이다. 잡 큐 도입(재분석 일괄 처리), 헤드리스 브라우저 수집, 카카오 로그인은 각각의 트리거 조건(트래픽·폴백 사용률·가입 전환율)이 충족될 때 재검토한다.*
