import type { SupabaseClient } from "@supabase/supabase-js";

import { getLatestExtraction, type PostingExtractionRow } from "@/lib/db/posting-extractions";
import { getJobPostingByUrlHash, type JobPostingRow } from "@/lib/db/postings";

import { EXTRACTION_MODEL_ID } from "./extract";
import { EXTRACT_PROMPT_VERSION } from "./prompts/extract-v1";
import { EXTRACTION_SCHEMA_VERSION } from "./schemas";

/**
 * 구조화 캐시 (M1-8) — AI_ANALYSIS_DESIGN.md 6.2
 *
 * 같은 공고(url_hash)는 [1] 공고 구조화를 건너뛰고 기존 결과를 재사용한다.
 * 사용자 무관 공유 캐시이므로 여러 사용자가 같은 공고를 분석해도 LLM은 1회만 호출된다.
 *
 * 캐시 히트 조건 (모두 만족해야 한다):
 *  - 최신 extraction 행이 존재 (실패한 구조화는 저장되지 않으므로 존재 = 성공)
 *  - schema_version / prompt_version / model_id가 현재 코드와 일치
 *    (프롬프트·스키마를 개선하면 기존 캐시는 자동으로 무효화되고 재분석된다)
 *  - 유효기간(기본 7일) 이내 — 공고가 조용히 수정되는 경우 대비
 *
 * ── snapshot_hash 무효화 확장 포인트 (설계만, 재수집 흐름이 생기면 구현 — 6.2) ──
 * 공고 본문이 바뀌면 유효기간과 무관하게 캐시를 버려야 한다. 구현 시:
 *  1. posting_extractions에 source_snapshot_hash 컬럼 추가 (마이그레이션),
 *     savePostingExtraction()이 구조화에 쓴 posting.snapshot_hash를 복제 저장
 *  2. CacheOptions에 currentSnapshotHash를 추가하고 evaluateExtractionCache()가
 *     source_snapshot_hash와 비교 — 불일치면 miss(reason: "snapshot_changed")
 *  3. 호출부는 이미 준비돼 있다: lookupExtractionCacheByUrlHash()가 posting을
 *     함께 반환하므로 posting.snapshot_hash(재수집 갱신값)를 그대로 넘기면 된다
 * 그 전까지는 유효기간(기본 7일)이 공고 수정에 대한 유일한 방어선이다.
 */

/**
 * 캐시 유효기간 기본값 (일) — 운영 데이터로 튜닝하는 값이므로
 * 호출부에서 덮어쓸 수 있게 옵션으로 열어둔다 (설계 문서 말미의 하드코딩 금지 원칙).
 */
export const EXTRACTION_CACHE_MAX_AGE_DAYS = 7;

/** 캐시 미스 사유 — cache_reason으로 로깅된다 */
export type CacheMissReason =
  | "no_posting" // url_hash에 해당하는 공고 자체가 없음 (최초 분석)
  | "no_extraction" // 공고는 있으나 성공한 구조화 결과가 없음 (이전 시도 실패 포함)
  | "schema_version_mismatch" // 출력 스키마가 바뀜 → 재분석
  | "prompt_version_mismatch" // 프롬프트가 바뀜 → 재분석
  | "model_mismatch" // 모델이 바뀜 → 재분석
  | "expired"; // 유효기간(기본 7일) 경과 → 공고 수정 가능성

export type CacheDecision =
  { hit: true; extraction: PostingExtractionRow } | { hit: false; reason: CacheMissReason };

export interface CacheOptions {
  /** 시각 주입 (테스트용) */
  now?: () => Date;
  /** 캐시 유효기간 (일). 기본 EXTRACTION_CACHE_MAX_AGE_DAYS */
  maxAgeDays?: number;
}

/**
 * 캐시 정책 판정 (순수 함수 — 단위 테스트 대상).
 * 최신 extraction 행 하나를 받아 재사용 가능 여부와 miss 사유를 반환한다.
 */
export function evaluateExtractionCache(
  extraction: PostingExtractionRow | null,
  options: CacheOptions = {}
): CacheDecision {
  const { now = () => new Date(), maxAgeDays = EXTRACTION_CACHE_MAX_AGE_DAYS } = options;

  if (extraction === null) return { hit: false, reason: "no_extraction" };
  if (extraction.schema_version !== EXTRACTION_SCHEMA_VERSION) {
    return { hit: false, reason: "schema_version_mismatch" };
  }
  if (extraction.prompt_version !== EXTRACT_PROMPT_VERSION) {
    return { hit: false, reason: "prompt_version_mismatch" };
  }
  if (extraction.model_id !== EXTRACTION_MODEL_ID) {
    return { hit: false, reason: "model_mismatch" };
  }

  const ageMs = now().getTime() - new Date(extraction.created_at).getTime();
  if (ageMs > maxAgeDays * 24 * 60 * 60 * 1000) {
    return { hit: false, reason: "expired" };
  }

  return { hit: true, extraction };
}

/** url_hash 기준 캐시 조회 결과 — 상위 파이프라인(M1-9)의 진입 조회용 */
export interface ExtractionCacheLookup {
  /** miss여도 공고가 있으면 반환한다 — 재분석 시 raw_snapshot을 재사용하기 위함 */
  posting: JobPostingRow | null;
  decision: CacheDecision;
}

/**
 * url_hash로 공고 → 최신 구조화 결과를 찾아 캐시 판정까지 수행한다.
 * URL 입력 파이프라인의 [0] 전처리 단계에서 사용한다 (2장: 캐시 조회).
 */
export async function lookupExtractionCacheByUrlHash(
  supabase: SupabaseClient,
  urlHash: string,
  options: CacheOptions = {}
): Promise<ExtractionCacheLookup> {
  const posting = await getJobPostingByUrlHash(supabase, urlHash);
  if (posting === null) {
    return { posting: null, decision: { hit: false, reason: "no_posting" } };
  }

  const extraction = await getLatestExtraction(supabase, posting.id);
  return { posting, decision: evaluateExtractionCache(extraction, options) };
}
