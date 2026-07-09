import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import type { MatchResult } from "@/lib/ai/match-schemas";

import { StorageError } from "./errors";
import { getLatestMatchAnalysis, saveMatchAnalysis, type NewMatchAnalysis } from "./match-analyses";

/**
 * match_analyses 저장 계층 단위 테스트 — 실제 Supabase는 호출하지 않는다.
 * append-only insert 페이로드와 실패 처리를 검증한다.
 */

const sampleResult: MatchResult = {
  requirement_judgments: [
    {
      requirement_text: "Python 3년 이상",
      verdict: "met",
      profile_evidence: "경력 40개월",
      reason: "충족",
    },
  ],
  preference_judgments: [],
  fit_reasons: [],
  gaps: [],
  strengths: [],
  skills_to_learn: [],
  certificates_to_prepare: [],
  expected_interview_questions: [],
  action_items: [],
  overall_comment: "테스트",
};

const sampleAnalysis: NewMatchAnalysis = {
  user_id: "user-1",
  extraction_id: "ext-1",
  profile_snapshot_id: "snap-1",
  result: sampleResult,
  score: 83,
  grade: "recommend",
  score_breakdown: { requirements: 52.5, preferences: 20, fit: 10 },
  critical_gap_count: 1,
  model_id: "claude-opus-4-8",
  prompt_version: "match-v1",
  schema_version: "match-schema-v1",
  token_usage: { input: 3000, output: 2000, cache_read: 2500, cache_creation: 80 },
};

function makeFakeSupabase(options: { insertError?: { message: string } } = {}): {
  client: SupabaseClient;
  inserts: Array<{ table: string; values: Record<string, unknown> }>;
} {
  const inserts: Array<{ table: string; values: Record<string, unknown> }> = [];
  const client = {
    from(table: string) {
      return {
        insert(values: Record<string, unknown>) {
          inserts.push({ table, values });
          return {
            select: () => ({
              single: async () =>
                options.insertError
                  ? { data: null, error: options.insertError }
                  : {
                      data: { id: "analysis-1", created_at: "2026-07-09T00:00:00Z", ...values },
                      error: null,
                    },
            }),
          };
        },
      };
    },
  } as unknown as SupabaseClient;
  return { client, inserts };
}

describe("saveMatchAnalysis", () => {
  it("행을 저장하고 점수·등급·버전 3종을 페이로드에 싣는다", async () => {
    const { client, inserts } = makeFakeSupabase();
    const row = await saveMatchAnalysis(client, sampleAnalysis);

    expect(row.id).toBe("analysis-1");
    expect(inserts).toHaveLength(1);
    expect(inserts[0].table).toBe("jobConfirm_match_analyses");
    expect(inserts[0].values).toMatchObject({
      user_id: "user-1",
      extraction_id: "ext-1",
      profile_snapshot_id: "snap-1",
      score: 83,
      grade: "recommend",
      score_breakdown: { requirements: 52.5, preferences: 20, fit: 10 },
      critical_gap_count: 1,
      model_id: "claude-opus-4-8",
      prompt_version: "match-v1",
      schema_version: "match-schema-v1",
    });
  });

  it("insufficient_profile은 score null로 저장할 수 있다", async () => {
    const { client, inserts } = makeFakeSupabase();
    await saveMatchAnalysis(client, {
      ...sampleAnalysis,
      score: null,
      grade: "insufficient_profile",
      score_breakdown: null,
    });

    expect(inserts[0].values).toMatchObject({
      score: null,
      grade: "insufficient_profile",
      score_breakdown: null,
    });
  });

  it("insert 실패 시 StorageError를 던진다", async () => {
    const { client } = makeFakeSupabase({ insertError: { message: "boom" } });

    await expect(saveMatchAnalysis(client, sampleAnalysis)).rejects.toThrowError(StorageError);
  });
});

/** select→eq→order→limit→maybeSingle 체인만 흉내 내는 조회용 fake */
function makeFakeSelectSupabase(options: {
  row?: Record<string, unknown> | null;
  selectError?: { message: string };
}): { client: SupabaseClient; filters: Array<[string, unknown]> } {
  const filters: Array<[string, unknown]> = [];
  const client = {
    from: () => ({
      select: () => ({
        eq(key: string, value: unknown) {
          filters.push([key, value]);
          return {
            order: () => ({
              limit: () => ({
                maybeSingle: async () =>
                  options.selectError
                    ? { data: null, error: options.selectError }
                    : { data: options.row ?? null, error: null },
              }),
            }),
          };
        },
      }),
    }),
  } as unknown as SupabaseClient;
  return { client, filters };
}

describe("getLatestMatchAnalysis", () => {
  it("extraction_id로 최신 행을 조회한다", async () => {
    const { client, filters } = makeFakeSelectSupabase({ row: { id: "analysis-1" } });
    const row = await getLatestMatchAnalysis(client, "ext-1");

    expect(row?.id).toBe("analysis-1");
    expect(filters).toEqual([["extraction_id", "ext-1"]]);
  });

  it("행이 없으면 null, 조회 실패면 StorageError", async () => {
    const { client: emptyClient } = makeFakeSelectSupabase({ row: null });
    await expect(getLatestMatchAnalysis(emptyClient, "ext-1")).resolves.toBeNull();

    const { client: errorClient } = makeFakeSelectSupabase({ selectError: { message: "boom" } });
    await expect(getLatestMatchAnalysis(errorClient, "ext-1")).rejects.toThrowError(StorageError);
  });
});
