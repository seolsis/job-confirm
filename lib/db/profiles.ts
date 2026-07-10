import type { SupabaseClient } from "@supabase/supabase-js";

import { StorageError } from "./errors";
import type {
  ProfileCertificate,
  ProfileEducation,
  ProfileExperience,
  ProfileLanguage,
  ProfileProject,
  ProfileSkill,
  ProfileSnapshot,
} from "./profile-snapshots";

/**
 * profiles 저장 계층 (M2-2) — AI_ANALYSIS_DESIGN.md 7.2
 *
 * 현재 프로필은 사용자당 1행이며 가입 트리거가 빈 행을 만든다 (마이그레이션 4.1).
 * RLS가 본인 select/insert/update를 허용하므로 세션 클라이언트로 직접 다룬다
 * (browser·server 모두 가능 — service-role 불필요).
 *
 * 분석 입력은 이 테이블이 아니라 "분석 시점의 사본"(profile_snapshots)이다 —
 * 직렬화(toProfileSnapshot)와 스냅샷 생성·재사용은 profile-snapshots.ts 참고.
 */

const PROFILES_TABLE = "jobConfirm_profiles";

/** 사용자가 편집하는 프로필 섹션 전체 (완성도 계산·스냅샷 직렬화의 대상) */
export interface ProfileSections {
  desired_job: string | null;
  desired_conditions: Record<string, unknown>;
  educations: ProfileEducation[];
  experiences: ProfileExperience[];
  skills: ProfileSkill[];
  certificates: ProfileCertificate[];
  languages: ProfileLanguage[];
  projects: ProfileProject[];
}

/** jobConfirm_profiles 행 */
export interface ProfileRow extends ProfileSections {
  id: string;
  user_id: string;
  /** 프로필 완성도 % — 서버 계산 (computeProfileCompleteness), UI 게이지용 */
  completeness: number;
  updated_at: string;
}

export async function getProfileByUserId(
  supabase: SupabaseClient,
  userId: string
): Promise<ProfileRow | null> {
  const { data, error } = await supabase
    .from(PROFILES_TABLE)
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw new StorageError(`프로필 조회 실패 (user: ${userId}): ${error.message}`, {
      cause: error,
    });
  }
  return (data as ProfileRow | null) ?? null;
}

/**
 * 프로필 행 확보 — 없으면 빈 행을 만든다 (self-heal).
 *
 * 가입 트리거가 행을 만들지만, 트리거 생성(2026-07-09) 이전에 만들어진
 * 공유 프로젝트의 기존 계정에는 행이 없다 (실측: 2026-06-16 가입 계정).
 * RLS insert 정책(본인만)이 있어 세션 클라이언트로 만들 수 있다.
 * 동시 요청으로 unique(user_id) 충돌이 나면 기존 행을 다시 읽는다.
 */
export async function ensureProfile(supabase: SupabaseClient, userId: string): Promise<ProfileRow> {
  const existing = await getProfileByUserId(supabase, userId);
  if (existing !== null) return existing;

  const { data, error } = await supabase
    .from(PROFILES_TABLE)
    .insert({ user_id: userId })
    .select()
    .single();

  if (error) {
    // 동시 생성 경합(23505 unique_violation) — 이미 만들어졌으니 다시 읽는다
    const raced = await getProfileByUserId(supabase, userId);
    if (raced !== null) return raced;
    throw new StorageError(`프로필 생성 실패 (user: ${userId}): ${error.message}`, {
      cause: error,
    });
  }
  return data as ProfileRow;
}

/**
 * 프로필 완성도 % (순수 함수) — S9의 완성도 게이지와 온보딩 보완 유도의 원천.
 * 7개 항목(희망 직무 / 희망 조건 / 학력 / 경력 / 스킬 / 자격증·어학 / 프로젝트)의
 * 채움 비율. 완성도가 분석 정확도와 직결됨을 UI에 명시한다 (PRD 3.2 S9).
 */
export function computeProfileCompleteness(sections: ProfileSections): number {
  const checks = [
    sections.desired_job !== null && sections.desired_job.trim() !== "",
    Object.keys(sections.desired_conditions).length > 0,
    sections.educations.length > 0,
    sections.experiences.length > 0,
    sections.skills.length > 0,
    sections.certificates.length > 0 || sections.languages.length > 0,
    sections.projects.length > 0,
  ];
  const filled = checks.filter(Boolean).length;
  return Math.round((100 * filled) / checks.length);
}

/**
 * 프로필 섹션 갱신 — 부분 patch를 현재 행과 병합해 저장하고,
 * completeness를 병합 결과 기준으로 서버 계산해 함께 기록한다.
 * updated_at은 DB 트리거("jobConfirm_profiles_set_updated_at")가 갱신한다.
 */
export async function updateProfile(
  supabase: SupabaseClient,
  userId: string,
  patch: Partial<ProfileSections>
): Promise<ProfileRow> {
  // 행이 없으면 만들고 진행한다 — 트리거 이전의 기존 계정도 온보딩 저장이 가능해야 한다
  const current = await ensureProfile(supabase, userId);

  const merged: ProfileSections = {
    desired_job: current.desired_job,
    desired_conditions: current.desired_conditions,
    educations: current.educations,
    experiences: current.experiences,
    skills: current.skills,
    certificates: current.certificates,
    languages: current.languages,
    projects: current.projects,
    ...patch,
  };

  const { data, error } = await supabase
    .from(PROFILES_TABLE)
    .update({ ...merged, completeness: computeProfileCompleteness(merged) })
    .eq("user_id", userId)
    .select()
    .single();

  if (error) {
    throw new StorageError(`프로필 갱신 실패 (user: ${userId}): ${error.message}`, {
      cause: error,
    });
  }
  return data as ProfileRow;
}

/**
 * 프로필 행 → 분석 입력용 스냅샷 직렬화 (순수 함수).
 * id·완성도 등 메타 필드는 제외한다 — 스냅샷은 "매칭 판단에 쓰는 내용"만 담아야
 * content_hash 재사용(같은 내용이면 같은 스냅샷)이 의미를 가진다.
 */
export function toProfileSnapshot(profile: ProfileSections): ProfileSnapshot {
  return {
    desired_job: profile.desired_job,
    desired_conditions: profile.desired_conditions,
    educations: profile.educations,
    experiences: profile.experiences,
    skills: profile.skills,
    certificates: profile.certificates,
    languages: profile.languages,
    projects: profile.projects,
  };
}
