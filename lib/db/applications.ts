import type { SupabaseClient } from "@supabase/supabase-js";

import type { AnalysisGrade } from "./match-analyses";
import { StorageError } from "./errors";

/**
 * applications(취준탭 카드) 저장 계층 (M3-1) — AI_ANALYSIS_DESIGN.md 7.2, PRD 2.3
 *
 * 권한 구분 (ARCHITECTURE.md 4.2):
 *  - 카드 생성: 서버(service-role)만 — authenticated에는 insert grant가 없다.
 *    분석 결과에서 [취준탭에 저장]은 /api/applications(Route Handler)를 거친다.
 *  - 상태·메모 변경: 클라이언트 직접 update 허용 (드래그&드롭 반응성을 위한 예외).
 *    상태 변경 이력은 DB 트리거("jobConfirm_on_application_status_change")가
 *    자동 적재하므로 여기서 이력을 만들지 않는다.
 *
 * 상태 전이 정책 (PRD 2.3): 순방향이 기본이지만 강제하지 않는다 — 자유 이동 허용.
 * 단, rejected로 이동할 때는 탈락 단계(rejected_at_stage)를 함께 기록한다 (전환율 통계).
 */

const APPLICATIONS_TABLE = "jobConfirm_applications";

/**
 * DB enum "jobConfirm_application_status" — 칸반 6단계 (PRD 3.2 S7 컬럼 순서).
 * DB enum 자체는 8개 값(planned, test_passed 포함)을 갖지만, 관심 공고는 지원
 * 예정과 사실상 동일하고 서류/필기 합격은 하나의 "합격" 단계로 충분해 보드에는
 * 6단계만 노출한다. 기존 planned/test_passed 데이터는 interested/doc_passed로
 * 병합해 둔다 (스키마 변경 없이 표시 단계만 줄인다).
 */
export const APPLICATION_STATUSES = [
  "interested",
  "applied",
  "doc_passed",
  "interview",
  "accepted",
  "rejected",
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

/** jobConfirm_applications 행 */
export interface ApplicationRow {
  id: string;
  user_id: string;
  posting_id: string;
  /** 카드에 표시할 최신 매칭 결과 */
  latest_analysis_id: string | null;
  status: ApplicationStatus;
  /** 불합격 시 탈락 단계 (통계용) */
  rejected_at_stage: string | null;
  memo: string | null;
  schedule: Array<{ type: string; at: string; note?: string }>;
  created_at: string;
  updated_at: string;
}

/** 보드 카드에 필요한 조인 데이터 — 발췌 컬럼(회사/직무/마감) + 점수 */
export interface ApplicationCard {
  application: ApplicationRow;
  company_name: string | null;
  job_title: string | null;
  /** YYYY-MM-DD — D-day 계산의 원천 (posting_extractions 발췌 컬럼) */
  deadline_date: string | null;
  /** 공고 원문 링크 (manual_paste는 null) */
  url: string | null;
  score: number | null;
  grade: AnalysisGrade | null;
}

/**
 * D-day 계산 (순수 함수) — 마감일까지 남은 일수.
 * 오늘 마감 = 0, 지났으면 음수, 마감일 없으면 null. 날짜 단위로만 비교한다.
 */
export function daysUntil(date: string | null, now: () => Date = () => new Date()): number | null {
  if (date === null || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const target = new Date(`${date}T00:00:00`);
  if (Number.isNaN(target.getTime())) return null;
  const today = now();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((target.getTime() - startOfToday.getTime()) / 86_400_000);
}

/**
 * 카드 생성 (service-role 전용) — 분석 결과에서 [취준탭에 저장].
 * (user_id, posting_id) unique — 같은 공고를 다시 저장하면 기존 카드를 돌려주고
 * latest_analysis_id만 최신으로 갱신한다 (재분석 후 재저장 시나리오).
 */
export async function createApplication(
  supabase: SupabaseClient,
  params: { userId: string; postingId: string; analysisId: string }
): Promise<{ row: ApplicationRow; alreadySaved: boolean }> {
  const { data, error } = await supabase
    .from(APPLICATIONS_TABLE)
    .insert({
      user_id: params.userId,
      posting_id: params.postingId,
      latest_analysis_id: params.analysisId,
    })
    .select()
    .single();

  if (error === null) return { row: data as ApplicationRow, alreadySaved: false };

  if (error.code === "23505") {
    // 이미 저장된 공고 — 카드를 중복 생성하지 않고 최신 분석만 연결한다
    const { data: updated, error: updateError } = await supabase
      .from(APPLICATIONS_TABLE)
      .update({ latest_analysis_id: params.analysisId })
      .eq("user_id", params.userId)
      .eq("posting_id", params.postingId)
      .select()
      .single();

    if (updateError) {
      throw new StorageError(
        `기존 카드 갱신 실패 (posting: ${params.postingId}): ${updateError.message}`,
        {
          cause: updateError,
        }
      );
    }
    return { row: updated as ApplicationRow, alreadySaved: true };
  }

  throw new StorageError(`카드 생성 실패 (posting: ${params.postingId}): ${error.message}`, {
    cause: error,
  });
}

export async function getApplicationById(
  supabase: SupabaseClient,
  applicationId: string
): Promise<ApplicationRow | null> {
  const { data, error } = await supabase
    .from(APPLICATIONS_TABLE)
    .select("*")
    .eq("id", applicationId)
    .maybeSingle();

  if (error) {
    throw new StorageError(`카드 조회 실패 (id: ${applicationId}): ${error.message}`, {
      cause: error,
    });
  }
  return (data as ApplicationRow | null) ?? null;
}

/**
 * 상태 변경 (클라이언트 직접 update — RLS 본인만).
 * rejected로 이동하면 탈락 단계를 함께 기록하고, 다른 상태로 이동하면 비운다.
 * 이력은 DB 트리거가 적재한다.
 */
export async function updateApplicationStatus(
  supabase: SupabaseClient,
  applicationId: string,
  status: ApplicationStatus,
  options: { rejectedAtStage?: string | null } = {}
): Promise<ApplicationRow> {
  const { data, error } = await supabase
    .from(APPLICATIONS_TABLE)
    .update({
      status,
      rejected_at_stage: status === "rejected" ? (options.rejectedAtStage ?? null) : null,
    })
    .eq("id", applicationId)
    .select()
    .single();

  if (error) {
    throw new StorageError(`상태 변경 실패 (id: ${applicationId}): ${error.message}`, {
      cause: error,
    });
  }
  return data as ApplicationRow;
}

/** 카드 일정 항목 — applications.schedule jsonb의 원소 (P1: 면접일 등 입력) */
export interface ScheduleEntry {
  /** interview | test | deadline | other */
  type: string;
  /** YYYY-MM-DD */
  at: string;
  note?: string;
}

/** 일정 저장 (클라이언트 직접 update — RLS 본인만). 배열 전체를 교체한다 */
export async function updateApplicationSchedule(
  supabase: SupabaseClient,
  applicationId: string,
  schedule: ScheduleEntry[]
): Promise<ApplicationRow> {
  const { data, error } = await supabase
    .from(APPLICATIONS_TABLE)
    .update({ schedule })
    .eq("id", applicationId)
    .select()
    .single();

  if (error) {
    throw new StorageError(`일정 저장 실패 (id: ${applicationId}): ${error.message}`, {
      cause: error,
    });
  }
  return data as ApplicationRow;
}

/**
 * 다가오는 일정 중 가장 가까운 것 (순수 함수) — 보드 카드의 일정 칩용.
 * 오늘 포함 미래 일정만 대상, 없으면 null.
 */
export function nextUpcomingSchedule(
  schedule: ScheduleEntry[],
  now: () => Date = () => new Date()
): ScheduleEntry | null {
  const upcoming = schedule
    .filter((entry) => {
      const dday = daysUntil(entry.at, now);
      return dday !== null && dday >= 0;
    })
    .sort((a, b) => a.at.localeCompare(b.at));
  return upcoming[0] ?? null;
}

/** 메모 저장 (클라이언트 직접 update — RLS 본인만) */
export async function updateApplicationMemo(
  supabase: SupabaseClient,
  applicationId: string,
  memo: string
): Promise<ApplicationRow> {
  const { data, error } = await supabase
    .from(APPLICATIONS_TABLE)
    .update({ memo: memo.trim() === "" ? null : memo })
    .eq("id", applicationId)
    .select()
    .single();

  if (error) {
    throw new StorageError(`메모 저장 실패 (id: ${applicationId}): ${error.message}`, {
      cause: error,
    });
  }
  return data as ApplicationRow;
}

/* ── 보드/상세용 조인 조회 ──────────────────────────────────────────────────
 * PostgREST 임베드 대신 배치 조회 3-4회로 합성한다 — 대소문자 혼용 테이블명의
 * 임베드 구문 리스크를 피하고, fake로 단위 테스트하기 쉽다.
 * RLS: applications·match_analyses는 본인 행만, postings·extractions는 공유 select. */

interface PostingSlim {
  id: string;
  url: string | null;
  latest_extraction_id: string | null;
}
interface ExtractionSlim {
  id: string;
  company_name: string | null;
  job_title: string | null;
  deadline_date: string | null;
}
interface AnalysisSlim {
  id: string;
  score: number | null;
  grade: AnalysisGrade;
}

async function fetchCardJoins(
  supabase: SupabaseClient,
  applications: ApplicationRow[]
): Promise<Map<string, Omit<ApplicationCard, "application">>> {
  const postingIds = [...new Set(applications.map((a) => a.posting_id))];
  const analysisIds = [
    ...new Set(
      applications.flatMap((a) => (a.latest_analysis_id !== null ? [a.latest_analysis_id] : []))
    ),
  ];

  const { data: postings, error: postingsError } = await supabase
    .from("jobConfirm_job_postings")
    .select("id, url, latest_extraction_id")
    .in("id", postingIds);
  if (postingsError) {
    throw new StorageError(`공고 배치 조회 실패: ${postingsError.message}`, {
      cause: postingsError,
    });
  }

  const extractionIds = [
    ...new Set(
      ((postings ?? []) as PostingSlim[]).flatMap((p) =>
        p.latest_extraction_id !== null ? [p.latest_extraction_id] : []
      )
    ),
  ];
  const { data: extractions, error: extractionsError } =
    extractionIds.length > 0
      ? await supabase
          .from("jobConfirm_posting_extractions")
          .select("id, company_name, job_title, deadline_date")
          .in("id", extractionIds)
      : { data: [], error: null };
  if (extractionsError) {
    throw new StorageError(`구조화 배치 조회 실패: ${extractionsError.message}`, {
      cause: extractionsError,
    });
  }

  const { data: analyses, error: analysesError } =
    analysisIds.length > 0
      ? await supabase
          .from("jobConfirm_match_analyses")
          .select("id, score, grade")
          .in("id", analysisIds)
      : { data: [], error: null };
  if (analysesError) {
    throw new StorageError(`분석 배치 조회 실패: ${analysesError.message}`, {
      cause: analysesError,
    });
  }

  const postingById = new Map(((postings ?? []) as PostingSlim[]).map((p) => [p.id, p]));
  const extractionById = new Map(((extractions ?? []) as ExtractionSlim[]).map((e) => [e.id, e]));
  const analysisById = new Map(((analyses ?? []) as AnalysisSlim[]).map((a) => [a.id, a]));

  const joins = new Map<string, Omit<ApplicationCard, "application">>();
  for (const app of applications) {
    const posting = postingById.get(app.posting_id) ?? null;
    const extraction =
      posting?.latest_extraction_id != null
        ? (extractionById.get(posting.latest_extraction_id) ?? null)
        : null;
    const analysis =
      app.latest_analysis_id !== null ? (analysisById.get(app.latest_analysis_id) ?? null) : null;

    joins.set(app.id, {
      company_name: extraction?.company_name ?? null,
      job_title: extraction?.job_title ?? null,
      deadline_date: extraction?.deadline_date ?? null,
      url: posting?.url ?? null,
      score: analysis?.score ?? null,
      grade: analysis?.grade ?? null,
    });
  }
  return joins;
}

/** 보드(S7)용 — 내 카드 전체 + 표시 필드. RLS가 본인 행으로 스코프한다 */
export async function listApplicationCards(supabase: SupabaseClient): Promise<ApplicationCard[]> {
  const { data, error } = await supabase
    .from(APPLICATIONS_TABLE)
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    throw new StorageError(`카드 목록 조회 실패: ${error.message}`, { cause: error });
  }
  const applications = (data ?? []) as ApplicationRow[];
  if (applications.length === 0) return [];

  const joins = await fetchCardJoins(supabase, applications);
  return applications.map((application) => ({
    application,
    ...(joins.get(application.id) as Omit<ApplicationCard, "application">),
  }));
}

/**
 * 유사 공고 감지 (P1, PRD 7.1 #4) — 같은 회사·직무의 카드가 이미 있는지.
 * 다른 URL(사람인/원티드/자사)로 같은 공고를 저장하는 경우를 잡는다.
 * 정확 일치(회사명+직무명)만 본다 — 과잉 경고를 피하기 위해 느슨한 매칭은 하지 않는다.
 * service-role 전용 (extractions를 회사·직무로 역조회하므로 /api/applications에서 호출).
 */
export async function findSimilarApplication(
  supabase: SupabaseClient,
  params: {
    userId: string;
    companyName: string | null;
    jobTitle: string | null;
    /** 지금 저장하려는 공고 자신은 제외 */
    excludePostingId: string;
  }
): Promise<ApplicationRow | null> {
  if (params.companyName === null || params.jobTitle === null) return null;

  const { data: extractions, error: extractionsError } = await supabase
    .from("jobConfirm_posting_extractions")
    .select("posting_id")
    .eq("company_name", params.companyName)
    .eq("job_title", params.jobTitle)
    .neq("posting_id", params.excludePostingId);
  if (extractionsError) {
    throw new StorageError(`유사 공고 조회 실패: ${extractionsError.message}`, {
      cause: extractionsError,
    });
  }

  const postingIds = [
    ...new Set(((extractions ?? []) as Array<{ posting_id: string }>).map((e) => e.posting_id)),
  ];
  if (postingIds.length === 0) return null;

  const { data: application, error: applicationError } = await supabase
    .from(APPLICATIONS_TABLE)
    .select("*")
    .eq("user_id", params.userId)
    .in("posting_id", postingIds)
    .limit(1)
    .maybeSingle();
  if (applicationError) {
    throw new StorageError(`유사 카드 조회 실패: ${applicationError.message}`, {
      cause: applicationError,
    });
  }
  return (application as ApplicationRow | null) ?? null;
}

/** 카드 상세(S8)용 — 단건 + 표시 필드 */
export async function getApplicationCard(
  supabase: SupabaseClient,
  applicationId: string
): Promise<ApplicationCard | null> {
  const application = await getApplicationById(supabase, applicationId);
  if (application === null) return null;

  const joins = await fetchCardJoins(supabase, [application]);
  return { application, ...(joins.get(application.id) as Omit<ApplicationCard, "application">) };
}
