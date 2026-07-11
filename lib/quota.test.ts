import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { FREE_MONTHLY_ANALYSIS_QUOTA, getQuotaStatus } from "./quota";

/** 쿼터 판정(M4-1) — 사용량 fake로 산식만 검증한다 */

function makeClientWithUsedCount(count: number): SupabaseClient {
  const chain = {
    eq: () => chain,
    gte: () => Promise.resolve({ count, error: null }),
  };
  return { from: () => ({ select: () => chain }) } as unknown as SupabaseClient;
}

describe("getQuotaStatus", () => {
  it("사용량과 남은 횟수를 계산한다", async () => {
    const status = await getQuotaStatus(makeClientWithUsedCount(3), "user-1");
    expect(status).toEqual({
      limit: FREE_MONTHLY_ANALYSIS_QUOTA,
      used: 3,
      remaining: FREE_MONTHLY_ANALYSIS_QUOTA - 3,
    });
  });

  it("한도 초과여도 남은 횟수는 0 밑으로 내려가지 않는다", async () => {
    const status = await getQuotaStatus(
      makeClientWithUsedCount(FREE_MONTHLY_ANALYSIS_QUOTA + 5),
      "user-1"
    );
    expect(status.remaining).toBe(0);
  });
});
