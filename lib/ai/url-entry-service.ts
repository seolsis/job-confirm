import type { SupabaseClient } from "@supabase/supabase-js";

import type { PostingExtractionRow } from "@/lib/db/posting-extractions";
import type { JobPostingRow } from "@/lib/db/postings";
import { normalizeUrl, urlHash } from "@/lib/scraper";

import {
  lookupExtractionCacheByUrlHash,
  type CacheMissReason,
  type CacheOptions,
} from "./extraction-cache";

/**
 * URL 입력 진입 서비스 (M1-9) — AI_ANALYSIS_DESIGN.md 2장 [0] 전처리의 캐시 조회.
 *
 * URL 하나를 받아 정규화 → url_hash 생성 → 구조화 캐시 판정까지 수행한다.
 * 조회 전용이다 — miss여도 수집·구조화를 자동 실행하지 않는다.
 * (수집 연결과 miss 시 재분석 오케스트레이션은 M1-10 파이프라인의 몫)
 *
 * URL이 http(s) 형식이 아니면 ScrapeError("invalid_url")를 그대로 전파한다 —
 * 상위 파이프라인이 "URL을 확인해 주세요" 폴백 UI로 분기하는 데 쓴다.
 */

export type UrlExtractionLookup =
  | {
      cacheHit: true;
      normalizedUrl: string;
      urlHash: string;
      posting: JobPostingRow;
      extraction: PostingExtractionRow;
    }
  | {
      cacheHit: false;
      normalizedUrl: string;
      urlHash: string;
      /** miss여도 공고가 있으면 반환 — 재분석 시 raw_snapshot 재사용 (M1-10) */
      posting: JobPostingRow | null;
      cacheMissReason: CacheMissReason;
    };

/**
 * URL → url_hash → 구조화 캐시 조회.
 *
 * hit: 기존 extraction을 그대로 반환한다 (LLM 호출 없음, 공유 캐시 — 6.2).
 * miss: 캐시 없음 상태와 사유만 반환한다. 자동 구조화는 하지 않는다.
 */
export async function lookupExtractionByUrl(
  supabase: SupabaseClient,
  rawUrl: string,
  options: CacheOptions = {}
): Promise<UrlExtractionLookup> {
  const normalizedUrl = normalizeUrl(rawUrl); // 형식 오류면 ScrapeError("invalid_url") 전파
  const hash = urlHash(normalizedUrl);

  const { posting, decision } = await lookupExtractionCacheByUrlHash(supabase, hash, options);

  if (decision.hit) {
    logCache("cache_hit", {
      urlHash: hash,
      postingId: posting!.id,
      extractionId: decision.extraction.id,
      promptVersion: decision.extraction.prompt_version,
      schemaVersion: decision.extraction.schema_version,
      modelId: decision.extraction.model_id,
    });
    return {
      cacheHit: true,
      normalizedUrl,
      urlHash: hash,
      posting: posting as JobPostingRow, // hit이면 공고가 반드시 존재한다
      extraction: decision.extraction,
    };
  }

  logCache("cache_miss", {
    urlHash: hash,
    postingId: posting?.id ?? null,
    cache_reason: decision.reason,
  });
  return {
    cacheHit: false,
    normalizedUrl,
    urlHash: hash,
    posting,
    cacheMissReason: decision.reason,
  };
}

/** 캐시 히트/미스 로깅 — url_hash를 함께 남겨 공고 단위 재사용률을 집계할 수 있게 한다 */
function logCache(event: "cache_hit" | "cache_miss", context: Record<string, unknown>): void {
  console.log(`[url-entry] ${event}`, context);
}
