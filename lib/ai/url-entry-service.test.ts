import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import type { PostingExtractionRow } from "@/lib/db/posting-extractions";
import type { JobPostingRow } from "@/lib/db/postings";
import { ScrapeError, normalizeUrl, urlHash } from "@/lib/scraper";

import { EXTRACTION_MODEL_ID } from "./extract";
import { EXTRACT_PROMPT_VERSION } from "./prompts/extract-v1";
import { EXTRACTION_SCHEMA_VERSION, type PostingExtraction } from "./schemas";
import { lookupExtractionByUrl } from "./url-entry-service";

/**
 * URL 입력 진입 서비스 단위 테스트 (M1-9) — 실제 Supabase는 호출하지 않는다.
 * URL 정규화 → url_hash → 캐시 판정 연결과 조회 전용 동작(자동 구조화 금지)을 검증한다.
 */

const POSTING_URL = "https://example.com/jobs/1";
const POSTING_URL_HASH = urlHash(normalizeUrl(POSTING_URL));

const samplePosting: JobPostingRow = {
  id: "posting-1",
  url: POSTING_URL,
  normalized_url: POSTING_URL,
  url_hash: POSTING_URL_HASH,
  source_site: "generic",
  raw_snapshot: "공고 본문",
  snapshot_hash: "snap-1",
  status: "active",
  latest_extraction_id: "ext-1",
  fetched_at: null,
  created_at: "2026-07-01T00:00:00Z",
};

/** 현재 버전 3종과 일치하는 유효한 extraction 행 */
const sampleExtraction: PostingExtractionRow = {
  id: "ext-1",
  posting_id: "posting-1",
  extracted: { company_name: "테스트컴퍼니" } as PostingExtraction,
  company_name: "테스트컴퍼니",
  job_title: "백엔드 개발자",
  deadline_date: "2026-08-31",
  model_id: EXTRACTION_MODEL_ID,
  prompt_version: EXTRACT_PROMPT_VERSION,
  schema_version: EXTRACTION_SCHEMA_VERSION,
  token_usage: { input: 1200, output: 800, cache_read: 1000, cache_creation: 50 },
  created_at: "2026-07-09T00:00:00Z",
};

/** 판정 시각 고정 — extraction created_at 반나절 뒤 (유효기간 이내) */
const cacheOptions = { now: () => new Date("2026-07-09T12:00:00Z") };

/**
 * url_hash로 조회하는 공고 저장소 fake.
 * eq()에 전달된 필터 값을 기록해 "어떤 url_hash로 조회했는지"를 검증할 수 있다.
 */
function makeFakeSupabase(options: {
  postingsByUrlHash?: Record<string, JobPostingRow>;
  extraction?: PostingExtractionRow | null;
}): { client: SupabaseClient; queriedHashes: string[] } {
  const queriedHashes: string[] = [];
  const client = {
    from() {
      return {
        select: () => ({
          eq: (_column: string, value: string) => ({
            // job_postings 경로 (url_hash 조회)
            maybeSingle: async () => {
              queriedHashes.push(value);
              return { data: options.postingsByUrlHash?.[value] ?? null, error: null };
            },
            // posting_extractions 경로 (최신 1건)
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
  return { client, queriedHashes };
}

let consoleLog: MockInstance;
beforeEach(() => {
  // 캐시 로깅(console.log) 검증 + 테스트 출력 소음 제거
  consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  consoleLog.mockRestore();
});

describe("lookupExtractionByUrl — cache hit", () => {
  it("동일 URL이면 hit: 기존 extraction을 반환한다", async () => {
    const { client } = makeFakeSupabase({
      postingsByUrlHash: { [POSTING_URL_HASH]: samplePosting },
      extraction: sampleExtraction,
    });

    const result = await lookupExtractionByUrl(client, POSTING_URL, cacheOptions);

    expect(result.cacheHit).toBe(true);
    if (result.cacheHit) {
      expect(result.posting).toEqual(samplePosting);
      expect(result.extraction).toEqual(sampleExtraction);
    }
  });

  it("트래킹 파라미터만 다른 URL도 같은 url_hash로 수렴해 hit", async () => {
    const { client, queriedHashes } = makeFakeSupabase({
      postingsByUrlHash: { [POSTING_URL_HASH]: samplePosting },
      extraction: sampleExtraction,
    });

    const variant = `${POSTING_URL}?utm_source=slack&fbclid=abc#apply`;
    const result = await lookupExtractionByUrl(client, variant, cacheOptions);

    expect(result.cacheHit).toBe(true);
    expect(result.urlHash).toBe(POSTING_URL_HASH);
    expect(queriedHashes).toEqual([POSTING_URL_HASH]); // 정규화된 해시로 조회했다
  });

  it("cache metadata 검증: 버전 3종과 token_usage가 행 그대로 보존된다", async () => {
    const { client } = makeFakeSupabase({
      postingsByUrlHash: { [POSTING_URL_HASH]: samplePosting },
      extraction: sampleExtraction,
    });

    const result = await lookupExtractionByUrl(client, POSTING_URL, cacheOptions);

    expect(result.cacheHit).toBe(true);
    if (result.cacheHit) {
      expect(result.extraction.model_id).toBe(EXTRACTION_MODEL_ID);
      expect(result.extraction.prompt_version).toBe(EXTRACT_PROMPT_VERSION);
      expect(result.extraction.schema_version).toBe(EXTRACTION_SCHEMA_VERSION);
      expect(result.extraction.token_usage).toEqual({
        input: 1200,
        output: 800,
        cache_read: 1000,
        cache_creation: 50,
      });
    }
  });

  it("cache_hit을 url_hash와 함께 로깅한다", async () => {
    const { client } = makeFakeSupabase({
      postingsByUrlHash: { [POSTING_URL_HASH]: samplePosting },
      extraction: sampleExtraction,
    });

    await lookupExtractionByUrl(client, POSTING_URL, cacheOptions);

    expect(consoleLog).toHaveBeenCalledWith(
      expect.stringContaining("cache_hit"),
      expect.objectContaining({
        urlHash: POSTING_URL_HASH,
        postingId: "posting-1",
        extractionId: "ext-1",
      })
    );
  });
});

describe("lookupExtractionByUrl — cache miss (조회 전용, 자동 구조화 금지)", () => {
  it("없는 URL이면 miss(no_posting): 공고 null, 캐시 없음 상태만 반환한다", async () => {
    const { client } = makeFakeSupabase({ postingsByUrlHash: {} });

    const result = await lookupExtractionByUrl(
      client,
      "https://example.com/jobs/unknown",
      cacheOptions
    );

    expect(result.cacheHit).toBe(false);
    if (!result.cacheHit) {
      expect(result.posting).toBeNull();
      expect(result.cacheMissReason).toBe("no_posting");
    }
  });

  it("공고는 있으나 extraction이 없으면 miss(no_extraction) — 공고는 반환한다", async () => {
    const { client } = makeFakeSupabase({
      postingsByUrlHash: { [POSTING_URL_HASH]: samplePosting },
      extraction: null,
    });

    const result = await lookupExtractionByUrl(client, POSTING_URL, cacheOptions);

    expect(result.cacheHit).toBe(false);
    if (!result.cacheHit) {
      expect(result.posting).toEqual(samplePosting);
      expect(result.cacheMissReason).toBe("no_extraction");
    }
  });

  it("버전이 다르면 miss 사유를 그대로 전달한다", async () => {
    const { client } = makeFakeSupabase({
      postingsByUrlHash: { [POSTING_URL_HASH]: samplePosting },
      extraction: { ...sampleExtraction, prompt_version: "extract-v0" },
    });

    const result = await lookupExtractionByUrl(client, POSTING_URL, cacheOptions);

    expect(result.cacheHit).toBe(false);
    if (!result.cacheHit) {
      expect(result.cacheMissReason).toBe("prompt_version_mismatch");
    }
  });

  it("cache_miss를 url_hash·사유와 함께 로깅한다", async () => {
    const { client } = makeFakeSupabase({ postingsByUrlHash: {} });

    await lookupExtractionByUrl(client, POSTING_URL, cacheOptions);

    expect(consoleLog).toHaveBeenCalledWith(
      expect.stringContaining("cache_miss"),
      expect.objectContaining({ urlHash: POSTING_URL_HASH, cache_reason: "no_posting" })
    );
  });
});

describe("lookupExtractionByUrl — 입력 검증", () => {
  it("http(s) URL이 아니면 ScrapeError(invalid_url)를 전파한다", async () => {
    const { client } = makeFakeSupabase({});

    const error = await lookupExtractionByUrl(client, "잘못된 URL", cacheOptions).catch(
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(ScrapeError);
    expect((error as ScrapeError).code).toBe("invalid_url");
  });

  it("정규화 결과(normalizedUrl, urlHash)를 결과에 싣는다", async () => {
    const { client } = makeFakeSupabase({ postingsByUrlHash: {} });

    const result = await lookupExtractionByUrl(
      client,
      "HTTPS://EXAMPLE.com/jobs/1/?utm_campaign=x",
      cacheOptions
    );

    expect(result.normalizedUrl).toBe("https://example.com/jobs/1");
    expect(result.urlHash).toBe(POSTING_URL_HASH);
  });
});
