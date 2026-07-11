import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { StorageError } from "./errors";
import { countMonthlyAnalyses, logUsage, monthStartIso } from "./usage-logs";

/** usage_logs 저장 계층(M4-1) 단위 테스트 — 실제 Supabase는 호출하지 않는다 */

describe("monthStartIso (순수 함수)", () => {
  it("UTC 기준 이번 달 1일 00:00을 돌려준다", () => {
    expect(monthStartIso(() => new Date("2026-07-11T15:00:00Z"))).toBe("2026-07-01T00:00:00.000Z");
    expect(monthStartIso(() => new Date("2026-01-01T00:00:00Z"))).toBe("2026-01-01T00:00:00.000Z");
    // 월말 자정 직전(UTC) — 다음 달로 넘어가지 않는다
    expect(monthStartIso(() => new Date("2026-12-31T23:59:59Z"))).toBe("2026-12-01T00:00:00.000Z");
  });
});

describe("logUsage", () => {
  it("snake_case 컬럼으로 insert한다", async () => {
    const inserts: Array<Record<string, unknown>> = [];
    const client = {
      from: () => ({
        insert(values: Record<string, unknown>) {
          inserts.push(values);
          return Promise.resolve({ error: null });
        },
      }),
    } as unknown as SupabaseClient;

    await logUsage(client, {
      userId: "user-1",
      kind: "match",
      wasCacheHit: false,
      tokenUsage: { input_tokens: 10, output_tokens: 20 },
    });

    expect(inserts[0]).toEqual({
      user_id: "user-1",
      kind: "match",
      was_cache_hit: false,
      token_usage: { input_tokens: 10, output_tokens: 20 },
    });
  });

  it("insert 실패는 StorageError", async () => {
    const client = {
      from: () => ({
        insert: () => Promise.resolve({ error: { message: "boom" } }),
      }),
    } as unknown as SupabaseClient;

    await expect(
      logUsage(client, { userId: "u", kind: "extraction", wasCacheHit: true, tokenUsage: null })
    ).rejects.toThrowError(StorageError);
  });
});

describe("countMonthlyAnalyses", () => {
  function makeCountFake(count: number | null): {
    client: SupabaseClient;
    filters: Array<[string, unknown]>;
  } {
    const filters: Array<[string, unknown]> = [];
    const chain = {
      eq(key: string, value: unknown) {
        filters.push([key, value]);
        return chain;
      },
      gte(key: string, value: unknown) {
        filters.push([`gte:${key}`, value]);
        return Promise.resolve({ count, error: null });
      },
    };
    const client = {
      from: () => ({ select: () => chain }),
    } as unknown as SupabaseClient;
    return { client, filters };
  }

  it("이번 달의 match 캐시 미스만 센다", async () => {
    const { client, filters } = makeCountFake(3);
    const used = await countMonthlyAnalyses(
      client,
      "user-1",
      () => new Date("2026-07-11T00:00:00Z")
    );

    expect(used).toBe(3);
    expect(filters).toEqual([
      ["user_id", "user-1"],
      ["kind", "match"],
      ["was_cache_hit", false],
      ["gte:created_at", "2026-07-01T00:00:00.000Z"],
    ]);
  });

  it("count가 null이면 0으로 취급한다", async () => {
    const { client } = makeCountFake(null);
    await expect(countMonthlyAnalyses(client, "user-1")).resolves.toBe(0);
  });
});
