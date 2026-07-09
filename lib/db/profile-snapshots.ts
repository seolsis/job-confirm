import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { StorageError } from "./errors";

/**
 * profile_snapshots 타입 + 조회 + 생성·재사용 — AI_ANALYSIS_DESIGN.md 7.2
 *
 * 매칭 분석의 입력은 프로필 원본이 아니라 "분석 시점의 프로필 사본"이다.
 * 스냅샷이 없으면 프로필 수정 후 과거 분석의 근거가 사라지고
 * 점수 변화 추적(72→81)도 불가능하다 (7.3).
 *
 * 생성·재사용(M2-2): 프로필 내용의 content_hash가 같으면 기존 스냅샷을
 * 재사용한다 (행 폭증 방지 — 7.2). 프로필 직렬화(toProfileSnapshot)는
 * profiles.ts에 있다 (순환 import 방지를 위해 여기서는 스냅샷만 받는다).
 *
 * node:crypto를 쓰므로 생성 함수는 서버 전용이다 (Route Handler·Server Component).
 */

/** profiles.educations jsonb 항목 */
export interface ProfileEducation {
  school: string;
  major: string | null;
  degree: string | null;
  status: string | null; // 재학/휴학/졸업 등
  period: string | null;
}

/** profiles.experiences jsonb 항목 */
export interface ProfileExperience {
  company: string;
  role: string | null;
  period_months: number | null;
  description: string | null;
}

/** profiles.skills jsonb 항목 — name은 정규화된 기술명 (extraction의 required_skills와 동일 규칙) */
export interface ProfileSkill {
  name: string;
  level: string | null;
  years: number | null;
}

/** profiles.certificates jsonb 항목 */
export interface ProfileCertificate {
  name: string;
  issuer: string | null;
  acquired_at: string | null;
}

/** profiles.languages jsonb 항목 */
export interface ProfileLanguage {
  test: string;
  score: string | null;
  acquired_at: string | null;
}

/** profiles.projects jsonb 항목 */
export interface ProfileProject {
  name: string;
  role: string | null;
  description: string | null;
  tech: string[];
}

/**
 * 프로필 전체 직렬화 (profile_snapshots.snapshot jsonb) — 매칭 분석의 입력.
 * profiles 테이블의 jsonb 섹션들과 1:1 대응한다.
 */
export interface ProfileSnapshot {
  desired_job: string | null;
  desired_conditions: Record<string, unknown>;
  educations: ProfileEducation[];
  experiences: ProfileExperience[];
  skills: ProfileSkill[];
  certificates: ProfileCertificate[];
  languages: ProfileLanguage[];
  projects: ProfileProject[];
}

/** jobConfirm_profile_snapshots 행 (불변, append-only) */
export interface ProfileSnapshotRow {
  id: string;
  user_id: string;
  snapshot: ProfileSnapshot;
  /** 프로필이 안 바뀌었으면 기존 스냅샷 재사용 (행 폭증 방지) */
  content_hash: string;
  created_at: string;
}

const SNAPSHOTS_TABLE = "jobConfirm_profile_snapshots";

/** 정렬 키 순서로 정규화 — 키 순서만 다른 동일 내용이 같은 해시를 갖게 한다 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, canonicalize(child)])
    );
  }
  return value;
}

/**
 * 스냅샷 내용 해시 (profile_snapshots.content_hash) — 순수 함수.
 * 프로필이 안 바뀌었으면 기존 스냅샷을 재사용하는 판정 키 (7.2).
 */
export function snapshotContentHash(snapshot: ProfileSnapshot): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(snapshot)), "utf8")
    .digest("hex");
}

export interface SnapshotResult {
  row: ProfileSnapshotRow;
  /** true면 기존 스냅샷 재사용 (insert 없음) */
  reused: boolean;
}

/**
 * 스냅샷 생성 또는 재사용 — 같은 사용자의 같은 content_hash가 있으면 그 행을,
 * 없으면 새 행을 만든다. RLS가 본인 insert를 허용하므로 세션 클라이언트로 호출 가능.
 * (호출부: 분석 요청 시 프로필을 직렬화해 넘긴다 — M2-4에서 라우트에 연결)
 */
export async function getOrCreateProfileSnapshot(
  supabase: SupabaseClient,
  userId: string,
  snapshot: ProfileSnapshot
): Promise<SnapshotResult> {
  const contentHash = snapshotContentHash(snapshot);

  const { data: existing, error: selectError } = await supabase
    .from(SNAPSHOTS_TABLE)
    .select("*")
    .eq("user_id", userId)
    .eq("content_hash", contentHash)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (selectError) {
    throw new StorageError(`스냅샷 조회 실패 (user: ${userId}): ${selectError.message}`, {
      cause: selectError,
    });
  }
  if (existing !== null) {
    return { row: existing as ProfileSnapshotRow, reused: true };
  }

  const { data, error } = await supabase
    .from(SNAPSHOTS_TABLE)
    .insert({ user_id: userId, snapshot, content_hash: contentHash })
    .select()
    .single();

  if (error) {
    throw new StorageError(`스냅샷 생성 실패 (user: ${userId}): ${error.message}`, {
      cause: error,
    });
  }
  return { row: data as ProfileSnapshotRow, reused: false };
}

/** 스냅샷 1건 조회 — 소유권 확인(user_id 대조)은 호출부(파이프라인)의 몫 */
export async function getProfileSnapshotById(
  supabase: SupabaseClient,
  snapshotId: string
): Promise<ProfileSnapshotRow | null> {
  const { data, error } = await supabase
    .from(SNAPSHOTS_TABLE)
    .select("*")
    .eq("id", snapshotId)
    .maybeSingle();

  if (error) {
    throw new StorageError(`프로필 스냅샷 조회 실패 (snapshot: ${snapshotId}): ${error.message}`, {
      cause: error,
    });
  }
  return (data as ProfileSnapshotRow | null) ?? null;
}
