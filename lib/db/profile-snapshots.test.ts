import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { StorageError } from "./errors";
import {
  getOrCreateProfileSnapshot,
  snapshotContentHash,
  type ProfileSnapshot,
  type ProfileSnapshotRow,
} from "./profile-snapshots";

/**
 * profile_snapshots 생성·재사용(M2-2) 단위 테스트 — 실제 Supabase는 호출하지 않는다.
 * content_hash 결정성(순수 함수)과 재사용/생성 분기를 검증한다.
 */

const sampleSnapshot: ProfileSnapshot = {
  desired_job: "백엔드 개발자",
  desired_conditions: { location: "서울" },
  educations: [],
  experiences: [{ company: "A사", role: "백엔드", period_months: 48, description: "Python" }],
  skills: [{ name: "Python", level: null, years: 4 }],
  certificates: [],
  languages: [],
  projects: [],
};

/** select(eq→eq→order→limit→maybeSingle) + insert(select→single) 체인 fake */
function makeFakeSupabase(options: {
  existing?: ProfileSnapshotRow | null;
  selectError?: { message: string };
  insertError?: { message: string };
}): {
  client: SupabaseClient;
  inserts: Array<Record<string, unknown>>;
} {
  const inserts: Array<Record<string, unknown>> = [];
  const client = {
    from: () => ({
      select: () => {
        const chain = {
          eq: () => chain,
          order: () => chain,
          limit: () => chain,
          maybeSingle: async () =>
            options.selectError
              ? { data: null, error: options.selectError }
              : { data: options.existing ?? null, error: null },
        };
        return chain;
      },
      insert(values: Record<string, unknown>) {
        inserts.push(values);
        return {
          select: () => ({
            single: async () =>
              options.insertError
                ? { data: null, error: options.insertError }
                : {
                    data: { id: "snapshot-new", created_at: "2026-07-10T00:00:00Z", ...values },
                    error: null,
                  },
          }),
        };
      },
    }),
  } as unknown as SupabaseClient;
  return { client, inserts };
}

describe("snapshotContentHash (순수 함수)", () => {
  it("같은 내용이면 키 순서가 달라도 같은 해시", () => {
    const reordered = {
      projects: sampleSnapshot.projects,
      skills: sampleSnapshot.skills,
      desired_conditions: { location: "서울" },
      desired_job: sampleSnapshot.desired_job,
      languages: sampleSnapshot.languages,
      certificates: sampleSnapshot.certificates,
      experiences: sampleSnapshot.experiences,
      educations: sampleSnapshot.educations,
    } as ProfileSnapshot;

    expect(snapshotContentHash(reordered)).toBe(snapshotContentHash(sampleSnapshot));
    expect(snapshotContentHash(sampleSnapshot)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("내용이 바뀌면 해시가 바뀐다 (중첩 값·배열 순서 포함)", () => {
    const base = snapshotContentHash(sampleSnapshot);

    expect(snapshotContentHash({ ...sampleSnapshot, desired_job: "프론트엔드" })).not.toBe(base);
    expect(
      snapshotContentHash({
        ...sampleSnapshot,
        skills: [{ name: "Python", level: null, years: 5 }], // 중첩 값 변경
      })
    ).not.toBe(base);
  });
});

describe("getOrCreateProfileSnapshot", () => {
  it("같은 content_hash가 있으면 재사용한다 (insert 없음 — 행 폭증 방지)", async () => {
    const existing = {
      id: "snapshot-old",
      user_id: "user-1",
      snapshot: sampleSnapshot,
      content_hash: snapshotContentHash(sampleSnapshot),
      created_at: "2026-07-01T00:00:00Z",
    };
    const { client, inserts } = makeFakeSupabase({ existing });

    const result = await getOrCreateProfileSnapshot(client, "user-1", sampleSnapshot);

    expect(result.reused).toBe(true);
    expect(result.row.id).toBe("snapshot-old");
    expect(inserts).toHaveLength(0);
  });

  it("없으면 새 행을 만든다 — user_id·snapshot·content_hash 페이로드", async () => {
    const { client, inserts } = makeFakeSupabase({ existing: null });

    const result = await getOrCreateProfileSnapshot(client, "user-1", sampleSnapshot);

    expect(result.reused).toBe(false);
    expect(result.row.id).toBe("snapshot-new");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toEqual({
      user_id: "user-1",
      snapshot: sampleSnapshot,
      content_hash: snapshotContentHash(sampleSnapshot),
    });
  });

  it("조회·생성 실패는 StorageError로 정규화한다", async () => {
    const { client: selectFail } = makeFakeSupabase({ selectError: { message: "boom" } });
    await expect(
      getOrCreateProfileSnapshot(selectFail, "user-1", sampleSnapshot)
    ).rejects.toThrowError(StorageError);

    const { client: insertFail } = makeFakeSupabase({ insertError: { message: "boom" } });
    await expect(
      getOrCreateProfileSnapshot(insertFail, "user-1", sampleSnapshot)
    ).rejects.toThrowError(StorageError);
  });
});
