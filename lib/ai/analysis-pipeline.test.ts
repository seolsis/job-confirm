import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import type { ProfileSnapshotRow } from "@/lib/db/profile-snapshots";
import { normalizeUrl, urlHash, ScrapeError, type ScrapedPosting } from "@/lib/scraper";

import {
  AnalysisPipelineError,
  AnalysisRequestError,
  isNotAPosting,
  runAnalysisPipeline,
  toJobErrorCode,
} from "./analysis-pipeline";
import { EXTRACTION_MODEL_ID } from "./extract";
import { MATCH_MODEL_ID } from "./match";
import type { MatchResult } from "./match-schemas";
import { MATCH_SCHEMA_VERSION } from "./match-schemas";
import { EXTRACT_PROMPT_VERSION } from "./prompts/extract-v1";
import { MATCH_PROMPT_VERSION } from "./prompts/match-v1";
import { EXTRACTION_SCHEMA_VERSION, type PostingExtraction } from "./schemas";

/**
 * 분석 파이프라인(M1-14) 단위 테스트 — Anthropic도 Supabase도 실제로 호출하지 않는다.
 * 인메모리 fake Supabase로 잡 생성 → 단계 전이 → 결과 저장 → done/failed 마감의
 * 오케스트레이션 전체를 검증한다.
 */

const USER_ID = "user-1";
const SNAPSHOT_ID = "snapshot-1";
const TEST_URL = "https://careers.example.com/jobs/7";

const REQUIREMENT_TEXT = "Python 3년 이상 실무 경험";

const sampleExtraction: PostingExtraction = {
  company_name: "테스트컴퍼니",
  job_title: "백엔드 개발자",
  job_category: "서버 개발",
  responsibilities: ["API 서버 개발"],
  requirements: [{ text: REQUIREMENT_TEXT, category: "experience", evidence: REQUIREMENT_TEXT }],
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

/** 전 요건 met — 산식(5.2)상 70 + 20(우대 없음 만점) + 10(경력 met, 학력 제약 없음) = 100 */
const sampleMatch: MatchResult = {
  requirement_judgments: [
    {
      requirement_text: REQUIREMENT_TEXT,
      verdict: "met",
      profile_evidence: "Python 백엔드 4년",
      reason: "요구 연차를 충족한다",
    },
  ],
  preference_judgments: [],
  fit_reasons: ["Python 실무 경험이 요구 연차를 충족한다"],
  gaps: [],
  strengths: [],
  skills_to_learn: [],
  certificates_to_prepare: [],
  expected_interview_questions: [],
  action_items: [],
  overall_comment: "적합한 포지션입니다.",
};

const snapshotRow: ProfileSnapshotRow = {
  id: SNAPSHOT_ID,
  user_id: USER_ID,
  snapshot: {
    desired_job: "백엔드 개발자",
    desired_conditions: {},
    educations: [],
    experiences: [{ company: "A사", role: "백엔드", period_months: 48, description: "Python" }],
    skills: [{ name: "Python", level: null, years: 4 }],
    certificates: [],
    languages: [],
    projects: [],
  },
  content_hash: "hash-1",
  created_at: "2026-07-01T00:00:00Z",
};

function makeScraped(): ScrapedPosting {
  const normalized = normalizeUrl(TEST_URL);
  return {
    sourceSite: "generic",
    url: TEST_URL,
    normalizedUrl: normalized,
    urlHash: urlHash(normalized),
    title: "백엔드 개발자 채용",
    siteName: "자사 채용",
    bodyText: "[테스트컴퍼니] 백엔드 개발자 — Python 3년 이상 실무 경험",
    snapshotHash: "snap-hash",
    fetchedAt: "2026-07-09T00:00:00Z",
  };
}

// ── fake Anthropic (extraction-service.test.ts와 동일 패턴) ──────────────────

function makeFakeAnthropic(sequence: Array<{ stop_reason: string; text?: string }>): {
  client: Anthropic;
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  const fake = {
    messages: {
      stream(params: Record<string, unknown>) {
        calls.push(params);
        const turn = sequence[Math.min(calls.length - 1, sequence.length - 1)];
        return {
          async finalMessage() {
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

const extractTurn = { stop_reason: "end_turn", text: JSON.stringify(sampleExtraction) };
const matchTurn = { stop_reason: "end_turn", text: JSON.stringify(sampleMatch) };

// ── 인메모리 fake Supabase — 파이프라인이 쓰는 5개 테이블과 체인만 구현 ────────

type Row = Record<string, unknown>;

function makeFakeSupabase(seed: Partial<Record<string, Row[]>> = {}): {
  client: SupabaseClient;
  tables: Record<string, Row[]>;
  /** analysis_jobs update 페이로드 기록 (단계 전이 순서 검증용) */
  jobUpdates: Row[];
} {
  const tables: Record<string, Row[]> = {
    jobConfirm_profile_snapshots: [],
    jobConfirm_job_postings: [],
    jobConfirm_posting_extractions: [],
    jobConfirm_analysis_jobs: [],
    jobConfirm_match_analyses: [],
    ...seed,
  };
  const jobUpdates: Row[] = [];
  let seq = 0;

  const defaults = (table: string): Row => {
    const now = new Date().toISOString();
    const base = { id: `${table.replace("jobConfirm_", "")}-${++seq}`, created_at: now };
    if (table === "jobConfirm_analysis_jobs") {
      return { ...base, posting_id: null, step: "queued", error_code: null, updated_at: now };
    }
    if (table === "jobConfirm_job_postings") {
      return { ...base, status: "active", latest_extraction_id: null };
    }
    if (table === "jobConfirm_match_analyses") {
      return { ...base, feedback: null, feedback_reason: null };
    }
    return base;
  };

  const client = {
    from(table: string) {
      const rows = tables[table] ?? (tables[table] = []);
      return {
        select() {
          const filters: Array<[string, unknown]> = [];
          let descending = false;
          const find = () => {
            let found = rows.filter((r) => filters.every(([k, v]) => r[k] === v));
            if (descending) {
              found = [...found].sort((a, b) =>
                String(b.created_at).localeCompare(String(a.created_at))
              );
            }
            return found;
          };
          const chain = {
            eq(key: string, value: unknown) {
              filters.push([key, value]);
              return chain;
            },
            order() {
              descending = true;
              return chain;
            },
            limit() {
              return chain;
            },
            async maybeSingle() {
              return { data: find()[0] ?? null, error: null };
            },
          };
          return chain;
        },
        insert(values: Row) {
          return {
            select: () => ({
              single: async () => {
                const row = { ...defaults(table), ...values };
                rows.push(row);
                return { data: row, error: null };
              },
            }),
          };
        },
        update(values: Row) {
          if (table === "jobConfirm_analysis_jobs") jobUpdates.push(values);
          const apply = (key: string, value: unknown): Row | null => {
            const row = rows.find((r) => r[key] === value);
            if (row) Object.assign(row, values);
            return row ?? null;
          };
          return {
            eq(key: string, value: unknown) {
              return {
                // update().eq().select().single() — analysis_jobs 갱신 경로
                select: () => ({
                  single: async () => ({ data: apply(key, value), error: null }),
                }),
                // await update().eq() — latest_extraction_id 포인터 갱신 경로 (thenable)
                then(resolve: (result: { error: null }) => void) {
                  apply(key, value);
                  resolve({ error: null });
                },
              };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;

  return { client, tables, jobUpdates };
}

/** 캐시 히트 시나리오용 seed — 현재 버전과 일치하는 최신 extraction */
function seedCachedExtraction(): Partial<Record<string, Row[]>> {
  const normalized = normalizeUrl(TEST_URL);
  return {
    jobConfirm_job_postings: [
      {
        id: "posting-cached",
        url: TEST_URL,
        normalized_url: normalized,
        url_hash: urlHash(normalized),
        source_site: "generic",
        raw_snapshot: "본문",
        snapshot_hash: "snap",
        status: "active",
        latest_extraction_id: "extraction-cached",
        fetched_at: "2026-07-08T00:00:00Z",
        created_at: "2026-07-08T00:00:00Z",
      },
    ],
    jobConfirm_posting_extractions: [
      {
        id: "extraction-cached",
        posting_id: "posting-cached",
        extracted: sampleExtraction,
        company_name: "테스트컴퍼니",
        job_title: "백엔드 개발자",
        deadline_date: "2026-08-31",
        model_id: EXTRACTION_MODEL_ID,
        prompt_version: EXTRACT_PROMPT_VERSION,
        schema_version: EXTRACTION_SCHEMA_VERSION,
        token_usage: null,
        created_at: new Date().toISOString(), // 방금 생성 — 유효기간 이내
      },
    ],
  };
}

const seedSnapshot = { jobConfirm_profile_snapshots: [snapshotRow as unknown as Row] };

let logSpy: MockInstance;
let errorSpy: MockInstance;
beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
});

const jobsOf = (tables: Record<string, Row[]>) => tables.jobConfirm_analysis_jobs;
const stepsOf = (jobUpdates: Row[]) =>
  jobUpdates.map((u) => u.step).filter((s): s is string => typeof s === "string");

describe("runAnalysisPipeline — 성공 경로", () => {
  it("URL 신규 분석: 수집→구조화→매칭→점수→저장→done을 완주한다", async () => {
    const { client: anthropic, calls } = makeFakeAnthropic([extractTurn, matchTurn]);
    const { client: supabase, tables, jobUpdates } = makeFakeSupabase(seedSnapshot);
    const scrape = vi.fn(async () => makeScraped());

    const result = await runAnalysisPipeline(
      { anthropic, supabase, scrape },
      { userId: USER_ID, profileSnapshotId: SNAPSHOT_ID, url: TEST_URL }
    );

    // 단계 전이: fetching → extracting → matching → scoring → done (M1-12 재사용)
    expect(stepsOf(jobUpdates)).toEqual(["fetching", "extracting", "matching", "scoring", "done"]);
    expect(scrape).toHaveBeenCalledExactlyOnceWith(TEST_URL);
    expect(calls).toHaveLength(2); // LLM #1 구조화 + LLM #2 매칭

    // 공고·구조화·분석 결과가 저장됐다
    expect(tables.jobConfirm_job_postings).toHaveLength(1);
    expect(tables.jobConfirm_posting_extractions).toHaveLength(1);
    expect(tables.jobConfirm_match_analyses).toHaveLength(1);

    // 잡 마감 상태 — done + posting_id 연결
    const job = jobsOf(tables)[0];
    expect(job.step).toBe("done");
    expect(job.posting_id).toBe(result.posting.id);
    expect(job.error_code).toBeNull();

    // 분석 결과 행 — 참조·점수·버전이 모두 실린다
    const analysis = tables.jobConfirm_match_analyses[0];
    expect(analysis.user_id).toBe(USER_ID);
    expect(analysis.extraction_id).toBe(result.extraction.id);
    expect(analysis.profile_snapshot_id).toBe(SNAPSHOT_ID);
    expect(analysis.score).toBe(100); // 전 요건 met (5.2 산식)
    expect(analysis.grade).toBe("recommend");
    expect(analysis.critical_gap_count).toBe(0);
    expect(analysis.model_id).toBe(MATCH_MODEL_ID);
    expect(analysis.prompt_version).toBe(MATCH_PROMPT_VERSION);
    expect(analysis.schema_version).toBe(MATCH_SCHEMA_VERSION);
    expect(analysis.token_usage).toEqual({
      input: 1200,
      output: 800,
      cache_read: 1000,
      cache_creation: 50,
    });

    expect(result.extractionCacheHit).toBe(false);
    expect(result.job.step).toBe("done");
  });

  it("URL 캐시 히트: 수집·구조화(LLM #1)를 건너뛰고 matching으로 직행한다 (6.2)", async () => {
    const { client: anthropic, calls } = makeFakeAnthropic([matchTurn]);
    const {
      client: supabase,
      tables,
      jobUpdates,
    } = makeFakeSupabase({
      ...seedSnapshot,
      ...seedCachedExtraction(),
    });
    const scrape = vi.fn(async () => makeScraped());

    const result = await runAnalysisPipeline(
      { anthropic, supabase, scrape },
      { userId: USER_ID, profileSnapshotId: SNAPSHOT_ID, url: TEST_URL }
    );

    expect(stepsOf(jobUpdates)).toEqual(["fetching", "matching", "scoring", "done"]); // extracting 없음
    expect(scrape).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1); // 매칭만 호출 — 구조화 LLM 없음
    expect(result.extractionCacheHit).toBe(true);
    expect(result.extraction.id).toBe("extraction-cached");
    expect(tables.jobConfirm_posting_extractions).toHaveLength(1); // 새 행 없음
    expect(jobsOf(tables)[0].posting_id).toBe("posting-cached");
  });

  it("붙여넣기 폴백: manual_paste로 동일 파이프라인을 완주한다 (8장)", async () => {
    const { client: anthropic, calls } = makeFakeAnthropic([extractTurn, matchTurn]);
    const { client: supabase, tables, jobUpdates } = makeFakeSupabase(seedSnapshot);

    const pastedText =
      "[테스트컴퍼니] 백엔드 개발자 채용\n자격 요건: Python 3년 이상 실무 경험, RDBMS 활용 능력";
    await runAnalysisPipeline(
      { anthropic, supabase },
      { userId: USER_ID, profileSnapshotId: SNAPSHOT_ID, pastedText }
    );

    expect(stepsOf(jobUpdates)).toEqual(["fetching", "extracting", "matching", "scoring", "done"]);
    expect(calls).toHaveLength(2);
    const posting = tables.jobConfirm_job_postings[0];
    expect(posting.source_site).toBe("manual_paste");
    expect(posting.url).toBeNull();
  });
});

describe("runAnalysisPipeline — 실패 시 failed + error_code (M1-12 재사용)", () => {
  it("수집 실패 → fetch_failed로 잡을 마감하고 AnalysisPipelineError를 던진다", async () => {
    const { client: anthropic } = makeFakeAnthropic([extractTurn]);
    const { client: supabase, tables } = makeFakeSupabase(seedSnapshot);
    const scrape = vi.fn(async () => {
      throw new ScrapeError("fetch_failed", "HTTP 403");
    });

    const error = await runAnalysisPipeline(
      { anthropic, supabase, scrape },
      { userId: USER_ID, profileSnapshotId: SNAPSHOT_ID, url: TEST_URL }
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AnalysisPipelineError);
    const pipelineError = error as AnalysisPipelineError;
    expect(pipelineError.errorCode).toBe("fetch_failed");

    const job = jobsOf(tables)[0];
    expect(pipelineError.jobId).toBe(job.id);
    expect(job.step).toBe("failed");
    expect(job.error_code).toBe("fetch_failed");
    expect(tables.jobConfirm_match_analyses).toHaveLength(0);
  });

  it("붙여넣은 본문이 너무 짧으면 fetch_failed", async () => {
    const { client: anthropic } = makeFakeAnthropic([extractTurn]);
    const { client: supabase, tables } = makeFakeSupabase(seedSnapshot);

    const error = await runAnalysisPipeline(
      { anthropic, supabase },
      { userId: USER_ID, profileSnapshotId: SNAPSHOT_ID, pastedText: "짧음" }
    ).catch((e: unknown) => e);

    expect((error as AnalysisPipelineError).errorCode).toBe("fetch_failed");
    expect(jobsOf(tables)[0].error_code).toBe("fetch_failed");
  });

  it("매칭 LLM이 계속 거부하면 llm_error로 마감한다", async () => {
    // 1번째 호출(구조화) 성공 → 이후 호출(매칭 + 재시도)은 전부 refusal
    const { client: anthropic } = makeFakeAnthropic([extractTurn, { stop_reason: "refusal" }]);
    const { client: supabase, tables, jobUpdates } = makeFakeSupabase(seedSnapshot);
    const scrape = vi.fn(async () => makeScraped());

    const error = await runAnalysisPipeline(
      { anthropic, supabase, scrape },
      { userId: USER_ID, profileSnapshotId: SNAPSHOT_ID, url: TEST_URL }
    ).catch((e: unknown) => e);

    expect((error as AnalysisPipelineError).errorCode).toBe("llm_error");
    expect(stepsOf(jobUpdates)).toEqual(["fetching", "extracting", "matching", "failed"]);
    const job = jobsOf(tables)[0];
    expect(job.step).toBe("failed");
    expect(job.error_code).toBe("llm_error");
  });

  it("구조화 결과가 공고가 아니면 not_a_posting으로 마감한다 (8장)", async () => {
    const notPosting: PostingExtraction = {
      ...sampleExtraction,
      company_name: null,
      job_title: null,
      requirements: [],
      extraction_notes: "채용공고가 아님: 404 페이지",
    };
    const { client: anthropic } = makeFakeAnthropic([
      { stop_reason: "end_turn", text: JSON.stringify(notPosting) },
    ]);
    const { client: supabase, tables } = makeFakeSupabase(seedSnapshot);
    const scrape = vi.fn(async () => makeScraped());

    const error = await runAnalysisPipeline(
      { anthropic, supabase, scrape },
      { userId: USER_ID, profileSnapshotId: SNAPSHOT_ID, url: TEST_URL }
    ).catch((e: unknown) => e);

    expect((error as AnalysisPipelineError).errorCode).toBe("not_a_posting");
    expect(jobsOf(tables)[0].error_code).toBe("not_a_posting");
    expect(tables.jobConfirm_match_analyses).toHaveLength(0); // 매칭까지 가지 않는다
  });
});

describe("runAnalysisPipeline — 잡 생성 전 거절 (AnalysisRequestError)", () => {
  it("프로필 스냅샷이 없으면 snapshot_not_found — 잡을 만들지 않는다", async () => {
    const { client: anthropic } = makeFakeAnthropic([extractTurn]);
    const { client: supabase, tables } = makeFakeSupabase(); // 스냅샷 seed 없음

    const error = await runAnalysisPipeline(
      { anthropic, supabase },
      { userId: USER_ID, profileSnapshotId: SNAPSHOT_ID, url: TEST_URL }
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AnalysisRequestError);
    expect((error as AnalysisRequestError).code).toBe("snapshot_not_found");
    expect(jobsOf(tables)).toHaveLength(0);
  });

  it("타인 소유 스냅샷도 snapshot_not_found로 취급한다 (존재 여부 비노출)", async () => {
    const { client: anthropic } = makeFakeAnthropic([extractTurn]);
    const { client: supabase, tables } = makeFakeSupabase({
      jobConfirm_profile_snapshots: [{ ...(snapshotRow as unknown as Row), user_id: "other-user" }],
    });

    const error = await runAnalysisPipeline(
      { anthropic, supabase },
      { userId: USER_ID, profileSnapshotId: SNAPSHOT_ID, url: TEST_URL }
    ).catch((e: unknown) => e);

    expect((error as AnalysisRequestError).code).toBe("snapshot_not_found");
    expect(jobsOf(tables)).toHaveLength(0);
  });

  it.each([
    { name: "url과 pastedText를 둘 다 주면", url: TEST_URL, pastedText: "본문" },
    { name: "url도 pastedText도 없으면", url: undefined, pastedText: undefined },
  ])("$name invalid_input", async ({ url, pastedText }) => {
    const { client: anthropic } = makeFakeAnthropic([extractTurn]);
    const { client: supabase, tables } = makeFakeSupabase(seedSnapshot);

    const error = await runAnalysisPipeline(
      { anthropic, supabase },
      { userId: USER_ID, profileSnapshotId: SNAPSHOT_ID, url, pastedText }
    ).catch((e: unknown) => e);

    expect((error as AnalysisRequestError).code).toBe("invalid_input");
    expect(jobsOf(tables)).toHaveLength(0);
  });
});

describe("보조 순수 함수", () => {
  it("isNotAPosting: 회사명·직무명이 모두 null일 때만 true", () => {
    expect(isNotAPosting({ ...sampleExtraction, company_name: null, job_title: null })).toBe(true);
    expect(isNotAPosting({ ...sampleExtraction, company_name: null })).toBe(false);
    expect(isNotAPosting(sampleExtraction)).toBe(false);
  });

  it("toJobErrorCode: 원인별 error_code 매핑", () => {
    expect(toJobErrorCode(new ScrapeError("disallowed_by_robots", "차단"))).toBe("fetch_failed");
    expect(toJobErrorCode(new Error("알 수 없는 오류"))).toBe("llm_error");
  });
});
