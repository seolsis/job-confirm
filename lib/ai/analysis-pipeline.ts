import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  createAnalysisJob,
  failAnalysisJob,
  updateAnalysisJobStep,
  type AnalysisJobRow,
  type JobErrorCode,
} from "@/lib/db/analysis-jobs";
import { saveMatchAnalysis, type MatchAnalysisRow } from "@/lib/db/match-analyses";
import type { PostingExtractionRow } from "@/lib/db/posting-extractions";
import { insertJobPosting, type JobPostingRow } from "@/lib/db/postings";
import { getProfileSnapshotById, type ProfileSnapshotRow } from "@/lib/db/profile-snapshots";
import { manualPastePosting, scrapeJobPosting, ScrapeError } from "@/lib/scraper";

import { ExtractPostingError, extractAndStorePosting } from "./extraction-service";
import { analyzeMatch, MatchError } from "./match";
import type { PostingExtraction } from "./schemas";
import { scoreMatch } from "./score";
import { lookupExtractionByUrl } from "./url-entry-service";

/**
 * 분석 파이프라인 오케스트레이션 (M1-14) — AI_ANALYSIS_DESIGN.md 2장 전체 흐름.
 *
 * 분석 요청 1건을 analysis_jobs 생성부터 완료까지 연결한다:
 *
 *   잡 생성(queued) → fetching(수집/캐시 조회) → extracting(LLM #1, 캐시 히트 시 건너뜀)
 *   → matching(LLM #2) → scoring(서버 규칙) → 결과 저장 → done
 *
 * 각 단계 전이는 M1-12의 updateAnalysisJobStep이 기록하고, 클라이언트는 그 행을
 * Realtime으로 구독한다(M1-13). 실패는 failAnalysisJob으로 error_code와 함께 남긴다.
 *
 * 이 모듈은 기존 모듈들의 연결만 담당한다 — 수집(lib/scraper), 구조화(M1-7~9),
 * 매칭(M1-10), 점수(M1-11), 저장 계층(lib/db)을 재사용하고 새 로직은
 * error_code 매핑과 "채용공고 아님" 판정(8장)뿐이다.
 */

/** 잡 생성 전에 거절되는 요청 오류 — 잡 행이 없으므로 Route가 4xx로 바로 응답한다 */
export type AnalysisRequestErrorCode =
  | "snapshot_not_found" // 프로필 스냅샷이 없거나 요청 사용자 소유가 아님
  | "invalid_input"; // url/pastedText 조합이 잘못됨

export class AnalysisRequestError extends Error {
  readonly code: AnalysisRequestErrorCode;

  constructor(code: AnalysisRequestErrorCode, message: string) {
    super(message);
    this.name = "AnalysisRequestError";
    this.code = code;
  }
}

/** 잡 생성 후의 파이프라인 실패 — 잡은 failed(error_code)로 마감된 상태다 */
export class AnalysisPipelineError extends Error {
  readonly errorCode: JobErrorCode;
  readonly jobId: string;

  constructor(
    errorCode: JobErrorCode,
    jobId: string,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "AnalysisPipelineError";
    this.errorCode = errorCode;
    this.jobId = jobId;
  }
}

export interface AnalysisPipelineDeps {
  anthropic: Anthropic;
  /** service-role 클라이언트 — 공유 테이블·잡·분석 결과 write용 (ARCHITECTURE.md 3.4) */
  supabase: SupabaseClient;
  /** 수집 함수 주입 (테스트용). 기본은 실제 스크래퍼 */
  scrape?: typeof scrapeJobPosting;
}

/** 분석 요청 — url(수집) 또는 pastedText(붙여넣기 폴백) 중 정확히 하나 */
export interface AnalysisRequest {
  userId: string;
  /** 매칭 기준이 될 프로필 스냅샷 (생성·재사용은 M2 — 여기서는 id로 참조만) */
  profileSnapshotId: string;
  url?: string;
  pastedText?: string;
}

export interface AnalysisPipelineResult {
  job: AnalysisJobRow;
  posting: JobPostingRow;
  extraction: PostingExtractionRow;
  analysis: MatchAnalysisRow;
  /** 구조화 캐시 재사용 여부 — 이후 쿼터 미차감(usage_logs)의 원천 (6.2) */
  extractionCacheHit: boolean;
}

/**
 * 분석 1건 실행. 성공 시 잡은 done, 실패 시 failed(error_code)로 마감하고
 * AnalysisPipelineError를 던진다. 잡 생성 전 검증 실패는 AnalysisRequestError.
 */
export async function runAnalysisPipeline(
  deps: AnalysisPipelineDeps,
  request: AnalysisRequest
): Promise<AnalysisPipelineResult> {
  const { anthropic, supabase, scrape = scrapeJobPosting } = deps;

  const hasUrl = typeof request.url === "string" && request.url.trim() !== "";
  const hasPaste = typeof request.pastedText === "string" && request.pastedText.trim() !== "";
  if (hasUrl === hasPaste) {
    throw new AnalysisRequestError("invalid_input", "url 또는 pastedText 중 하나만 지정하세요");
  }

  // 매칭 기준 스냅샷 확인 — 잡 생성 전에 거절한다 (진행 상태를 만들 이유가 없다)
  const snapshot = await getProfileSnapshotById(supabase, request.profileSnapshotId);
  if (snapshot === null || snapshot.user_id !== request.userId) {
    // 타인 소유도 "없음"으로 취급한다 — 존재 여부를 노출하지 않는다
    throw new AnalysisRequestError(
      "snapshot_not_found",
      `프로필 스냅샷을 찾을 수 없습니다: ${request.profileSnapshotId}`
    );
  }

  const job = await createAnalysisJob(supabase, { userId: request.userId });

  try {
    const result = await executeSteps({ anthropic, supabase, scrape }, request, job, snapshot);
    return result;
  } catch (cause) {
    const errorCode = toJobErrorCode(cause);
    await markJobFailed(supabase, job.id, errorCode);
    throw new AnalysisPipelineError(errorCode, job.id, `분석 실패 (job: ${job.id})`, { cause });
  }
}

/** 잡 생성 이후의 단계 실행 — 실패는 호출부(runAnalysisPipeline)가 failed로 마감한다 */
async function executeSteps(
  deps: Required<AnalysisPipelineDeps>,
  request: AnalysisRequest,
  job: AnalysisJobRow,
  snapshot: ProfileSnapshotRow
): Promise<AnalysisPipelineResult> {
  const { anthropic, supabase, scrape } = deps;

  // ── fetching: 수집 / 캐시 조회 (2장 [0] 전처리) ──────────────────────────
  await updateAnalysisJobStep(supabase, job.id, "fetching");

  let posting: JobPostingRow;
  let extraction: PostingExtractionRow | null = null; // 캐시 히트면 여기서 확정
  let extractionCacheHit = false;
  let hints: { title: string | null; siteName: string | null } = { title: null, siteName: null };

  if (request.url !== undefined && request.url.trim() !== "") {
    const lookup = await lookupExtractionByUrl(supabase, request.url);
    if (lookup.cacheHit) {
      posting = lookup.posting;
      extraction = lookup.extraction;
      extractionCacheHit = true;
    } else if (lookup.posting !== null) {
      // 공고는 있으나 캐시 무효 — raw_snapshot을 재사용해 재구조화한다 (M1-9)
      posting = lookup.posting;
    } else {
      const scraped = await scrape(request.url);
      posting = await insertJobPosting(supabase, scraped);
      hints = { title: scraped.title, siteName: scraped.siteName };
    }
  } else {
    // 붙여넣기 폴백 — manual_paste로 동일 파이프라인 진입 (8장)
    const pasted = manualPastePosting(request.pastedText as string);
    posting = await insertJobPosting(supabase, pasted);
  }

  // ── extracting: 공고 구조화 (LLM #1) — 캐시 히트면 단계 자체를 건너뛴다 ──
  if (extraction === null) {
    await updateAnalysisJobStep(supabase, job.id, "extracting", { postingId: posting.id });
    const output = await extractAndStorePosting({ anthropic, supabase }, posting.id, hints);
    extraction = output.extraction;
    extractionCacheHit = output.cacheHit;
  }

  // 본문이 채용공고가 아니면 중단한다 (8장: 필수 필드 다수 null → 사용자 확인 요청)
  if (isNotAPosting(extraction.extracted)) {
    throw new NotAPostingError(posting.id);
  }

  // ── matching: 프로필 매칭 (LLM #2) ───────────────────────────────────────
  // postingId를 함께 기록 — 캐시 히트로 extracting을 건너뛴 경우의 연결 지점
  await updateAnalysisJobStep(supabase, job.id, "matching", { postingId: posting.id });
  const match = await analyzeMatch(anthropic, {
    extraction: extraction.extracted,
    profileSnapshot: snapshot.snapshot,
  });

  // ── scoring: 점수 산출 (서버 규칙 — LLM 아님) ────────────────────────────
  await updateAnalysisJobStep(supabase, job.id, "scoring");
  const score = scoreMatch(extraction.extracted, match.result);

  // ── 결과 저장 → done ─────────────────────────────────────────────────────
  const analysis = await saveMatchAnalysis(supabase, {
    user_id: request.userId,
    extraction_id: extraction.id,
    profile_snapshot_id: snapshot.id,
    result: match.result,
    score: score.score,
    grade: score.grade,
    score_breakdown: score.scoreBreakdown,
    critical_gap_count: score.criticalGapCount,
    model_id: match.modelId,
    prompt_version: match.promptVersion,
    schema_version: match.schemaVersion,
    token_usage: match.tokenUsage,
  });
  const doneJob = await updateAnalysisJobStep(supabase, job.id, "done");

  return { job: doneJob, posting, extraction, analysis, extractionCacheHit };
}

/**
 * "채용공고 아님" 판정 (8장) — 구조화가 회사명·직무명을 모두 못 찾았으면
 * 본문이 공고가 아닐 가능성이 높다 (프롬프트 규칙 9가 이 경우 null을 강제한다).
 */
export function isNotAPosting(extracted: PostingExtraction): boolean {
  return extracted.company_name === null && extracted.job_title === null;
}

/** 파이프라인 내부 신호용 — toJobErrorCode에서 not_a_posting으로 매핑된다 */
class NotAPostingError extends Error {
  constructor(postingId: string) {
    super(`본문이 채용공고가 아닌 것으로 판정됨 (posting: ${postingId})`);
    this.name = "NotAPostingError";
  }
}

/** 실패 원인 → analysis_jobs.error_code (폴백 UI 분기의 원천 — ARCHITECTURE.md 3.3) */
export function toJobErrorCode(cause: unknown): JobErrorCode {
  if (cause instanceof NotAPostingError) return "not_a_posting";
  // 수집 실패 전반(봇 차단·타임아웃·빈 본문·짧은 붙여넣기) → 붙여넣기 폴백 안내
  if (cause instanceof ScrapeError) return "fetch_failed";
  if (cause instanceof ExtractPostingError) {
    // 본문 스냅샷이 없어 구조화 불가 → 재수집/붙여넣기 유도
    return cause.code === "empty_snapshot" ? "fetch_failed" : "llm_error";
  }
  if (cause instanceof MatchError) return "llm_error";
  // StorageError·Anthropic SDK 오류 등 나머지는 일반 분석 오류로 묶는다
  // (enum에 내부 오류용 코드가 없다 — UI는 "다시 시도" 안내)
  return "llm_error";
}

/**
 * 실패 마감 — 진행 상태의 최종 기록이므로 최선을 다하되,
 * 마감 자체가 실패해도 원래 오류를 삼키지 않는다 (로그만 남긴다).
 */
async function markJobFailed(
  supabase: SupabaseClient,
  jobId: string,
  errorCode: JobErrorCode
): Promise<void> {
  try {
    await failAnalysisJob(supabase, jobId, errorCode);
  } catch (failError) {
    console.error(`[pipeline] 잡 실패 마감 실패 (job: ${jobId})`, failError);
  }
}
