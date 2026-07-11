import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import {
  APPLICATION_STATUSES,
  createApplication,
  daysUntil,
  findSimilarApplication,
  listApplicationCards,
  nextUpcomingSchedule,
  updateApplicationMemo,
  updateApplicationSchedule,
  updateApplicationStatus,
  type ApplicationRow,
} from "./applications";
import { StorageError } from "./errors";

/**
 * applications 저장 계층(M3-1) 단위 테스트 — 실제 Supabase는 호출하지 않는다.
 * D-day 순수 함수, 카드 생성(중복 처리), 상태·메모 변경 페이로드, 보드 조인을 검증한다.
 */

const sampleApp: ApplicationRow = {
  id: "app-1",
  user_id: "user-1",
  posting_id: "posting-1",
  latest_analysis_id: "analysis-1",
  status: "interested",
  rejected_at_stage: null,
  memo: null,
  schedule: [],
  created_at: "2026-07-11T00:00:00Z",
  updated_at: "2026-07-11T00:00:00Z",
};

describe("daysUntil (순수 함수 — D-day)", () => {
  const now = () => new Date(2026, 6, 11); // 2026-07-11 (로컬)

  it("오늘 마감 = 0, 미래는 양수, 지난 마감은 음수", () => {
    expect(daysUntil("2026-07-11", now)).toBe(0);
    expect(daysUntil("2026-07-14", now)).toBe(3);
    expect(daysUntil("2026-07-01", now)).toBe(-10);
  });

  it("마감일 없음·형식 오류는 null", () => {
    expect(daysUntil(null, now)).toBeNull();
    expect(daysUntil("2026/07/11", now)).toBeNull();
    expect(daysUntil("상시채용", now)).toBeNull();
  });
});

describe("APPLICATION_STATUSES", () => {
  it("칸반 6단계를 PRD 순서대로 갖는다", () => {
    expect(APPLICATION_STATUSES).toEqual([
      "interested",
      "applied",
      "doc_passed",
      "interview",
      "accepted",
      "rejected",
    ]);
  });
});

/** insert/update 체인 fake — 23505 충돌 시나리오 지원 */
function makeWriteFake(options: {
  insertError?: { message: string; code?: string };
  updateRow?: Partial<ApplicationRow>;
}): {
  client: SupabaseClient;
  inserts: Array<Record<string, unknown>>;
  updates: Array<{ values: Record<string, unknown>; filters: Array<[string, unknown]> }>;
} {
  const inserts: Array<Record<string, unknown>> = [];
  const updates: Array<{ values: Record<string, unknown>; filters: Array<[string, unknown]> }> = [];
  const client = {
    from: () => ({
      insert(values: Record<string, unknown>) {
        inserts.push(values);
        return {
          select: () => ({
            single: async () =>
              options.insertError
                ? { data: null, error: options.insertError }
                : { data: { ...sampleApp, ...values }, error: null },
          }),
        };
      },
      update(values: Record<string, unknown>) {
        const filters: Array<[string, unknown]> = [];
        updates.push({ values, filters });
        const chain = {
          eq(key: string, value: unknown) {
            filters.push([key, value]);
            return chain;
          },
          select: () => ({
            single: async () => ({
              data: { ...sampleApp, ...options.updateRow, ...values },
              error: null,
            }),
          }),
        };
        return chain;
      },
    }),
  } as unknown as SupabaseClient;
  return { client, inserts, updates };
}

describe("createApplication (service-role 전용)", () => {
  it("user/posting/analysis를 실어 insert한다 — 기본 상태는 DB 기본값 interested", async () => {
    const { client, inserts } = makeWriteFake({});
    const { row, alreadySaved } = await createApplication(client, {
      userId: "user-1",
      postingId: "posting-1",
      analysisId: "analysis-1",
    });

    expect(alreadySaved).toBe(false);
    expect(row.id).toBe("app-1");
    expect(inserts[0]).toEqual({
      user_id: "user-1",
      posting_id: "posting-1",
      latest_analysis_id: "analysis-1",
    });
  });

  it("unique 충돌(23505)이면 기존 카드에 최신 분석만 연결한다 (중복 카드 방지)", async () => {
    const { client, updates } = makeWriteFake({
      insertError: { message: "duplicate key", code: "23505" },
    });
    const { alreadySaved } = await createApplication(client, {
      userId: "user-1",
      postingId: "posting-1",
      analysisId: "analysis-2",
    });

    expect(alreadySaved).toBe(true);
    expect(updates[0].values).toEqual({ latest_analysis_id: "analysis-2" });
    expect(updates[0].filters).toEqual([
      ["user_id", "user-1"],
      ["posting_id", "posting-1"],
    ]);
  });

  it("그 외 insert 실패는 StorageError", async () => {
    const { client } = makeWriteFake({ insertError: { message: "boom" } });
    await expect(
      createApplication(client, { userId: "u", postingId: "p", analysisId: "a" })
    ).rejects.toThrowError(StorageError);
  });
});

describe("updateApplicationStatus", () => {
  it("rejected로 이동하면 탈락 단계를 기록한다", async () => {
    const { client, updates } = makeWriteFake({});
    await updateApplicationStatus(client, "app-1", "rejected", { rejectedAtStage: "서류" });

    expect(updates[0].values).toEqual({ status: "rejected", rejected_at_stage: "서류" });
  });

  it("rejected가 아닌 상태로 이동하면 탈락 단계를 비운다", async () => {
    const { client, updates } = makeWriteFake({});
    await updateApplicationStatus(client, "app-1", "applied", { rejectedAtStage: "서류" });

    expect(updates[0].values).toEqual({ status: "applied", rejected_at_stage: null });
  });
});

describe("updateApplicationMemo", () => {
  it("빈 문자열은 null로 저장한다", async () => {
    const { client, updates } = makeWriteFake({});
    await updateApplicationMemo(client, "app-1", "   ");
    expect(updates[0].values).toEqual({ memo: null });

    await updateApplicationMemo(client, "app-1", "면접 후기 메모");
    expect(updates[1].values).toEqual({ memo: "면접 후기 메모" });
  });
});

describe("listApplicationCards (배치 조인)", () => {
  it("applications + postings + extractions + analyses를 카드로 합성한다", async () => {
    const tables: Record<string, unknown[]> = {
      jobConfirm_applications: [sampleApp],
      jobConfirm_job_postings: [
        { id: "posting-1", url: "https://example.com/job", latest_extraction_id: "ext-1" },
      ],
      jobConfirm_posting_extractions: [
        {
          id: "ext-1",
          company_name: "테스트컴퍼니",
          job_title: "백엔드",
          deadline_date: "2026-08-01",
        },
      ],
      jobConfirm_match_analyses: [{ id: "analysis-1", score: 72, grade: "challenge" }],
    };
    const client = {
      from(table: string) {
        const rows = tables[table] ?? [];
        const chain = {
          select: () => chain,
          order: () => chain,
          in: () => chain,
          eq: () => chain,
          maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
          then(resolve: (r: { data: unknown[]; error: null }) => void) {
            resolve({ data: rows, error: null });
          },
        };
        return chain;
      },
    } as unknown as SupabaseClient;

    const cards = await listApplicationCards(client);

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      company_name: "테스트컴퍼니",
      job_title: "백엔드",
      deadline_date: "2026-08-01",
      url: "https://example.com/job",
      score: 72,
      grade: "challenge",
    });
    expect(cards[0].application.id).toBe("app-1");
  });

  it("카드가 없으면 빈 배열 (추가 조회 없음)", async () => {
    const client = {
      from: () => {
        const chain = {
          select: () => chain,
          order: () => chain,
          then(resolve: (r: { data: unknown[]; error: null }) => void) {
            resolve({ data: [], error: null });
          },
        };
        return chain;
      },
    } as unknown as SupabaseClient;

    await expect(listApplicationCards(client)).resolves.toEqual([]);
  });
});

describe("nextUpcomingSchedule (순수 함수 — 보드 일정 칩)", () => {
  const now = () => new Date(2026, 6, 11); // 2026-07-11

  it("오늘 포함 미래 일정 중 가장 가까운 것을 고른다", () => {
    const schedule = [
      { type: "interview", at: "2026-07-25" },
      { type: "test", at: "2026-07-15" },
      { type: "deadline", at: "2026-07-01" }, // 지남 — 제외
    ];
    expect(nextUpcomingSchedule(schedule, now)).toEqual({ type: "test", at: "2026-07-15" });
    expect(nextUpcomingSchedule([{ type: "other", at: "2026-07-11" }], now)).toEqual({
      type: "other",
      at: "2026-07-11",
    });
  });

  it("다가오는 일정이 없으면 null", () => {
    expect(nextUpcomingSchedule([], now)).toBeNull();
    expect(nextUpcomingSchedule([{ type: "interview", at: "2026-07-01" }], now)).toBeNull();
  });
});

describe("updateApplicationSchedule", () => {
  it("schedule 배열 전체를 교체한다", async () => {
    const { client, updates } = makeWriteFake({});
    const schedule = [{ type: "interview", at: "2026-07-25", note: "2차" }];
    await updateApplicationSchedule(client, "app-1", schedule);

    expect(updates[0].values).toEqual({ schedule });
    expect(updates[0].filters).toEqual([["id", "app-1"]]);
  });
});

describe("findSimilarApplication (유사 공고 감지)", () => {
  function makeSimilarFake(options: {
    extractionRows: Array<{ posting_id: string }>;
    applicationRow: ApplicationRow | null;
  }): { client: SupabaseClient; queries: Array<{ table: string; filters: unknown[] }> } {
    const queries: Array<{ table: string; filters: unknown[] }> = [];
    const client = {
      from(table: string) {
        const record = { table, filters: [] as unknown[] };
        queries.push(record);
        const rows =
          table === "jobConfirm_posting_extractions"
            ? options.extractionRows
            : options.applicationRow !== null
              ? [options.applicationRow]
              : [];
        const chain = {
          select: () => chain,
          eq(key: string, value: unknown) {
            record.filters.push(["eq", key, value]);
            return chain;
          },
          neq(key: string, value: unknown) {
            record.filters.push(["neq", key, value]);
            return chain;
          },
          in(key: string, value: unknown) {
            record.filters.push(["in", key, value]);
            return chain;
          },
          limit: () => chain,
          maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
          then(resolve: (r: { data: unknown[]; error: null }) => void) {
            resolve({ data: rows, error: null });
          },
        };
        return chain;
      },
    } as unknown as SupabaseClient;
    return { client, queries };
  }

  it("같은 회사·직무의 내 카드를 찾는다 (저장하려는 공고 자신은 제외)", async () => {
    const { client, queries } = makeSimilarFake({
      extractionRows: [{ posting_id: "posting-other" }],
      applicationRow: sampleApp,
    });
    const found = await findSimilarApplication(client, {
      userId: "user-1",
      companyName: "토끼전자",
      jobTitle: "프론트엔드 개발자",
      excludePostingId: "posting-new",
    });

    expect(found?.id).toBe("app-1");
    expect(queries[0].filters).toEqual([
      ["eq", "company_name", "토끼전자"],
      ["eq", "job_title", "프론트엔드 개발자"],
      ["neq", "posting_id", "posting-new"],
    ]);
    expect(queries[1].filters).toEqual([
      ["eq", "user_id", "user-1"],
      ["in", "posting_id", ["posting-other"]],
    ]);
  });

  it("회사·직무가 없거나(추출 실패) 일치 공고가 없으면 null", async () => {
    const { client } = makeSimilarFake({ extractionRows: [], applicationRow: null });
    await expect(
      findSimilarApplication(client, {
        userId: "user-1",
        companyName: null,
        jobTitle: "직무",
        excludePostingId: "p",
      })
    ).resolves.toBeNull();
    await expect(
      findSimilarApplication(client, {
        userId: "user-1",
        companyName: "회사",
        jobTitle: "직무",
        excludePostingId: "p",
      })
    ).resolves.toBeNull();
  });
});
