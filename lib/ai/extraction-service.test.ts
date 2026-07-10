import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import type { PostingExtractionRow } from "@/lib/db/posting-extractions";
import type { JobPostingRow } from "@/lib/db/postings";

import { EXTRACTION_MODEL_ID } from "./extract";
import { ExtractPostingError, extractAndStorePosting } from "./extraction-service";
import { EXTRACT_PROMPT_VERSION } from "./prompts/extract-v1";
import { EXTRACTION_SCHEMA_VERSION, type PostingExtraction } from "./schemas";

/**
 * extraction 서비스 단위 테스트 — Anthropic도 Supabase도 실제로 호출하지 않는다.
 * 조회 → 구조화 → 저장의 오케스트레이션과 실패 코드 정규화·로깅을 검증한다.
 */

const sampleExtraction: PostingExtraction = {
  company_name: "테스트컴퍼니",
  job_title: "백엔드 개발자",
  job_category: "서버 개발",
  responsibilities: ["API 서버 개발"],
  requirements: [{ text: "Python 3년 이상", category: "experience", evidence: "Python 3년 이상" }],
  preferences: [],
  required_skills: ["Python"],
  tech_stack: ["Django"],
  experience_level: { type: "mid", min_years: 3, max_years: null, raw_text: "경력 3년 이상" },
  education: { level: null, raw_text: null },
  location: "서울",
  salary: { min: null, max: null, is_negotiable: null, raw_text: null },
  deadline: { date: "2026-08-31", is_rolling: false, raw_text: "마감: 2026-08-31" },
  keywords: ["백엔드", "Python"],
  extraction_notes: null,
};

const samplePosting: JobPostingRow = {
  id: "posting-1",
  url: null,
  normalized_url: null,
  url_hash: null,
  source_site: "manual_paste",
  raw_snapshot: "[테스트컴퍼니] 백엔드 개발자 채용 — Python 3년 이상",
  snapshot_hash: "hash",
  status: "active",
  latest_extraction_id: null,
  fetched_at: null,
  created_at: "2026-07-09T00:00:00Z",
};

/** stop_reason 시퀀스대로 응답하는 fake Anthropic (마지막 항목 반복) */
function makeFakeAnthropic(
  sequence: Array<{ stop_reason: string; text?: string; throws?: Error }>
): { client: Anthropic; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const fake = {
    messages: {
      stream(params: Record<string, unknown>) {
        calls.push(params);
        const turn = sequence[Math.min(calls.length - 1, sequence.length - 1)];
        return {
          async finalMessage() {
            if (turn.throws) throw turn.throws;
            return {
              stop_reason: turn.stop_reason,
              content: turn.text !== undefined ? [{ type: "text", text: turn.text }] : [],
              usage: {
                input_tokens: 1200,
                output_tokens: 800,
                cache_read_input_tokens: 1000,
                cache_creation_input_tokens: 50,
              },
            };
          },
        };
      },
    },
  };
  return { client: fake as unknown as Anthropic, calls };
}

const okTurn = { stop_reason: "end_turn", text: JSON.stringify(sampleExtraction) };

interface FakeSupabaseOptions {
  posting?: JobPostingRow | null;
  /** 캐시 조회가 반환할 최신 extraction 행 (기본 없음 = cache miss) */
  extraction?: PostingExtractionRow | null;
  selectError?: { message: string };
  insertError?: { message: string };
}

/** select/insert/update 체인을 흉내 내는 최소 fake */
function makeFakeSupabase(options: FakeSupabaseOptions = {}): {
  client: SupabaseClient;
  inserts: Array<{ table: string; values: Record<string, unknown> }>;
} {
  const inserts: Array<{ table: string; values: Record<string, unknown> }> = [];
  const client = {
    from(table: string) {
      return {
        select: () => ({
          eq: () => ({
            // job_postings 조회 경로 (eq→maybeSingle)
            maybeSingle: async () =>
              options.selectError
                ? { data: null, error: options.selectError }
                : { data: options.posting ?? null, error: null },
            // posting_extractions 최신 조회 경로 (eq→order→limit→maybeSingle)
            order: () => ({
              limit: () => ({
                maybeSingle: async () => ({ data: options.extraction ?? null, error: null }),
              }),
            }),
          }),
        }),
        insert(values: Record<string, unknown>) {
          inserts.push({ table, values });
          return {
            select: () => ({
              single: async () =>
                options.insertError
                  ? { data: null, error: options.insertError }
                  : {
                      data: { id: "ext-1", created_at: "2026-07-09T00:00:00Z", ...values },
                      error: null,
                    },
            }),
          };
        },
        update: () => ({ eq: async () => ({ error: null }) }),
      };
    },
  } as unknown as SupabaseClient;
  return { client, inserts };
}

async function catchCode(promise: Promise<unknown>): Promise<ExtractPostingErrorLike> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ExtractPostingError);
  return error as ExtractPostingErrorLike;
}
type ExtractPostingErrorLike = ExtractPostingError;

let consoleError: MockInstance;
let consoleLog: MockInstance;
beforeEach(() => {
  // 실패(console.error)·캐시(console.log) 로깅 검증 + 테스트 출력 소음 제거
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  consoleError.mockRestore();
  consoleLog.mockRestore();
});

describe("extractAndStorePosting — 성공 경로", () => {
  it("조회 → 구조화 → 저장 후 공고와 extraction 행을 반환한다", async () => {
    const { client: anthropic } = makeFakeAnthropic([okTurn]);
    const { client: supabase, inserts } = makeFakeSupabase({ posting: samplePosting });

    const output = await extractAndStorePosting({ anthropic, supabase }, "posting-1");

    expect(output.posting.id).toBe("posting-1");
    expect(output.extraction.id).toBe("ext-1");
    expect(output.cacheHit).toBe(false);
    expect(output.cacheMissReason).toBe("no_extraction");
    expect(inserts[0].values).toMatchObject({
      posting_id: "posting-1",
      extracted: sampleExtraction,
      model_id: "claude-opus-4-8",
      prompt_version: "extract-v1",
      schema_version: "extract-schema-v1",
    });
  });

  it("raw_snapshot을 본문으로, 힌트(title/siteName)를 user 메시지에 전달한다", async () => {
    const { client: anthropic, calls } = makeFakeAnthropic([okTurn]);
    const { client: supabase } = makeFakeSupabase({ posting: samplePosting });

    await extractAndStorePosting({ anthropic, supabase }, "posting-1", {
      title: "백엔드 채용",
      siteName: "원티드",
    });

    const messages = calls[0].messages as Array<{ content: string }>;
    expect(messages[0].content).toContain(samplePosting.raw_snapshot);
    expect(messages[0].content).toContain("페이지 제목: 백엔드 채용");
    expect(messages[0].content).toContain("수집 사이트: 원티드");
  });
});

describe("extractAndStorePosting — 구조화 캐시 (M1-8, 6.2)", () => {
  /** 현재 버전 3종과 일치하는 유효한 캐시 행 */
  const cachedExtraction: PostingExtractionRow = {
    id: "ext-cached",
    posting_id: "posting-1",
    extracted: sampleExtraction,
    company_name: "테스트컴퍼니",
    job_title: "백엔드 개발자",
    deadline_date: "2026-08-31",
    model_id: EXTRACTION_MODEL_ID,
    prompt_version: EXTRACT_PROMPT_VERSION,
    schema_version: EXTRACTION_SCHEMA_VERSION,
    token_usage: { input: 1200, output: 800, cache_read: 1000, cache_creation: 50 },
    created_at: "2026-07-09T00:00:00Z",
  };
  /** 판정 시각 고정 — created_at 반나절 뒤 (유효기간 이내) */
  const cacheOptions = { now: () => new Date("2026-07-09T12:00:00Z") };

  it("cache hit: 기존 extraction을 반환하고 LLM 호출·저장을 하지 않는다", async () => {
    const { client: anthropic, calls } = makeFakeAnthropic([okTurn]);
    const { client: supabase, inserts } = makeFakeSupabase({
      posting: samplePosting,
      extraction: cachedExtraction,
    });

    const output = await extractAndStorePosting(
      { anthropic, supabase },
      "posting-1",
      {},
      cacheOptions
    );

    expect(output.cacheHit).toBe(true);
    expect(output.extraction).toEqual(cachedExtraction);
    expect(calls).toHaveLength(0); // AI 호출 금지
    expect(inserts).toHaveLength(0); // 새 행도 만들지 않는다
    expect(consoleLog).toHaveBeenCalledWith(
      expect.stringContaining("cache_hit"),
      expect.objectContaining({ postingId: "posting-1", extractionId: "ext-cached" })
    );
  });

  async function expectMissAndReextract(
    extraction: PostingExtractionRow,
    expectedReason: string
  ): Promise<void> {
    const { client: anthropic, calls } = makeFakeAnthropic([okTurn]);
    const { client: supabase, inserts } = makeFakeSupabase({
      posting: samplePosting,
      extraction,
    });

    const output = await extractAndStorePosting(
      { anthropic, supabase },
      "posting-1",
      {},
      cacheOptions
    );

    expect(output.cacheHit).toBe(false);
    expect(output.cacheMissReason).toBe(expectedReason);
    expect(calls).toHaveLength(1); // 재분석 수행
    expect(inserts).toHaveLength(1); // 새 버전 행 저장
    expect(consoleLog).toHaveBeenCalledWith(
      expect.stringContaining("cache_miss"),
      expect.objectContaining({ postingId: "posting-1", cache_reason: expectedReason })
    );
  }

  it("schema_version이 다르면 miss → 재분석", async () => {
    await expectMissAndReextract(
      { ...cachedExtraction, schema_version: "extract-schema-v0" },
      "schema_version_mismatch"
    );
  });

  it("prompt_version이 다르면 miss → 재분석", async () => {
    await expectMissAndReextract(
      { ...cachedExtraction, prompt_version: "extract-v0" },
      "prompt_version_mismatch"
    );
  });

  it("model이 다르면 miss → 재분석", async () => {
    await expectMissAndReextract(
      { ...cachedExtraction, model_id: "claude-sonnet-5" },
      "model_mismatch"
    );
  });

  it("유효기간이 지나면 miss(expired) → 재분석", async () => {
    await expectMissAndReextract(
      { ...cachedExtraction, created_at: "2026-06-01T00:00:00Z" },
      "expired"
    );
  });

  it("이전 구조화가 실패해 행이 없으면 miss(no_extraction) → 재분석 (실패는 저장되지 않는다)", async () => {
    const { client: anthropic, calls } = makeFakeAnthropic([okTurn]);
    const { client: supabase, inserts } = makeFakeSupabase({
      posting: samplePosting,
      extraction: null,
    });

    const output = await extractAndStorePosting(
      { anthropic, supabase },
      "posting-1",
      {},
      cacheOptions
    );

    expect(output.cacheHit).toBe(false);
    expect(output.cacheMissReason).toBe("no_extraction");
    expect(calls).toHaveLength(1);
    expect(inserts).toHaveLength(1);
  });
});

describe("extractAndStorePosting — 실패 코드 정규화와 로깅", () => {
  it("공고가 없으면 posting_not_found", async () => {
    const { client: anthropic } = makeFakeAnthropic([okTurn]);
    const { client: supabase } = makeFakeSupabase({ posting: null });

    const error = await catchCode(extractAndStorePosting({ anthropic, supabase }, "no-such-id"));
    expect(error.code).toBe("posting_not_found");
    expect(consoleError).toHaveBeenCalled();
  });

  it("공고 조회 쿼리 실패는 storage_error", async () => {
    const { client: anthropic } = makeFakeAnthropic([okTurn]);
    const { client: supabase } = makeFakeSupabase({ selectError: { message: "db down" } });

    const error = await catchCode(extractAndStorePosting({ anthropic, supabase }, "posting-1"));
    expect(error.code).toBe("storage_error");
  });

  it("raw_snapshot이 비어 있으면 empty_snapshot — LLM을 호출하지 않는다", async () => {
    const { client: anthropic, calls } = makeFakeAnthropic([okTurn]);
    const { client: supabase } = makeFakeSupabase({
      posting: { ...samplePosting, raw_snapshot: "   " },
    });

    const error = await catchCode(extractAndStorePosting({ anthropic, supabase }, "posting-1"));
    expect(error.code).toBe("empty_snapshot");
    expect(calls).toHaveLength(0);
  });

  it("구조화가 재시도까지 실패하면 llm_error (원인 ExtractionError 보존)", async () => {
    const { client: anthropic, calls } = makeFakeAnthropic([{ stop_reason: "refusal" }]);
    const { client: supabase, inserts } = makeFakeSupabase({ posting: samplePosting });

    const error = await catchCode(extractAndStorePosting({ anthropic, supabase }, "posting-1"));
    expect(error.code).toBe("llm_error");
    expect(calls).toHaveLength(2); // 모듈 내 1회 재시도 후 소진
    expect(inserts).toHaveLength(0); // 실패 시 저장하지 않는다
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("구조화 실패"),
      expect.objectContaining({ postingId: "posting-1", code: "refusal" })
    );
  });

  it("LLM API 예외(429/5xx)도 llm_error로 정규화한다", async () => {
    const { client: anthropic } = makeFakeAnthropic([
      { stop_reason: "end_turn", throws: new Error("rate limited") },
    ]);
    const { client: supabase } = makeFakeSupabase({ posting: samplePosting });

    const error = await catchCode(extractAndStorePosting({ anthropic, supabase }, "posting-1"));
    expect(error.code).toBe("llm_error");
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("LLM API 오류"),
      expect.anything()
    );
  });

  it("저장 실패는 storage_error", async () => {
    const { client: anthropic } = makeFakeAnthropic([okTurn]);
    const { client: supabase } = makeFakeSupabase({
      posting: samplePosting,
      insertError: { message: "insert failed" },
    });

    const error = await catchCode(extractAndStorePosting({ anthropic, supabase }, "posting-1"));
    expect(error.code).toBe("storage_error");
  });
});
