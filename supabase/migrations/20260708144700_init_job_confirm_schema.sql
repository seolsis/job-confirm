-- ============================================================================
-- job-confirm — 초기 스키마 (M1-2)
--
-- 근거 문서:
--   - docs/AI_ANALYSIS_DESIGN.md 7장 (테이블 정의)
--   - docs/ARCHITECTURE.md 4장 (Supabase 스키마 조정 & RLS 정책)
--
-- 주의: 이 Supabase 프로젝트는 다른 프로젝트와 공유되므로
--       모든 테이블/타입/함수/트리거 이름에 "jobConfirm_" 접두사를 붙인다.
--       (대소문자 혼용 식별자이므로 반드시 쌍따옴표로 감싸 사용한다)
--
-- 스키마 결정 사항 (ARCHITECTURE.md 4.1):
--   - users 테이블은 만들지 않는다 → auth.users + public."jobConfirm_profiles"
--   - 프로필 행은 가입 트리거(on auth.users insert)로 자동 생성
--   - 상태값은 Postgres enum 타입으로 정의
--   - 발췌 컬럼(company_name 등)은 "저장 시 복제" 방식 + 인덱스
--     (generated column은 jsonb->>date 캐스팅이 IMMUTABLE이 아니라 불가)
-- ============================================================================


-- ============================================================================
-- 1. ENUM 타입
-- ============================================================================

-- 분석 잡 진행 단계 (ARCHITECTURE.md 3.3)
create type "jobConfirm_job_step" as enum (
  'queued',      -- 대기
  'fetching',    -- 공고 수집 중
  'extracting',  -- 공고 구조화 중 (LLM #1)
  'matching',    -- 프로필 매칭 중 (LLM #2)
  'scoring',     -- 점수 산출 중 (서버 규칙)
  'done',        -- 완료
  'failed'       -- 실패 (error_code 참조)
);

-- 분석 잡 실패 사유 (ARCHITECTURE.md 3.3 — 폴백 UI 분기용)
create type "jobConfirm_job_error_code" as enum (
  'fetch_failed',    -- 수집 실패 (봇 차단, 로그인 벽) → 붙여넣기 폴백
  'not_a_posting',   -- 본문이 채용공고가 아님 (404, 목록 페이지)
  'llm_error',       -- LLM 호출 실패
  'quota_exceeded'   -- 무료 쿼터 초과
);

-- 공고 수집 출처 (AI_ANALYSIS_DESIGN.md 7.2 job_postings.source_site)
create type "jobConfirm_posting_source" as enum (
  'wanted',        -- 원티드 어댑터
  'saramin',       -- 사람인 어댑터
  'generic',       -- 범용 본문 추출기
  'manual_paste'   -- 수집 실패 폴백 (본문 직접 붙여넣기)
);

-- 공고 상태 (AI_ANALYSIS_DESIGN.md 7.2 job_postings.status)
create type "jobConfirm_posting_status" as enum (
  'active',        -- 유효
  'closed',        -- 마감
  'fetch_failed'   -- 수집 실패
);

-- 취준탭 카드 상태 8단계 (AI_ANALYSIS_DESIGN.md 7.2 applications.status)
create type "jobConfirm_application_status" as enum (
  'interested',   -- 관심 공고
  'planned',      -- 지원 예정
  'applied',      -- 지원 완료
  'doc_passed',   -- 서류 합격
  'test_passed',  -- 필기 합격
  'interview',    -- 면접 예정
  'accepted',     -- 최종 합격
  'rejected'      -- 불합격 (어느 단계에서든 이동 가능)
);

-- 적합도 등급 (AI_ANALYSIS_DESIGN.md 7.2 match_analyses.grade)
create type "jobConfirm_analysis_grade" as enum (
  'recommend',            -- 80~100 적극 추천
  'challenge',            -- 60~79 도전 가능
  'prepare',              -- 40~59 준비 필요
  'large_gap',            -- 0~39 갭이 큼
  'insufficient_profile'  -- unknown 50% 초과 → 점수 없음 (프로필 부족)
);

-- LLM 호출 종류 (AI_ANALYSIS_DESIGN.md 7.2 usage_logs.kind)
create type "jobConfirm_usage_kind" as enum (
  'extraction',     -- 1단계 공고 구조화
  'match',          -- 2단계 프로필 매칭
  'batch_rematch'   -- 프로필 변경 후 일괄 재분석
);

-- 분석 결과 피드백 (AI_ANALYSIS_DESIGN.md 7.2 match_analyses.feedback)
create type "jobConfirm_feedback_type" as enum (
  'up',   -- 👍
  'down'  -- 👎
);


-- ============================================================================
-- 2. 테이블
-- ============================================================================

-- ----------------------------------------------------------------------------
-- profiles — 현재 프로필 (사용자당 1개, 수정 가능)
-- 섹션들을 jsonb로 두는 이유: 프로필 구조는 초기에 자주 바뀌고,
-- 섹션 내부를 조인·검색할 일이 거의 없다 (분석 시 통째로 직렬화).
-- ----------------------------------------------------------------------------
create table "jobConfirm_profiles" (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null unique references auth.users (id) on delete cascade,
  desired_job        text,                                -- 희망 직무
  desired_conditions jsonb not null default '{}'::jsonb,  -- 희망 연봉/지역/고용형태
  educations         jsonb not null default '[]'::jsonb,  -- [{school, major, degree, status, period}]
  experiences        jsonb not null default '[]'::jsonb,  -- [{company, role, period_months, description}]
  skills             jsonb not null default '[]'::jsonb,  -- [{name, level, years}] — name은 정규화된 기술명
  certificates       jsonb not null default '[]'::jsonb,  -- [{name, issuer, acquired_at}]
  languages          jsonb not null default '[]'::jsonb,  -- [{test, score, acquired_at}]
  projects           jsonb not null default '[]'::jsonb,  -- [{name, role, description, tech}]
  completeness       int   not null default 0
                     check (completeness between 0 and 100),  -- 프로필 완성도 % (서버 계산, UI 게이지용)
  updated_at         timestamptz not null default now()
);

comment on table "jobConfirm_profiles"
  is '현재 프로필 (사용자당 1개). 분석의 비교 기준. auth.users와 1:1';

-- ----------------------------------------------------------------------------
-- profile_snapshots — 분석 시점의 프로필 사본 (불변)
-- 매칭 결과는 "그때의 프로필" 기준이어야 점수 변화 추적(72→81)이 가능하다.
-- ----------------------------------------------------------------------------
create table "jobConfirm_profile_snapshots" (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  snapshot     jsonb not null,       -- 프로필 전체 직렬화
  content_hash text  not null,       -- 프로필이 안 바뀌었으면 기존 스냅샷 재사용 (행 폭증 방지)
  created_at   timestamptz not null default now()
);

comment on table "jobConfirm_profile_snapshots"
  is '분석 시점의 프로필 사본 (불변, append-only)';

-- ----------------------------------------------------------------------------
-- job_postings — 공고 원본 (사용자 무관, 공유 캐시)
-- 같은 공고를 여러 사용자가 분석해도 수집·구조화는 1회만 수행한다.
-- ----------------------------------------------------------------------------
create table "jobConfirm_job_postings" (
  id                   uuid primary key default gen_random_uuid(),
  url                  text,           -- 원본 URL (manual_paste는 null 가능)
  normalized_url       text,           -- 트래킹 파라미터 제거 후
  url_hash             text,           -- 캐시·중복감지 키 (unique index는 아래에서)
  source_site          "jobConfirm_posting_source" not null,
  raw_snapshot         text,           -- 정제된 본문 텍스트 (공고 삭제 대비 열람용)
  snapshot_hash        text,           -- 본문 해시 — 재수집 시 변경 감지 → 구조화 캐시 무효화
  status               "jobConfirm_posting_status" not null default 'active',
  latest_extraction_id uuid,           -- 최신 유효 구조화 버전 (FK는 extractions 생성 후 추가)
  fetched_at           timestamptz,
  created_at           timestamptz not null default now()
);

comment on table "jobConfirm_job_postings"
  is '공고 원본 스냅샷 (사용자 무관, 공유). url_hash가 캐시 키';

-- ----------------------------------------------------------------------------
-- posting_extractions — 1단계 구조화 결과 (공고당 버전별)
-- 공고 1건에 구조화 결과가 여러 버전 있을 수 있다 (재수집·프롬프트 개선).
-- ----------------------------------------------------------------------------
create table "jobConfirm_posting_extractions" (
  id             uuid primary key default gen_random_uuid(),
  posting_id     uuid not null references "jobConfirm_job_postings" (id) on delete cascade,
  extracted      jsonb not null,   -- AI_ANALYSIS_DESIGN.md 3.2 스키마 전체 (14개 필드 + evidence)

  -- 발췌 컬럼 (저장 시 extracted에서 복제) — 목록·정렬·D-day 쿼리용
  company_name   text,
  job_title      text,
  deadline_date  date,

  -- 회귀 비교용 버전 기록 (설계 원칙 5: 모든 결과에 버전을 남긴다)
  model_id       text not null,
  prompt_version text not null,
  schema_version text not null,

  token_usage    jsonb,            -- input/output/cache_read 토큰
  created_at     timestamptz not null default now()
);

comment on table "jobConfirm_posting_extractions"
  is '1단계 공고 구조화 결과 (LLM #1, 공고당 버전별, 사용자 간 공유 캐시)';

-- job_postings.latest_extraction_id → posting_extractions (순환 참조라 여기서 추가)
alter table "jobConfirm_job_postings"
  add constraint "jobConfirm_job_postings_latest_extraction_id_fkey"
  foreign key (latest_extraction_id)
  references "jobConfirm_posting_extractions" (id) on delete set null;

-- ----------------------------------------------------------------------------
-- match_analyses — 2단계 매칭 결과 (사용자별, 불변)
-- 재분석 시 새 행을 만든다. 시계열이 곧 "점수 변화 추적" 데이터.
-- ----------------------------------------------------------------------------
create table "jobConfirm_match_analyses" (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users (id) on delete cascade,
  extraction_id       uuid not null references "jobConfirm_posting_extractions" (id),      -- 어떤 구조화 버전 기준인지
  profile_snapshot_id uuid not null references "jobConfirm_profile_snapshots" (id) on delete cascade,  -- 어떤 프로필 기준인지
  result              jsonb not null,   -- AI_ANALYSIS_DESIGN.md 4.2 스키마 전체
  score               int check (score between 0 and 100),  -- 서버 산출 종합 점수. "프로필 부족" 시 null
  grade               "jobConfirm_analysis_grade" not null,
  score_breakdown     jsonb,            -- 산식 항목별 점수 (①②③) — "왜 72점" 펼쳐보기용
  critical_gap_count  int not null default 0 check (critical_gap_count >= 0),  -- 필수요건 not_met 수 (경고 뱃지)

  -- 회귀 비교용 버전 기록
  model_id            text not null,
  prompt_version      text not null,
  schema_version      text not null,

  token_usage         jsonb,
  feedback            "jobConfirm_feedback_type",  -- up / down / null
  feedback_reason     text,                        -- 👎 사유 (선택 입력)
  created_at          timestamptz not null default now()
);

comment on table "jobConfirm_match_analyses"
  is '2단계 프로필 매칭 결과 (LLM #2 + 서버 점수 산식, 사용자별, append-only)';

-- ----------------------------------------------------------------------------
-- applications — 취준탭 카드 (공고에 대한 나의 진행 상태)
-- ----------------------------------------------------------------------------
create table "jobConfirm_applications" (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users (id) on delete cascade,
  posting_id         uuid not null references "jobConfirm_job_postings" (id),
  latest_analysis_id uuid references "jobConfirm_match_analyses" (id) on delete set null,  -- 카드에 표시할 최신 매칭 결과
  status             "jobConfirm_application_status" not null default 'interested',
  rejected_at_stage  text,                                -- 불합격 시 탈락 단계 (전환율 통계용)
  memo               text,
  schedule           jsonb not null default '[]'::jsonb,  -- [{type: interview/test/deadline, at, note}]
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  -- 같은 공고 중복 카드 방지
  constraint "jobConfirm_applications_user_posting_unique" unique (user_id, posting_id)
);

comment on table "jobConfirm_applications"
  is '취준탭 칸반 카드. 공고(job_postings)와 분리해 나의 진행 상태만 담는다';

-- ----------------------------------------------------------------------------
-- application_status_history — 상태 변경 이력 (전환율 통계·회고 리포트의 원천)
-- 기록 누락 방지를 위해 DB 트리거로 자동 적재한다 (ARCHITECTURE.md 4.2).
-- ----------------------------------------------------------------------------
create table "jobConfirm_application_status_history" (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid not null references "jobConfirm_applications" (id) on delete cascade,
  from_status    "jobConfirm_application_status" not null,
  to_status      "jobConfirm_application_status" not null,
  changed_at     timestamptz not null default now()
);

comment on table "jobConfirm_application_status_history"
  is '카드 상태 변경 이력. applications.status 변경 시 트리거로 자동 기록';

-- ----------------------------------------------------------------------------
-- usage_logs — LLM 호출·쿼터 기록 (월별 집계로 쿼터 판정)
-- ----------------------------------------------------------------------------
create table "jobConfirm_usage_logs" (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  kind          "jobConfirm_usage_kind" not null,
  was_cache_hit boolean not null default false,  -- true면 쿼터 미차감
  token_usage   jsonb,
  created_at    timestamptz not null default now()
);

comment on table "jobConfirm_usage_logs"
  is 'LLM 호출·쿼터 기록. 월별 집계로 무료 쿼터를 판정한다';

-- ----------------------------------------------------------------------------
-- analysis_jobs — 분석 잡 진행 상태 (ARCHITECTURE.md 3.3)
-- 진행 상태는 응답 스트림이 아니라 이 테이블 + Realtime 구독으로 전달한다.
-- 사용자가 페이지를 이탈·새로고침해도 진행 중인 분석에 다시 붙을 수 있다.
-- ----------------------------------------------------------------------------
create table "jobConfirm_analysis_jobs" (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  posting_id uuid references "jobConfirm_job_postings" (id) on delete set null,  -- 수집 전 큐잉 시점에는 null
  step       "jobConfirm_job_step" not null default 'queued',
  error_code "jobConfirm_job_error_code",  -- failed일 때만. 폴백 UI 분기용
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table "jobConfirm_analysis_jobs"
  is '분석 파이프라인 진행 상태. Realtime publication에 노출되는 유일한 테이블';


-- ============================================================================
-- 3. 인덱스
-- ============================================================================

-- 캐시·중복감지 키 (같은 URL 재분석 시 구조화 재사용)
create unique index "jobConfirm_job_postings_url_hash_idx"
  on "jobConfirm_job_postings" (url_hash);

-- 스냅샷 재사용 조회 (content_hash가 같으면 기존 스냅샷 사용)
create index "jobConfirm_profile_snapshots_user_hash_idx"
  on "jobConfirm_profile_snapshots" (user_id, content_hash);

-- 발췌 컬럼 인덱스 — 칸반 정렬·D-day·회사명 검색 (ARCHITECTURE.md 4.1)
create index "jobConfirm_posting_extractions_posting_idx"
  on "jobConfirm_posting_extractions" (posting_id, created_at desc);
create index "jobConfirm_posting_extractions_deadline_idx"
  on "jobConfirm_posting_extractions" (deadline_date);
create index "jobConfirm_posting_extractions_company_idx"
  on "jobConfirm_posting_extractions" (company_name);

-- 사용자별 분석 시계열 (최근 분석 목록·점수 변화 추적)
create index "jobConfirm_match_analyses_user_idx"
  on "jobConfirm_match_analyses" (user_id, created_at desc);
create index "jobConfirm_match_analyses_extraction_idx"
  on "jobConfirm_match_analyses" (extraction_id);

-- 칸반 보드 조회 (상태 컬럼별 카드 목록)
create index "jobConfirm_applications_user_status_idx"
  on "jobConfirm_applications" (user_id, status);

-- 카드 상세의 이력 타임라인
create index "jobConfirm_application_status_history_app_idx"
  on "jobConfirm_application_status_history" (application_id, changed_at desc);

-- 월별 쿼터 집계 (user_id + 기간 범위 스캔)
create index "jobConfirm_usage_logs_user_created_idx"
  on "jobConfirm_usage_logs" (user_id, created_at desc);

-- 진행 중인 잡 조회
create index "jobConfirm_analysis_jobs_user_idx"
  on "jobConfirm_analysis_jobs" (user_id, created_at desc);


-- ============================================================================
-- 4. 트리거
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 4.1 가입 시 프로필 행 자동 생성 (ARCHITECTURE.md 4.1)
-- ----------------------------------------------------------------------------
create function "jobConfirm_handle_new_user"()
returns trigger
language plpgsql
security definer                -- auth.users 트리거는 소유자 권한으로 실행돼야 함
set search_path = ''            -- search_path 하이재킹 방지
as $$
begin
  insert into public."jobConfirm_profiles" (user_id)
  values (new.id);
  return new;
end;
$$;

create trigger "jobConfirm_on_auth_user_created"
  after insert on auth.users
  for each row
  execute function "jobConfirm_handle_new_user"();

-- ----------------------------------------------------------------------------
-- 4.2 카드 상태 변경 이력 자동 적재 (ARCHITECTURE.md 4.2)
-- 클라이언트 직접 update(드래그&드롭)를 허용하는 대신 이력 누락을 트리거로 막는다.
-- ----------------------------------------------------------------------------
create function "jobConfirm_log_application_status_change"()
returns trigger
language plpgsql
security definer                -- 이력 테이블은 클라이언트 write 정책이 없으므로 definer로 기록
set search_path = ''
as $$
begin
  if new.status is distinct from old.status then
    insert into public."jobConfirm_application_status_history"
      (application_id, from_status, to_status)
    values
      (new.id, old.status, new.status);
  end if;
  return new;
end;
$$;

create trigger "jobConfirm_on_application_status_change"
  after update of status on "jobConfirm_applications"
  for each row
  execute function "jobConfirm_log_application_status_change"();

-- ----------------------------------------------------------------------------
-- 4.3 updated_at 자동 갱신 (profiles / applications / analysis_jobs)
-- ----------------------------------------------------------------------------
create function "jobConfirm_set_updated_at"()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger "jobConfirm_profiles_set_updated_at"
  before update on "jobConfirm_profiles"
  for each row
  execute function "jobConfirm_set_updated_at"();

create trigger "jobConfirm_applications_set_updated_at"
  before update on "jobConfirm_applications"
  for each row
  execute function "jobConfirm_set_updated_at"();

create trigger "jobConfirm_analysis_jobs_set_updated_at"
  before update on "jobConfirm_analysis_jobs"
  for each row
  execute function "jobConfirm_set_updated_at"();


-- ============================================================================
-- 5. RLS (Row Level Security) — ARCHITECTURE.md 4.2
--
-- 원칙: 모든 테이블 RLS 활성화, 정책 없는 접근은 전부 차단 (deny-by-default).
--   - profiles, profile_snapshots      : 본인만 select / insert / update
--   - match_analyses, applications,
--     status_history, usage_logs,
--     analysis_jobs                    : 본인만 select.
--                                        insert/update는 서버(service-role)만 —
--                                        점수·쿼터를 클라이언트가 조작 못 하게
--                                        write 정책은 열지 않는다.
--                                        (예외: applications의 상태 변경은
--                                         드래그&드롭을 위해 클라이언트 update 허용)
--   - job_postings, posting_extractions: 인증 사용자 select (공유 캐시).
--                                        write는 service-role만.
--
-- service_role은 RLS를 우회(bypassrls)하므로 서버 전용 write에는 정책이 필요 없다.
-- ============================================================================

alter table "jobConfirm_profiles"                   enable row level security;
alter table "jobConfirm_profile_snapshots"          enable row level security;
alter table "jobConfirm_job_postings"               enable row level security;
alter table "jobConfirm_posting_extractions"        enable row level security;
alter table "jobConfirm_match_analyses"             enable row level security;
alter table "jobConfirm_applications"               enable row level security;
alter table "jobConfirm_application_status_history" enable row level security;
alter table "jobConfirm_usage_logs"                 enable row level security;
alter table "jobConfirm_analysis_jobs"              enable row level security;

-- ---- profiles: 본인만 select / insert / update -----------------------------
create policy "jobConfirm_profiles_select_own"
  on "jobConfirm_profiles" for select
  to authenticated
  using (user_id = (select auth.uid()));

create policy "jobConfirm_profiles_insert_own"
  on "jobConfirm_profiles" for insert
  to authenticated
  with check (user_id = (select auth.uid()));

create policy "jobConfirm_profiles_update_own"
  on "jobConfirm_profiles" for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- ---- profile_snapshots: 본인만 select / insert / update --------------------
create policy "jobConfirm_profile_snapshots_select_own"
  on "jobConfirm_profile_snapshots" for select
  to authenticated
  using (user_id = (select auth.uid()));

create policy "jobConfirm_profile_snapshots_insert_own"
  on "jobConfirm_profile_snapshots" for insert
  to authenticated
  with check (user_id = (select auth.uid()));

create policy "jobConfirm_profile_snapshots_update_own"
  on "jobConfirm_profile_snapshots" for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- ---- job_postings / posting_extractions: 인증 사용자 select (공유 캐시) ----
create policy "jobConfirm_job_postings_select_authenticated"
  on "jobConfirm_job_postings" for select
  to authenticated
  using (true);

create policy "jobConfirm_posting_extractions_select_authenticated"
  on "jobConfirm_posting_extractions" for select
  to authenticated
  using (true);

-- ---- match_analyses: 본인만 select (write는 서버만) -------------------------
create policy "jobConfirm_match_analyses_select_own"
  on "jobConfirm_match_analyses" for select
  to authenticated
  using (user_id = (select auth.uid()));

-- ---- applications: 본인만 select + update (상태 드래그&드롭 예외 허용) -------
create policy "jobConfirm_applications_select_own"
  on "jobConfirm_applications" for select
  to authenticated
  using (user_id = (select auth.uid()));

create policy "jobConfirm_applications_update_own"
  on "jobConfirm_applications" for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- ---- application_status_history: 본인 카드의 이력만 select ------------------
create policy "jobConfirm_application_status_history_select_own"
  on "jobConfirm_application_status_history" for select
  to authenticated
  using (
    exists (
      select 1
      from "jobConfirm_applications" a
      where a.id = application_id
        and a.user_id = (select auth.uid())
    )
  );

-- ---- usage_logs: 본인만 select ----------------------------------------------
create policy "jobConfirm_usage_logs_select_own"
  on "jobConfirm_usage_logs" for select
  to authenticated
  using (user_id = (select auth.uid()));

-- ---- analysis_jobs: 본인만 select (Realtime 구독도 이 정책을 따른다) ---------
create policy "jobConfirm_analysis_jobs_select_own"
  on "jobConfirm_analysis_jobs" for select
  to authenticated
  using (user_id = (select auth.uid()));


-- ============================================================================
-- 6. GRANT
-- Supabase 신규 기본값은 public 스키마 새 테이블을 Data API 롤에 자동 노출하지
-- 않으므로, RLS 정책과 일치하는 최소 권한만 명시적으로 부여한다.
-- (행 단위 접근 제어는 위 RLS가 담당 — GRANT는 문 단위 허용 범위)
-- ============================================================================

-- 서버(service_role): 전체 권한 (RLS 우회)
grant all on table
  "jobConfirm_profiles",
  "jobConfirm_profile_snapshots",
  "jobConfirm_job_postings",
  "jobConfirm_posting_extractions",
  "jobConfirm_match_analyses",
  "jobConfirm_applications",
  "jobConfirm_application_status_history",
  "jobConfirm_usage_logs",
  "jobConfirm_analysis_jobs"
to service_role;

-- 본인 데이터 read/write 테이블
grant select, insert, update on table
  "jobConfirm_profiles",
  "jobConfirm_profile_snapshots"
to authenticated;

-- 카드: 조회 + 상태 변경(드래그&드롭)
grant select, update on table "jobConfirm_applications" to authenticated;

-- 조회 전용 테이블
grant select on table
  "jobConfirm_job_postings",
  "jobConfirm_posting_extractions",
  "jobConfirm_match_analyses",
  "jobConfirm_application_status_history",
  "jobConfirm_usage_logs",
  "jobConfirm_analysis_jobs"
to authenticated;


-- ============================================================================
-- 7. Realtime — analysis_jobs만 노출 (ARCHITECTURE.md 4.3: 필요 최소)
-- 클라이언트는 postgres_changes로 자신의 잡 행을 구독해 진행 단계 UI를 갱신한다.
-- ============================================================================

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table "jobConfirm_analysis_jobs";
  else
    create publication supabase_realtime for table "jobConfirm_analysis_jobs";
  end if;
end;
$$;
