import type { SupabaseClient } from "@supabase/supabase-js";

import { StorageError } from "./errors";

/**
 * analysis_jobs 상태 관리 (M1-12) — ARCHITECTURE.md 3.3, AI_ANALYSIS_DESIGN.md 2장
 *
 * 분석 파이프라인 진행 상태를 DB 행으로 노출한다. 클라이언트는 이 행을
 * Realtime으로 구독해 단계 UI를 갱신한다 (Realtime 연결은 M1-13+).
 *
 * updated_at은 DB 트리거("jobConfirm_analysis_jobs_set_updated_at")가
 * update 시 자동 갱신하므로 여기서 직접 쓰지 않는다.
 * write는 service-role 클라이언트만 가능하다 (RLS: 본인 select만 허용).
 */

const JOBS_TABLE = "jobConfirm_analysis_jobs";

/** DB enum "jobConfirm_job_step" — 파이프라인 단계와 1:1 */
export type JobStep =
  | "queued" // 대기
  | "fetching" // 공고 수집 중
  | "extracting" // 공고 구조화 중 (LLM #1)
  | "matching" // 프로필 매칭 중 (LLM #2)
  | "scoring" // 점수 산출 중 (서버 규칙)
  | "done" // 완료
  | "failed"; // 실패 (error_code 참조)

/** DB enum "jobConfirm_job_error_code" — failed일 때만. 폴백 UI 분기용 */
export type JobErrorCode =
  | "fetch_failed" // 수집 실패 (봇 차단, 로그인 벽) → 붙여넣기 폴백
  | "not_a_posting" // 본문이 채용공고가 아님 (404, 목록 페이지)
  | "llm_error" // LLM 호출 실패
  | "quota_exceeded"; // 무료 쿼터 초과

/** jobConfirm_analysis_jobs 행 */
export interface AnalysisJobRow {
  id: string;
  user_id: string;
  /** 수집 전 큐잉 시점에는 null — 수집 후 updateAnalysisJobStep의 postingId로 채운다 */
  posting_id: string | null;
  step: JobStep;
  error_code: JobErrorCode | null;
  created_at: string;
  updated_at: string;
}

/** 진행 단계의 순서 (failed는 순서 밖 — 어느 단계에서든 진입 가능) */
const STEP_ORDER: readonly JobStep[] = [
  "queued",
  "fetching",
  "extracting",
  "matching",
  "scoring",
  "done",
];

/**
 * 상태 전이 규칙 (순수 함수):
 *  - 전진만 허용. 단계 건너뜀 가능 — 캐시 히트 시 fetching/extracting을 건너뛴다 (6.2)
 *  - 어느 진행 단계에서든 failed로 전이 가능
 *  - done / failed는 종결 상태 — 재시도는 새 잡을 만든다 (행 이력 보존)
 */
export function isValidStepTransition(from: JobStep, to: JobStep): boolean {
  if (from === "done" || from === "failed") return false;
  if (to === "failed") return true;
  return STEP_ORDER.indexOf(to) > STEP_ORDER.indexOf(from);
}

/** 잘못된 상태 전이 — 파이프라인 버그 신호이므로 StorageError와 구분해 던진다 */
export class JobTransitionError extends Error {
  readonly from: JobStep;
  readonly to: JobStep;

  constructor(jobId: string, from: JobStep, to: JobStep) {
    super(`허용되지 않는 잡 상태 전이 (job: ${jobId}): ${from} → ${to}`);
    this.name = "JobTransitionError";
    this.from = from;
    this.to = to;
  }
}

/** 분석 잡 생성 — step은 DB 기본값 queued로 시작한다 */
export async function createAnalysisJob(
  supabase: SupabaseClient,
  params: { userId: string; postingId?: string | null }
): Promise<AnalysisJobRow> {
  const { data, error } = await supabase
    .from(JOBS_TABLE)
    .insert({ user_id: params.userId, posting_id: params.postingId ?? null })
    .select()
    .single();

  if (error) {
    throw new StorageError(`분석 잡 생성 실패 (user: ${params.userId}): ${error.message}`, {
      cause: error,
    });
  }
  return data as AnalysisJobRow;
}

export async function getAnalysisJob(
  supabase: SupabaseClient,
  jobId: string
): Promise<AnalysisJobRow | null> {
  const { data, error } = await supabase.from(JOBS_TABLE).select("*").eq("id", jobId).maybeSingle();

  if (error) {
    throw new StorageError(`분석 잡 조회 실패 (job: ${jobId}): ${error.message}`, {
      cause: error,
    });
  }
  return (data as AnalysisJobRow | null) ?? null;
}

/**
 * 진행 단계 전이. 전이 규칙 위반이면 JobTransitionError.
 * postingId를 주면 함께 기록한다 (수집 완료 시점에 posting_id 연결).
 * updated_at은 DB 트리거가 갱신한다.
 */
export async function updateAnalysisJobStep(
  supabase: SupabaseClient,
  jobId: string,
  step: Exclude<JobStep, "failed">, // 실패 전이는 failAnalysisJob으로 (error_code 강제)
  options: { postingId?: string } = {}
): Promise<AnalysisJobRow> {
  const current = await requireJob(supabase, jobId);
  if (!isValidStepTransition(current.step, step)) {
    throw new JobTransitionError(jobId, current.step, step);
  }

  return updateJob(supabase, jobId, {
    step,
    ...(options.postingId !== undefined && { posting_id: options.postingId }),
  });
}

/** 실패 전이 — error_code를 반드시 함께 기록한다 (폴백 UI 분기의 원천) */
export async function failAnalysisJob(
  supabase: SupabaseClient,
  jobId: string,
  errorCode: JobErrorCode
): Promise<AnalysisJobRow> {
  const current = await requireJob(supabase, jobId);
  if (!isValidStepTransition(current.step, "failed")) {
    throw new JobTransitionError(jobId, current.step, "failed");
  }

  return updateJob(supabase, jobId, { step: "failed", error_code: errorCode });
}

async function requireJob(supabase: SupabaseClient, jobId: string): Promise<AnalysisJobRow> {
  const job = await getAnalysisJob(supabase, jobId);
  if (job === null) {
    throw new StorageError(`분석 잡을 찾을 수 없습니다 (job: ${jobId})`);
  }
  return job;
}

async function updateJob(
  supabase: SupabaseClient,
  jobId: string,
  values: Record<string, unknown>
): Promise<AnalysisJobRow> {
  const { data, error } = await supabase
    .from(JOBS_TABLE)
    .update(values)
    .eq("id", jobId)
    .select()
    .single();

  if (error) {
    throw new StorageError(`분석 잡 갱신 실패 (job: ${jobId}): ${error.message}`, {
      cause: error,
    });
  }
  return data as AnalysisJobRow;
}
