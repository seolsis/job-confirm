import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import type { PostingExtractionRow } from "@/lib/db/posting-extractions";
import type { JobPostingRow } from "@/lib/db/postings";

import { EXTRACTION_MODEL_ID } from "./extract";
import {
  EXTRACTION_CACHE_MAX_AGE_DAYS,
  evaluateExtractionCache,
  lookupExtractionCacheByUrlHash,
} from "./extraction-cache";
import { EXTRACT_PROMPT_VERSION } from "./prompts/extract-v1";
import { EXTRACTION_SCHEMA_VERSION, type PostingExtraction } from "./schemas";

/**
 * 구조화 캐시 정책 단위 테스트 (M1-8) — AI_ANALYSIS_DESIGN.md 6.2
 * 판정은 순수 함수라 시각을 주입해 결정적으로 검증한다.
 */

const NOW = new Date("2026-07-09T12:00:00Z");
const now = () => NOW;

/** NOW 기준 daysAgo일 전에 생성된, 현재 버전과 일치하는 extraction 행 */
function makeExtractionRow(
  overrides: Partial<PostingExtractionRow> = {},
  daysAgo = 0
): PostingExtractionRow {
  return {
    id: "ext-1",
    posting_id: "posting-1",
    extracted: {} as PostingExtraction, // 판정은 내용을 보지 않는다
    company_name: "테스트컴퍼니",
    job_title: "백엔드 개발자",
    deadline_date: "2026-08-31",
    model_id: EXTRACTION_MODEL_ID,
    prompt_version: EXTRACT_PROMPT_VERSION,
    schema_version: EXTRACTION_SCHEMA_VERSION,
    token_usage: { input: 1200, output: 800, cache_read: 1000, cache_creation: 50 },
    created_at: new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

describe("evaluateExtractionCache — 히트 조건 (모두 만족해야 한다)", () => {
  it("버전 3종 일치 + 유효기간 이내면 hit, 행을 그대로 반환한다", () => {
    const row = makeExtractionRow();
    const decision = evaluateExtractionCache(row, { now });

    expect(decision).toEqual({ hit: true, extraction: row });
  });

  it("유효기간 경계(정확히 7일)까지는 hit", () => {
    const row = makeExtractionRow({}, EXTRACTION_CACHE_MAX_AGE_DAYS);
    expect(evaluateExtractionCache(row, { now }).hit).toBe(true);
  });
});

describe("evaluateExtractionCache — miss 사유", () => {
  it("extraction이 없으면 no_extraction (실패한 구조화는 저장되지 않으므로 이전 실패도 이 경로)", () => {
    expect(evaluateExtractionCache(null, { now })).toEqual({
      hit: false,
      reason: "no_extraction",
    });
  });

  it("schema_version이 다르면 schema_version_mismatch", () => {
    const row = makeExtractionRow({ schema_version: "extract-schema-v0" });
    expect(evaluateExtractionCache(row, { now })).toEqual({
      hit: false,
      reason: "schema_version_mismatch",
    });
  });

  it("prompt_version이 다르면 prompt_version_mismatch", () => {
    const row = makeExtractionRow({ prompt_version: "extract-v0" });
    expect(evaluateExtractionCache(row, { now })).toEqual({
      hit: false,
      reason: "prompt_version_mismatch",
    });
  });

  it("model_id가 다르면 model_mismatch", () => {
    const row = makeExtractionRow({ model_id: "claude-sonnet-5" });
    expect(evaluateExtractionCache(row, { now })).toEqual({
      hit: false,
      reason: "model_mismatch",
    });
  });

  it("유효기간(기본 7일)을 넘기면 expired — 공고 수정 가능성 대비 (6.2)", () => {
    const row = makeExtractionRow({}, EXTRACTION_CACHE_MAX_AGE_DAYS + 1);
    expect(evaluateExtractionCache(row, { now })).toEqual({ hit: false, reason: "expired" });
  });

  it("maxAgeDays를 덮어쓸 수 있다 (운영 튜닝 값 — 하드코딩 금지 원칙)", () => {
    const row = makeExtractionRow({}, 2);
    expect(evaluateExtractionCache(row, { now, maxAgeDays: 1 })).toEqual({
      hit: false,
      reason: "expired",
    });
    expect(evaluateExtractionCache(row, { now, maxAgeDays: 30 }).hit).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// lookupExtractionCacheByUrlHash — url_hash → 공고 → 최신 extraction → 판정
// ---------------------------------------------------------------------------

const samplePosting: JobPostingRow = {
  id: "posting-1",
  url: "https://example.com/jobs/1",
  normalized_url: "https://example.com/jobs/1",
  url_hash: "hash-1",
  source_site: "generic",
  raw_snapshot: "공고 본문",
  snapshot_hash: "snap-1",
  status: "active",
  latest_extraction_id: "ext-1",
  fetched_at: null,
  created_at: "2026-07-01T00:00:00Z",
};

/** 공고 조회(eq→maybeSingle)와 최신 extraction 조회(eq→order→limit→maybeSingle)를 흉내 낸다 */
function makeFakeSupabase(options: {
  posting?: JobPostingRow | null;
  extraction?: PostingExtractionRow | null;
}): SupabaseClient {
  return {
    from() {
      return {
        select: () => ({
          eq: () => ({
            // job_postings 경로
            maybeSingle: async () => ({ data: options.posting ?? null, error: null }),
            // posting_extractions 경로
            order: () => ({
              limit: () => ({
                maybeSingle: async () => ({ data: options.extraction ?? null, error: null }),
              }),
            }),
          }),
        }),
      };
    },
  } as unknown as SupabaseClient;
}

describe("lookupExtractionCacheByUrlHash", () => {
  it("공고 자체가 없으면 no_posting (최초 분석)", async () => {
    const supabase = makeFakeSupabase({ posting: null });
    const lookup = await lookupExtractionCacheByUrlHash(supabase, "unknown-hash", { now });

    expect(lookup.posting).toBeNull();
    expect(lookup.decision).toEqual({ hit: false, reason: "no_posting" });
  });

  it("공고 + 유효한 extraction이면 hit — 공고도 함께 반환한다", async () => {
    const row = makeExtractionRow();
    const supabase = makeFakeSupabase({ posting: samplePosting, extraction: row });
    const lookup = await lookupExtractionCacheByUrlHash(supabase, "hash-1", { now });

    expect(lookup.posting).toEqual(samplePosting);
    expect(lookup.decision).toEqual({ hit: true, extraction: row });
  });

  it("공고는 있으나 extraction이 없으면 no_extraction — 공고는 반환해 재분석에 재사용한다", async () => {
    const supabase = makeFakeSupabase({ posting: samplePosting, extraction: null });
    const lookup = await lookupExtractionCacheByUrlHash(supabase, "hash-1", { now });

    expect(lookup.posting).toEqual(samplePosting);
    expect(lookup.decision).toEqual({ hit: false, reason: "no_extraction" });
  });

  it("공고는 있으나 버전이 다르면 mismatch 사유를 그대로 전달한다", async () => {
    const row = makeExtractionRow({ prompt_version: "extract-v0" });
    const supabase = makeFakeSupabase({ posting: samplePosting, extraction: row });
    const lookup = await lookupExtractionCacheByUrlHash(supabase, "hash-1", { now });

    expect(lookup.decision).toEqual({ hit: false, reason: "prompt_version_mismatch" });
  });
});
