import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";

import { getJobPostingById, type JobPostingRow } from "@/lib/db/postings";
import {
  getLatestExtraction,
  savePostingExtraction,
  type PostingExtractionRow,
} from "@/lib/db/posting-extractions";

import { ExtractionError, extractJobPosting } from "./extract";
import {
  evaluateExtractionCache,
  type CacheMissReason,
  type CacheOptions,
} from "./extraction-cache";

/**
 * extraction 서비스 (M1-7) — posting_id 하나를 받아
 * 원본 공고 조회 → [1] 공고 구조화(LLM #1) → posting_extractions 저장까지 수행한다.
 *
 * 유효한 기존 구조화 결과가 있으면 LLM을 호출하지 않고 재사용한다
 * (M1-8 구조화 캐시 — 판정 조건은 extraction-cache.ts 참고).
 *
 * 다음은 이후 마일스톤의 몫:
 *  - URL 입력 → url_hash 캐시 조회 → 수집 연결 (M1-9 파이프라인)
 *  - analysis_jobs step 갱신·Realtime, 쿼터 차감(usage_logs)
 *  - [2] 프로필 매칭, [3] 점수 산출
 *
 * 클라이언트 2종(Anthropic, service-role Supabase)을 주입받는다 —
 * posting_extractions write는 RLS상 service-role만 가능하다 (ARCHITECTURE.md 3.4).
 */

/** 실패 사유 — 상위 파이프라인에서 analysis_jobs.error_code로 매핑한다 */
export type ExtractPostingErrorCode =
  | "posting_not_found" // posting_id에 해당하는 공고가 없음
  | "empty_snapshot" // raw_snapshot이 비어 있어 구조화할 본문이 없음
  | "llm_error" // Anthropic 호출 실패 (모듈 내 1회 재시도 포함 실패)
  | "storage_error"; // 조회·저장 실패

export class ExtractPostingError extends Error {
  readonly code: ExtractPostingErrorCode;

  constructor(code: ExtractPostingErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ExtractPostingError";
    this.code = code;
  }
}

export interface ExtractPostingDeps {
  anthropic: Anthropic;
  /** service-role 클라이언트 — 공유 테이블 write용 */
  supabase: SupabaseClient;
}

/** 구조화 프롬프트의 추출 힌트 (3.1) — job_postings에는 저장되지 않으므로 호출자가 전달 */
export interface ExtractPostingHints {
  title?: string | null;
  siteName?: string | null;
}

export interface ExtractPostingOutput {
  posting: JobPostingRow;
  extraction: PostingExtractionRow;
  /** 캐시 재사용 여부 — 이후 usage_logs.was_cache_hit(쿼터 미차감)의 원천 (6.2) */
  cacheHit: boolean;
  /** cacheHit이 false일 때의 miss 사유 */
  cacheMissReason?: CacheMissReason;
}

/**
 * 공고 1건을 구조화하고 저장한다. 유효한 캐시가 있으면 LLM 호출 없이
 * 기존 결과를 반환한다. 모든 실패는 로깅 후 ExtractPostingError(code)로
 * 정규화해 던진다.
 */
export async function extractAndStorePosting(
  deps: ExtractPostingDeps,
  postingId: string,
  hints: ExtractPostingHints = {},
  cacheOptions: CacheOptions = {}
): Promise<ExtractPostingOutput> {
  // 1. 원본 공고 조회
  let posting: JobPostingRow | null;
  try {
    posting = await getJobPostingById(deps.supabase, postingId);
  } catch (cause) {
    logFailure("공고 조회 실패", { postingId, cause });
    throw new ExtractPostingError("storage_error", `공고 조회 실패: ${postingId}`, { cause });
  }
  if (posting === null) {
    logFailure("공고 없음", { postingId });
    throw new ExtractPostingError("posting_not_found", `공고를 찾을 수 없습니다: ${postingId}`);
  }

  // 2. 구조화 캐시 조회 (6.2) — 히트면 LLM을 호출하지 않는다
  let latest: PostingExtractionRow | null;
  try {
    latest = await getLatestExtraction(deps.supabase, posting.id);
  } catch (cause) {
    logFailure("캐시 조회 실패", { postingId, cause });
    throw new ExtractPostingError("storage_error", `캐시 조회 실패: ${postingId}`, { cause });
  }
  const decision = evaluateExtractionCache(latest, cacheOptions);
  if (decision.hit) {
    logCache("cache_hit", {
      postingId,
      extractionId: decision.extraction.id,
      promptVersion: decision.extraction.prompt_version,
      schemaVersion: decision.extraction.schema_version,
      modelId: decision.extraction.model_id,
    });
    return { posting, extraction: decision.extraction, cacheHit: true };
  }
  logCache("cache_miss", { postingId, cache_reason: decision.reason });

  if (posting.raw_snapshot === null || posting.raw_snapshot.trim() === "") {
    logFailure("본문 스냅샷 없음", { postingId });
    throw new ExtractPostingError(
      "empty_snapshot",
      `공고에 구조화할 본문(raw_snapshot)이 없습니다: ${postingId}`
    );
  }

  // 3. LLM 구조화 — extractJobPosting()이 refusal/truncated 1회 재시도를 포함한다
  let result;
  try {
    result = await extractJobPosting(deps.anthropic, {
      bodyText: posting.raw_snapshot,
      title: hints.title ?? null,
      siteName: hints.siteName ?? null,
    });
  } catch (cause) {
    if (cause instanceof ExtractionError) {
      // 재시도까지 소진된 구조화 실패 (refusal/truncated/empty_output/invalid_json)
      logFailure("구조화 실패 (재시도 소진)", { postingId, code: cause.code, cause });
    } else {
      // LLM API 오류 (429/5xx 등 — 재시도 이후에도 실패. provider는 lib/ai/provider.ts 참고)
      logFailure("LLM API 오류", { postingId, cause });
    }
    throw new ExtractPostingError("llm_error", `공고 구조화 실패: ${postingId}`, { cause });
  }

  // 4. 저장 + latest_extraction_id 갱신
  try {
    const extraction = await savePostingExtraction(deps.supabase, postingId, result);
    return { posting, extraction, cacheHit: false, cacheMissReason: decision.reason };
  } catch (cause) {
    logFailure("구조화 결과 저장 실패", { postingId, cause });
    throw new ExtractPostingError("storage_error", `구조화 결과 저장 실패: ${postingId}`, {
      cause,
    });
  }
}

/** 실패 로깅 — Route Handler(Vercel)에서는 서버 로그로 수집된다 */
function logFailure(message: string, context: Record<string, unknown>): void {
  console.error(`[extraction] ${message}`, context);
}

/** 캐시 히트/미스 로깅 — 비용 절감 효과·miss 사유 분석의 원천 (6.2) */
function logCache(event: "cache_hit" | "cache_miss", context: Record<string, unknown>): void {
  console.log(`[extraction] ${event}`, context);
}
