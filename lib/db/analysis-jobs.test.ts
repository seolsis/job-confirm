import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import {
  createAnalysisJob,
  failAnalysisJob,
  isValidStepTransition,
  JobTransitionError,
  updateAnalysisJobStep,
  type AnalysisJobRow,
  type JobStep,
} from "./analysis-jobs";
import { StorageError } from "./errors";

/**
 * analysis_jobs 상태 관리 단위 테스트 (M1-12) — 실제 Supabase는 호출하지 않는다.
 * 전이 규칙(순수 함수)과 조회→검증→갱신 흐름을 fake로 검증한다.
 */

function makeJob(step: JobStep, overrides: Partial<AnalysisJobRow> = {}): AnalysisJobRow {
  return {
    id: "job-1",
    user_id: "user-1",
    posting_id: null,
    step,
    error_code: null,
    created_at: "2026-07-09T00:00:00Z",
    updated_at: "2026-07-09T00:00:00Z",
    ...overrides,
  };
}

/** select(현재 행)·insert·update 체인을 흉내 내는 최소 fake */
function makeFakeSupabase(options: { job?: AnalysisJobRow | null } = {}): {
  client: SupabaseClient;
  inserts: Array<Record<string, unknown>>;
  updates: Array<Record<string, unknown>>;
} {
  const inserts: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const client = {
    from() {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: options.job ?? null, error: null }),
          }),
        }),
        insert(values: Record<string, unknown>) {
          inserts.push(values);
          return {
            select: () => ({
              single: async () => ({
                data: { ...makeJob("queued"), ...values },
                error: null,
              }),
            }),
          };
        },
        update(values: Record<string, unknown>) {
          updates.push(values);
          return {
            eq: () => ({
              select: () => ({
                single: async () => ({
                  data: { ...(options.job ?? makeJob("queued")), ...values },
                  error: null,
                }),
              }),
            }),
          };
        },
      };
    },
  } as unknown as SupabaseClient;
  return { client, inserts, updates };
}

describe("isValidStepTransition (순수 함수) — 상태 흐름 규칙", () => {
  it("정상 흐름: queued → fetching → extracting → matching → scoring → done", () => {
    expect(isValidStepTransition("queued", "fetching")).toBe(true);
    expect(isValidStepTransition("fetching", "extracting")).toBe(true);
    expect(isValidStepTransition("extracting", "matching")).toBe(true);
    expect(isValidStepTransition("matching", "scoring")).toBe(true);
    expect(isValidStepTransition("scoring", "done")).toBe(true);
  });

  it("단계 건너뜀 허용 — 캐시 히트 시 fetching/extracting을 건너뛴다 (6.2)", () => {
    expect(isValidStepTransition("queued", "matching")).toBe(true);
    expect(isValidStepTransition("fetching", "matching")).toBe(true);
  });

  it("역행 금지", () => {
    expect(isValidStepTransition("matching", "extracting")).toBe(false);
    expect(isValidStepTransition("scoring", "queued")).toBe(false);
    expect(isValidStepTransition("fetching", "fetching")).toBe(false);
  });

  it("어느 진행 단계에서든 failed로 전이 가능", () => {
    for (const from of ["queued", "fetching", "extracting", "matching", "scoring"] as const) {
      expect(isValidStepTransition(from, "failed")).toBe(true);
    }
  });

  it("done / failed는 종결 상태 — 어떤 전이도 불가", () => {
    expect(isValidStepTransition("done", "failed")).toBe(false);
    expect(isValidStepTransition("failed", "queued")).toBe(false);
    expect(isValidStepTransition("failed", "failed")).toBe(false);
  });
});

describe("createAnalysisJob", () => {
  it("user_id로 잡을 만들고 posting_id는 기본 null (수집 전 큐잉)", async () => {
    const { client, inserts } = makeFakeSupabase();
    const job = await createAnalysisJob(client, { userId: "user-1" });

    expect(inserts).toEqual([{ user_id: "user-1", posting_id: null }]);
    expect(job.step).toBe("queued");
  });

  it("postingId를 주면 함께 기록한다", async () => {
    const { client, inserts } = makeFakeSupabase();
    await createAnalysisJob(client, { userId: "user-1", postingId: "posting-1" });

    expect(inserts[0]).toEqual({ user_id: "user-1", posting_id: "posting-1" });
  });
});

describe("updateAnalysisJobStep", () => {
  it("유효한 전이면 step을 갱신하고 갱신된 행을 반환한다", async () => {
    const { client, updates } = makeFakeSupabase({ job: makeJob("queued") });
    const job = await updateAnalysisJobStep(client, "job-1", "fetching");

    expect(updates).toEqual([{ step: "fetching" }]);
    expect(job.step).toBe("fetching");
  });

  it("postingId 옵션으로 수집된 공고를 잡에 연결한다", async () => {
    const { client, updates } = makeFakeSupabase({ job: makeJob("fetching") });
    await updateAnalysisJobStep(client, "job-1", "extracting", { postingId: "posting-1" });

    expect(updates).toEqual([{ step: "extracting", posting_id: "posting-1" }]);
  });

  it("규칙 위반 전이는 JobTransitionError — DB를 건드리지 않는다", async () => {
    const { client, updates } = makeFakeSupabase({ job: makeJob("done") });
    const error = await updateAnalysisJobStep(client, "job-1", "matching").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(JobTransitionError);
    expect((error as JobTransitionError).from).toBe("done");
    expect((error as JobTransitionError).to).toBe("matching");
    expect(updates).toHaveLength(0);
  });

  it("잡이 없으면 StorageError", async () => {
    const { client } = makeFakeSupabase({ job: null });

    await expect(updateAnalysisJobStep(client, "no-such-job", "fetching")).rejects.toThrowError(
      StorageError
    );
  });
});

describe("failAnalysisJob", () => {
  it("step failed + error_code를 함께 기록한다 (폴백 UI 분기용)", async () => {
    const { client, updates } = makeFakeSupabase({ job: makeJob("extracting") });
    const job = await failAnalysisJob(client, "job-1", "llm_error");

    expect(updates).toEqual([{ step: "failed", error_code: "llm_error" }]);
    expect(job.step).toBe("failed");
    expect(job.error_code).toBe("llm_error");
  });

  it("종결 상태에서는 실패 전이도 불가 (JobTransitionError)", async () => {
    const { client, updates } = makeFakeSupabase({ job: makeJob("done") });

    await expect(failAnalysisJob(client, "job-1", "llm_error")).rejects.toThrowError(
      JobTransitionError
    );
    expect(updates).toHaveLength(0);
  });
});
