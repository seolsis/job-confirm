import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { StorageError } from "./errors";
import {
  computeProfileCompleteness,
  ensureProfile,
  getProfileByUserId,
  toProfileSnapshot,
  updateProfile,
  type ProfileRow,
  type ProfileSections,
} from "./profiles";

/**
 * profiles 저장 계층 단위 테스트 — 실제 Supabase는 호출하지 않는다.
 * 완성도 산식(순수 함수), 부분 patch 병합, 스냅샷 직렬화를 검증한다.
 */

const emptySections: ProfileSections = {
  desired_job: null,
  desired_conditions: {},
  educations: [],
  experiences: [],
  skills: [],
  certificates: [],
  languages: [],
  projects: [],
};

const sampleRow: ProfileRow = {
  id: "profile-1",
  user_id: "user-1",
  ...emptySections,
  desired_job: "백엔드 개발자",
  skills: [{ name: "Python", level: null, years: 4 }],
  completeness: 29,
  updated_at: "2026-07-10T00:00:00Z",
};

/** select(eq→maybeSingle) + update(eq→select→single) 체인 fake */
function makeFakeSupabase(options: {
  row?: ProfileRow | null;
  selectError?: { message: string };
  updateError?: { message: string };
}): {
  client: SupabaseClient;
  updates: Array<Record<string, unknown>>;
} {
  const updates: Array<Record<string, unknown>> = [];
  const client = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            options.selectError
              ? { data: null, error: options.selectError }
              : { data: options.row ?? null, error: null },
        }),
      }),
      update(values: Record<string, unknown>) {
        updates.push(values);
        return {
          eq: () => ({
            select: () => ({
              single: async () =>
                options.updateError
                  ? { data: null, error: options.updateError }
                  : { data: { ...options.row, ...values }, error: null },
            }),
          }),
        };
      },
    }),
  } as unknown as SupabaseClient;
  return { client, updates };
}

describe("computeProfileCompleteness (순수 함수)", () => {
  it("빈 프로필은 0", () => {
    expect(computeProfileCompleteness(emptySections)).toBe(0);
  });

  it("7개 항목을 모두 채우면 100", () => {
    const full: ProfileSections = {
      desired_job: "백엔드 개발자",
      desired_conditions: { location: "서울" },
      educations: [{ school: "A대", major: null, degree: null, status: null, period: null }],
      experiences: [{ company: "A사", role: null, period_months: 12, description: null }],
      skills: [{ name: "Python", level: null, years: 1 }],
      certificates: [{ name: "정보처리기사", issuer: null, acquired_at: null }],
      languages: [],
      projects: [{ name: "P", role: null, description: null, tech: [] }],
    };
    expect(computeProfileCompleteness(full)).toBe(100);
  });

  it("자격증과 어학은 하나의 항목으로 합산한다 (둘 중 하나면 충족)", () => {
    const withLanguageOnly: ProfileSections = {
      ...emptySections,
      languages: [{ test: "TOEIC", score: "900", acquired_at: null }],
    };
    const withCertOnly: ProfileSections = {
      ...emptySections,
      certificates: [{ name: "정보처리기사", issuer: null, acquired_at: null }],
    };
    expect(computeProfileCompleteness(withLanguageOnly)).toBe(
      computeProfileCompleteness(withCertOnly)
    );
    expect(computeProfileCompleteness(withLanguageOnly)).toBe(14); // 1/7
  });

  it("공백뿐인 희망 직무는 미충족으로 본다", () => {
    expect(computeProfileCompleteness({ ...emptySections, desired_job: "  " })).toBe(0);
  });
});

describe("getProfileByUserId", () => {
  it("행이 없으면 null, 조회 실패면 StorageError", async () => {
    const { client } = makeFakeSupabase({ row: null });
    await expect(getProfileByUserId(client, "user-1")).resolves.toBeNull();

    const { client: errorClient } = makeFakeSupabase({ selectError: { message: "boom" } });
    await expect(getProfileByUserId(errorClient, "user-1")).rejects.toThrowError(StorageError);
  });
});

describe("updateProfile", () => {
  it("부분 patch를 현재 행과 병합하고 completeness를 다시 계산해 저장한다", async () => {
    const { client, updates } = makeFakeSupabase({ row: sampleRow });
    await updateProfile(client, "user-1", {
      experiences: [{ company: "B사", role: "백엔드", period_months: 24, description: null }],
    });

    expect(updates).toHaveLength(1);
    const payload = updates[0];
    // patch하지 않은 기존 값 유지 + patch 값 반영
    expect(payload.desired_job).toBe("백엔드 개발자");
    expect(payload.skills).toEqual(sampleRow.skills);
    expect((payload.experiences as unknown[]).length).toBe(1);
    // 병합 결과 기준 완성도: 희망직무 + 스킬 + 경력 = 3/7 = 43
    expect(payload.completeness).toBe(43);
  });

  it("프로필 행이 없으면 만들어서(self-heal) 갱신을 이어간다 — 트리거 이전 기존 계정", async () => {
    // 조회는 계속 없음 → ensureProfile이 insert → 그 행 기준으로 update
    let inserted = false;
    const updates: Array<Record<string, unknown>> = [];
    const client = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: null }),
          }),
        }),
        insert(values: Record<string, unknown>) {
          inserted = true;
          return {
            select: () => ({
              single: async () => ({ data: { ...sampleRow, ...values }, error: null }),
            }),
          };
        },
        update(values: Record<string, unknown>) {
          updates.push(values);
          return {
            eq: () => ({
              select: () => ({
                single: async () => ({ data: { ...sampleRow, ...values }, error: null }),
              }),
            }),
          };
        },
      }),
    } as unknown as SupabaseClient;

    await updateProfile(client, "user-1", { desired_job: "백엔드 개발자" });
    expect(inserted).toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0].desired_job).toBe("백엔드 개발자");
  });
});

/** select 결과를 순서대로 소비하는 fake — ensureProfile의 재조회 경로 검증용 */
function makeEnsureFake(options: {
  selectResults: Array<ProfileRow | null>;
  insertError?: { message: string; code?: string };
}): {
  client: SupabaseClient;
  inserts: Array<Record<string, unknown>>;
} {
  const inserts: Array<Record<string, unknown>> = [];
  let selectCall = 0;
  const client = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: options.selectResults[Math.min(selectCall++, options.selectResults.length - 1)],
            error: null,
          }),
        }),
      }),
      insert(values: Record<string, unknown>) {
        inserts.push(values);
        return {
          select: () => ({
            single: async () =>
              options.insertError
                ? { data: null, error: options.insertError }
                : { data: { ...sampleRow, id: "profile-new", ...values }, error: null },
          }),
        };
      },
    }),
  } as unknown as SupabaseClient;
  return { client, inserts };
}

describe("ensureProfile (self-heal — 트리거 이전 기존 계정 대응)", () => {
  it("행이 있으면 그대로 반환한다 (insert 없음)", async () => {
    const { client, inserts } = makeEnsureFake({ selectResults: [sampleRow] });
    const row = await ensureProfile(client, "user-1");

    expect(row.id).toBe("profile-1");
    expect(inserts).toHaveLength(0);
  });

  it("행이 없으면 빈 행을 만든다 (user_id만 — 나머지는 DB 기본값)", async () => {
    const { client, inserts } = makeEnsureFake({ selectResults: [null] });
    const row = await ensureProfile(client, "user-1");

    expect(row.id).toBe("profile-new");
    expect(inserts).toEqual([{ user_id: "user-1" }]);
  });

  it("동시 생성 경합(insert 실패)이면 다시 읽어서 반환한다", async () => {
    const { client } = makeEnsureFake({
      selectResults: [null, sampleRow], // 첫 조회 없음 → insert 충돌 → 재조회 성공
      insertError: { message: "duplicate key", code: "23505" },
    });
    const row = await ensureProfile(client, "user-1");

    expect(row.id).toBe("profile-1");
  });

  it("insert 실패 + 재조회도 없으면 StorageError", async () => {
    const { client } = makeEnsureFake({
      selectResults: [null, null],
      insertError: { message: "boom" },
    });
    await expect(ensureProfile(client, "user-1")).rejects.toThrowError(StorageError);
  });
});

describe("toProfileSnapshot (순수 함수)", () => {
  it("메타 필드(id·completeness 등)를 제외한 섹션만 직렬화한다", () => {
    const snapshot = toProfileSnapshot(sampleRow);

    expect(snapshot).toEqual({
      desired_job: "백엔드 개발자",
      desired_conditions: {},
      educations: [],
      experiences: [],
      skills: [{ name: "Python", level: null, years: 4 }],
      certificates: [],
      languages: [],
      projects: [],
    });
    expect(Object.keys(snapshot)).not.toContain("id");
    expect(Object.keys(snapshot)).not.toContain("completeness");
    expect(Object.keys(snapshot)).not.toContain("user_id");
  });
});
