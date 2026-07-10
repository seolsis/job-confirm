"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";

import { getProfileByUserId, updateProfile } from "@/lib/db/profiles";
import type { ProfileEducation, ProfileExperience, ProfileSkill } from "@/lib/db/profile-snapshots";
import { createBrowserSupabaseClient } from "@/lib/supabase/browser";

/**
 * S3 — 프로필 온보딩 (M2-3, PRD 2.1·3.2). 최소형 단일 페이지.
 *
 * 온보딩 원칙(PRD 2.1): 희망 직무만 필수 — 최소 입력으로 첫 분석을 허용하고
 * 결과 화면에서 보완을 유도한다(Progressive Profiling). 학력·경력·스킬은 선택.
 * 저장은 lib/db/profiles.updateProfile — completeness는 서버 산식으로 함께 기록된다.
 *
 * 미인증 접근은 proxy 가드가 /login?next=/profile/onboarding 으로 보낸다.
 */

/** 폼 입력용 행 (문자열 상태) — 저장 시 jsonb 스키마로 변환한다 */
interface SkillInput {
  name: string;
  years: string;
}
interface ExperienceInput {
  company: string;
  role: string;
  months: string;
  description: string;
}
interface EducationInput {
  school: string;
  major: string;
  status: string;
}

const inputClass =
  "mt-1.5 w-full rounded-2xl border-2 border-amber-100 bg-white px-4 py-2.5 text-sm text-stone-700 outline-none transition-colors placeholder:text-stone-300 focus:border-amber-300";

export default function OnboardingPage() {
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);

  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [desiredJob, setDesiredJob] = useState("");
  const [educations, setEducations] = useState<EducationInput[]>([]);
  const [experiences, setExperiences] = useState<ExperienceInput[]>([]);
  const [skills, setSkills] = useState<SkillInput[]>([{ name: "", years: "" }]);

  // 기존 프로필 프리필 — 온보딩을 다시 열어도 입력값이 유지된다
  useEffect(() => {
    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user === null) return; // 가드가 먼저 막지만 방어적으로
      setUserId(user.id);

      try {
        const profile = await getProfileByUserId(supabase, user.id);
        if (profile !== null) {
          setDesiredJob(profile.desired_job ?? "");
          if (profile.educations.length > 0) {
            setEducations(
              profile.educations.map((e) => ({
                school: e.school,
                major: e.major ?? "",
                status: e.status ?? "",
              }))
            );
          }
          if (profile.experiences.length > 0) {
            setExperiences(
              profile.experiences.map((e) => ({
                company: e.company,
                role: e.role ?? "",
                months: e.period_months !== null ? String(e.period_months) : "",
                description: e.description ?? "",
              }))
            );
          }
          if (profile.skills.length > 0) {
            setSkills(
              profile.skills.map((s) => ({
                name: s.name,
                years: s.years !== null ? String(s.years) : "",
              }))
            );
          }
        }
      } catch {
        setError("프로필을 불러오지 못했습니다. 새로고침해 주세요.");
      }
      setLoading(false);
    })();
  }, [supabase]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (userId === null) return;
    setError(null);
    setSubmitting(true);

    // 빈 행 제외 + jsonb 스키마(AI_ANALYSIS_DESIGN.md 7.2)로 변환
    const parsedSkills: ProfileSkill[] = skills
      .filter((s) => s.name.trim() !== "")
      .map((s) => ({
        name: s.name.trim(),
        level: null,
        years: s.years.trim() === "" ? null : Number(s.years),
      }));
    const parsedExperiences: ProfileExperience[] = experiences
      .filter((e) => e.company.trim() !== "")
      .map((e) => ({
        company: e.company.trim(),
        role: e.role.trim() === "" ? null : e.role.trim(),
        period_months: e.months.trim() === "" ? null : Number(e.months),
        description: e.description.trim() === "" ? null : e.description.trim(),
      }));
    const parsedEducations: ProfileEducation[] = educations
      .filter((e) => e.school.trim() !== "")
      .map((e) => ({
        school: e.school.trim(),
        major: e.major.trim() === "" ? null : e.major.trim(),
        degree: null,
        status: e.status.trim() === "" ? null : e.status.trim(),
        period: null,
      }));

    try {
      const updated = await updateProfile(supabase, userId, {
        desired_job: desiredJob.trim(),
        educations: parsedEducations,
        experiences: parsedExperiences,
        skills: parsedSkills,
      });
      void updated; // 저장 후 곧바로 공고 입력(S4)으로 — 완성도 게이지는 S9(M2-5)에서 표시
      window.location.assign("/analyze");
    } catch {
      setSubmitting(false);
      setError("저장에 실패했습니다. 잠시 후 다시 시도해 주세요.");
    }
  }

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-sky-100 via-[#fef6e4] to-[#fef6e4] px-4 py-10">
        <p className="text-center text-sm text-stone-400">
          <span className="animate-hop inline-block text-3xl" aria-hidden>
            🐥
          </span>
          <br />
          프로필을 가져오는 중…
        </p>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gradient-to-b from-sky-100 via-[#fef6e4] to-[#fef6e4] px-4 py-10">
      <div className="mx-auto max-w-xl">
        <div className="text-center">
          <span className="inline-block animate-hop text-6xl" aria-hidden>
            🐥
          </span>
          <div className="bubble bubble-center mx-auto mt-4 max-w-sm text-sm text-stone-600">
            네 이야기를 들려줘! 많이 알수록 더 잘 도와줄 수 있어.
          </div>
        </div>

        <div className="mt-6 rounded-[2rem] border-2 border-amber-100 bg-white p-8 shadow-[0_4px_0_#fde68a]">
          <h1 className="text-center text-2xl text-stone-700">모험 준비하기</h1>
          <p className="mt-2 text-center text-sm text-stone-500">
            희망 직무만 적어도 출발할 수 있어. 더 채울수록 분석이 정확해져!
          </p>

          <form onSubmit={handleSubmit} className="mt-8 space-y-8">
            {/* ① 희망 직무 (필수 — PRD 2.1 최소 입력) */}
            <section>
              <label className="block text-sm text-stone-600">
                🎯 희망 직무 *
                <input
                  type="text"
                  required
                  placeholder="예: 백엔드 개발자"
                  value={desiredJob}
                  onChange={(e) => setDesiredJob(e.target.value)}
                  className={inputClass}
                />
              </label>
            </section>

            {/* ② 학력 (선택) */}
            <ListSection
              title="🎓 학력"
              addLabel="+ 학력 추가"
              items={educations}
              onAdd={() =>
                setEducations((rows) => [...rows, { school: "", major: "", status: "" }])
              }
              onRemove={(index) => setEducations((rows) => rows.filter((_, i) => i !== index))}
              renderItem={(row, index) => (
                <div className="grid grid-cols-3 gap-2">
                  <input
                    type="text"
                    placeholder="학교명"
                    value={row.school}
                    onChange={(e) =>
                      setEducations((rows) =>
                        rows.map((r, i) => (i === index ? { ...r, school: e.target.value } : r))
                      )
                    }
                    className={inputClass}
                  />
                  <input
                    type="text"
                    placeholder="전공"
                    value={row.major}
                    onChange={(e) =>
                      setEducations((rows) =>
                        rows.map((r, i) => (i === index ? { ...r, major: e.target.value } : r))
                      )
                    }
                    className={inputClass}
                  />
                  <input
                    type="text"
                    placeholder="상태 (재학/졸업)"
                    value={row.status}
                    onChange={(e) =>
                      setEducations((rows) =>
                        rows.map((r, i) => (i === index ? { ...r, status: e.target.value } : r))
                      )
                    }
                    className={inputClass}
                  />
                </div>
              )}
            />

            {/* ② 경력 (선택) */}
            <ListSection
              title="💼 경력"
              addLabel="+ 경력 추가"
              items={experiences}
              onAdd={() =>
                setExperiences((rows) => [
                  ...rows,
                  { company: "", role: "", months: "", description: "" },
                ])
              }
              onRemove={(index) => setExperiences((rows) => rows.filter((_, i) => i !== index))}
              renderItem={(row, index) => (
                <div className="space-y-2">
                  <div className="grid grid-cols-3 gap-2">
                    <input
                      type="text"
                      placeholder="회사명"
                      value={row.company}
                      onChange={(e) =>
                        setExperiences((rows) =>
                          rows.map((r, i) => (i === index ? { ...r, company: e.target.value } : r))
                        )
                      }
                      className={inputClass}
                    />
                    <input
                      type="text"
                      placeholder="역할 (예: 백엔드)"
                      value={row.role}
                      onChange={(e) =>
                        setExperiences((rows) =>
                          rows.map((r, i) => (i === index ? { ...r, role: e.target.value } : r))
                        )
                      }
                      className={inputClass}
                    />
                    <input
                      type="number"
                      min={0}
                      placeholder="개월 수"
                      value={row.months}
                      onChange={(e) =>
                        setExperiences((rows) =>
                          rows.map((r, i) => (i === index ? { ...r, months: e.target.value } : r))
                        )
                      }
                      className={inputClass}
                    />
                  </div>
                  <input
                    type="text"
                    placeholder="업무 설명 (선택)"
                    value={row.description}
                    onChange={(e) =>
                      setExperiences((rows) =>
                        rows.map((r, i) =>
                          i === index ? { ...r, description: e.target.value } : r
                        )
                      )
                    }
                    className={inputClass}
                  />
                </div>
              )}
            />

            {/* ③ 스킬 (선택 — 판정 정확도의 핵심 입력) */}
            <ListSection
              title="🛠️ 스킬"
              addLabel="+ 스킬 추가"
              items={skills}
              onAdd={() => setSkills((rows) => [...rows, { name: "", years: "" }])}
              onRemove={(index) => setSkills((rows) => rows.filter((_, i) => i !== index))}
              renderItem={(row, index) => (
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="text"
                    placeholder="기술명 (예: Python)"
                    value={row.name}
                    onChange={(e) =>
                      setSkills((rows) =>
                        rows.map((r, i) => (i === index ? { ...r, name: e.target.value } : r))
                      )
                    }
                    className={inputClass}
                  />
                  <input
                    type="number"
                    min={0}
                    step="any" // 2.5년 같은 소수 연차 허용 — 기본 step=1이면 제출이 조용히 막힌다
                    placeholder="사용 연차"
                    value={row.years}
                    onChange={(e) =>
                      setSkills((rows) =>
                        rows.map((r, i) => (i === index ? { ...r, years: e.target.value } : r))
                      )
                    }
                    className={inputClass}
                  />
                </div>
              )}
            />

            {error !== null && (
              <p className="rounded-2xl border-2 border-rose-100 bg-rose-50 px-4 py-3 text-sm text-rose-600">
                🥺 {error}
              </p>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-full bg-amber-300 py-3 text-sm text-amber-950 shadow-[0_4px_0_#f59e0b] transition-transform hover:-translate-y-0.5 active:translate-y-0.5 active:shadow-none disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none"
            >
              {submitting ? "가방에 담는 중… 🎒" : "저장하고 출발하기 🧳"}
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}

/** 추가/삭제 가능한 입력 목록 섹션 (페이지 전용 — 온보딩 3개 섹션 공통 골격) */
function ListSection<T>({
  title,
  addLabel,
  items,
  onAdd,
  onRemove,
  renderItem,
}: {
  title: string;
  addLabel: string;
  items: T[];
  onAdd: () => void;
  onRemove: (index: number) => void;
  renderItem: (item: T, index: number) => React.ReactNode;
}) {
  return (
    <section>
      <h2 className="text-sm text-stone-600">{title}</h2>
      <div className="mt-2 space-y-3">
        {items.map((item, index) => (
          <div key={index} className="rounded-2xl border-2 border-amber-50 bg-amber-50/50 p-4">
            {renderItem(item, index)}
            <button
              type="button"
              onClick={() => onRemove(index)}
              className="mt-2 text-xs text-rose-300 transition-colors hover:text-rose-500"
            >
              빼기
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={onAdd}
        className="mt-3 rounded-full border-2 border-amber-100 bg-white px-4 py-1.5 text-xs text-amber-700 transition-transform hover:-translate-y-0.5"
      >
        {addLabel}
      </button>
    </section>
  );
}
