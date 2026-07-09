import type { SupabaseClient } from "@supabase/supabase-js";

import { StorageError } from "./errors";

/**
 * profile_snapshots 타입 + 조회 — AI_ANALYSIS_DESIGN.md 7.2
 *
 * 매칭 분석의 입력은 프로필 원본이 아니라 "분석 시점의 프로필 사본"이다.
 * 스냅샷이 없으면 프로필 수정 후 과거 분석의 근거가 사라지고
 * 점수 변화 추적(72→81)도 불가능하다 (7.3).
 *
 * 스냅샷 생성·재사용(content_hash)은 M2(계정·프로필)에서 프로필 관리와 함께
 * 구현한다. 여기서는 파이프라인(M1-14)이 매칭 입력을 읽는 조회만 둔다.
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
