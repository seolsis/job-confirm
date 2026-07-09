import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import type { ExtractionResult } from "@/lib/ai/extract";
import type { PostingExtraction } from "@/lib/ai/schemas";

import { StorageError } from "./errors";
import {
  deriveExcerptColumns,
  normalizeDeadlineDate,
  savePostingExtraction,
} from "./posting-extractions";

/**
 * posting_extractions 저장 계층 단위 테스트 — 실제 Supabase는 호출하지 않는다.
 * 쿼리 빌더 체인(insert→select→single, update→eq)을 fake로 대체해
 * insert 페이로드(버전·발췌 컬럼)와 latest 포인터 갱신·실패 처리를 검증한다.
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
  salary: { min: null, max: null, is_negotiable: null, raw_text: "회사 내규에 따름" },
  deadline: { date: "2026-08-31", is_rolling: false, raw_text: "마감: 2026-08-31" },
  keywords: ["백엔드", "Python"],
  extraction_notes: null,
};

const sampleResult: ExtractionResult = {
  extracted: sampleExtraction,
  modelId: "claude-opus-4-8",
  promptVersion: "extract-v1",
  schemaVersion: "extract-schema-v1",
  tokenUsage: { input: 1200, output: 800, cache_read: 1000, cache_creation: 50 },
};

interface FakeSupabase {
  client: SupabaseClient;
  inserts: Array<{ table: string; values: Record<string, unknown> }>;
  updates: Array<{
    table: string;
    values: Record<string, unknown>;
    column: string;
    value: unknown;
  }>;
}

/** insert/update 체인만 흉내 내는 최소 fake — 오류 주입 가능 */
function makeFakeSupabase(
  options: {
    insertError?: { message: string };
    updateError?: { message: string };
  } = {}
): FakeSupabase {
  const inserts: FakeSupabase["inserts"] = [];
  const updates: FakeSupabase["updates"] = [];

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
                      data: { id: "ext-1", created_at: "2026-07-09T00:00:00Z", ...values },
                      error: null,
                    },
            }),
          };
        },
        update(values: Record<string, unknown>) {
          return {
            eq: async (column: string, value: unknown) => {
              updates.push({ table, values, column, value });
              return { error: options.updateError ?? null };
            },
          };
        },
      };
    },
  };

  return { client: client as unknown as SupabaseClient, inserts, updates };
}

describe("normalizeDeadlineDate (순수 함수 — 3.2 서버 형식 검증)", () => {
  it("유효한 YYYY-MM-DD는 그대로 통과한다", () => {
    expect(normalizeDeadlineDate("2026-08-31")).toBe("2026-08-31");
  });

  it("null이면 null", () => {
    expect(normalizeDeadlineDate(null)).toBeNull();
  });

  it("형식이 다르면 null (원문은 raw_text에 보존되므로 손실 없음)", () => {
    expect(normalizeDeadlineDate("26-08-31")).toBeNull();
    expect(normalizeDeadlineDate("2026/08/31")).toBeNull();
    expect(normalizeDeadlineDate("채용 시 마감")).toBeNull();
  });

  it("실존하지 않는 날짜는 null (Date의 자동 이월을 걸러낸다)", () => {
    expect(normalizeDeadlineDate("2026-02-31")).toBeNull();
    expect(normalizeDeadlineDate("2026-13-01")).toBeNull();
  });
});

describe("deriveExcerptColumns (순수 함수)", () => {
  it("extracted에서 발췌 컬럼 3종을 복제한다", () => {
    expect(deriveExcerptColumns(sampleExtraction)).toEqual({
      company_name: "테스트컴퍼니",
      job_title: "백엔드 개발자",
      deadline_date: "2026-08-31",
    });
  });

  it("없는 값은 null 그대로 둔다 (설계 원칙 4)", () => {
    const noInfo: PostingExtraction = {
      ...sampleExtraction,
      company_name: null,
      job_title: null,
      deadline: { date: null, is_rolling: true, raw_text: "상시 채용" },
    };
    expect(deriveExcerptColumns(noInfo)).toEqual({
      company_name: null,
      job_title: null,
      deadline_date: null,
    });
  });
});

describe("savePostingExtraction", () => {
  it("행을 저장하고 버전·발췌 컬럼·token_usage를 페이로드에 싣는다", async () => {
    const { client, inserts } = makeFakeSupabase();
    const row = await savePostingExtraction(client, "posting-1", sampleResult);

    expect(row.id).toBe("ext-1");
    expect(inserts).toHaveLength(1);
    expect(inserts[0].table).toBe("jobConfirm_posting_extractions");
    expect(inserts[0].values).toMatchObject({
      posting_id: "posting-1",
      extracted: sampleExtraction,
      company_name: "테스트컴퍼니",
      job_title: "백엔드 개발자",
      deadline_date: "2026-08-31",
      model_id: "claude-opus-4-8",
      prompt_version: "extract-v1",
      schema_version: "extract-schema-v1",
      token_usage: { input: 1200, output: 800, cache_read: 1000, cache_creation: 50 },
    });
  });

  it("저장 후 job_postings.latest_extraction_id를 새 행으로 갱신한다 (7.2)", async () => {
    const { client, updates } = makeFakeSupabase();
    await savePostingExtraction(client, "posting-1", sampleResult);

    expect(updates).toEqual([
      {
        table: "jobConfirm_job_postings",
        values: { latest_extraction_id: "ext-1" },
        column: "id",
        value: "posting-1",
      },
    ]);
  });

  it("insert 실패 시 StorageError를 던진다", async () => {
    const { client, updates } = makeFakeSupabase({ insertError: { message: "boom" } });
    await expect(savePostingExtraction(client, "posting-1", sampleResult)).rejects.toThrowError(
      StorageError
    );
    expect(updates).toHaveLength(0); // 포인터는 건드리지 않는다
  });

  it("포인터 갱신 실패도 StorageError — 이전 버전을 가리키는 상태를 성공으로 치지 않는다", async () => {
    const { client } = makeFakeSupabase({ updateError: { message: "boom" } });
    await expect(savePostingExtraction(client, "posting-1", sampleResult)).rejects.toThrowError(
      StorageError
    );
  });
});
