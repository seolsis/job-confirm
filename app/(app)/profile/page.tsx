"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import {
  computeProfileCompleteness,
  getProfileByUserId,
  updateProfile,
  type ProfileSections,
} from "@/lib/db/profiles";
import type {
  ProfileCertificate,
  ProfileEducation,
  ProfileExperience,
  ProfileLanguage,
  ProfileProject,
  ProfileSkill,
} from "@/lib/db/profile-snapshots";
import { createBrowserSupabaseClient } from "@/lib/supabase/browser";

/**
 * S9 — 프로필 관리 (M2-5, PRD 3.2). "동물 친구들" 컨셉의 내 정보 화면.
 *
 * 온보딩(S3)이 최소 입력(희망직무·학력·경력·스킬)이라면, 여기는 전체 7개 섹션
 * (+ 희망 조건·자격증·어학·프로젝트)을 관리한다. 완성도 게이지(%)와 항목별
 * 체크리스트로 "완성도가 분석 정확도와 직결됨"을 명시한다 (PRD S9).
 *
 * 저장은 lib/db/profiles.updateProfile 재사용 — completeness는 서버 산식으로
 * 함께 기록되고, 다음 분석 요청 때 스냅샷이 새로 만들어진다(content_hash).
 * 미인증 접근은 proxy 가드가 /login?next=/profile 로 보낸다.
 */

/* ── 폼 입력용 행 타입 (문자열 상태 — 저장 시 jsonb 스키마로 변환) ─────────── */
interface EducationInput {
  school: string;
  major: string;
  status: string;
}
interface ExperienceInput {
  company: string;
  role: string;
  months: string;
  description: string;
}
interface SkillInput {
  name: string;
  years: string;
}
interface CertificateInput {
  name: string;
  issuer: string;
}
interface LanguageInput {
  test: string;
  score: string;
}
interface ProjectInput {
  name: string;
  role: string;
  description: string;
  tech: string; // 콤마 구분 입력 → string[] 변환
}

const inputClass =
  "mt-1.5 w-full rounded-2xl border-2 border-amber-100 bg-white px-4 py-2.5 text-sm text-stone-700 outline-none transition-colors placeholder:text-stone-300 focus:border-amber-300";

export default function ProfilePage() {
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);

  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const [desiredJob, setDesiredJob] = useState("");
  const [desiredSalary, setDesiredSalary] = useState("");
  const [desiredLocation, setDesiredLocation] = useState("");
  const [desiredEmployment, setDesiredEmployment] = useState("");
  const [educations, setEducations] = useState<EducationInput[]>([]);
  const [experiences, setExperiences] = useState<ExperienceInput[]>([]);
  const [skills, setSkills] = useState<SkillInput[]>([]);
  const [certificates, setCertificates] = useState<CertificateInput[]>([]);
  const [languages, setLanguages] = useState<LanguageInput[]>([]);
  const [projects, setProjects] = useState<ProjectInput[]>([]);

  // 프리필 — 현재 프로필 전체를 폼 상태로
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
          const conditions = profile.desired_conditions as Record<string, unknown>;
          setDesiredSalary(typeof conditions.salary === "string" ? conditions.salary : "");
          setDesiredLocation(typeof conditions.location === "string" ? conditions.location : "");
          setDesiredEmployment(
            typeof conditions.employment_type === "string" ? conditions.employment_type : ""
          );
          setEducations(
            profile.educations.map((e) => ({
              school: e.school,
              major: e.major ?? "",
              status: e.status ?? "",
            }))
          );
          setExperiences(
            profile.experiences.map((e) => ({
              company: e.company,
              role: e.role ?? "",
              months: e.period_months !== null ? String(e.period_months) : "",
              description: e.description ?? "",
            }))
          );
          setSkills(
            profile.skills.map((s) => ({
              name: s.name,
              years: s.years !== null ? String(s.years) : "",
            }))
          );
          setCertificates(
            profile.certificates.map((c) => ({ name: c.name, issuer: c.issuer ?? "" }))
          );
          setLanguages(profile.languages.map((l) => ({ test: l.test, score: l.score ?? "" })));
          setProjects(
            profile.projects.map((p) => ({
              name: p.name,
              role: p.role ?? "",
              description: p.description ?? "",
              tech: p.tech.join(", "),
            }))
          );
        }
      } catch {
        setError("프로필을 불러오지 못했어. 새로고침해 줄래?");
      }
      setLoading(false);
    })();
  }, [supabase]);

  /** 현재 폼 상태 → 저장용 섹션 (jsonb 스키마, AI_ANALYSIS_DESIGN.md 7.2) */
  function toSections(): ProfileSections {
    const conditions: Record<string, unknown> = {};
    if (desiredSalary.trim() !== "") conditions.salary = desiredSalary.trim();
    if (desiredLocation.trim() !== "") conditions.location = desiredLocation.trim();
    if (desiredEmployment.trim() !== "") conditions.employment_type = desiredEmployment.trim();

    const parsedEducations: ProfileEducation[] = educations
      .filter((e) => e.school.trim() !== "")
      .map((e) => ({
        school: e.school.trim(),
        major: e.major.trim() === "" ? null : e.major.trim(),
        degree: null,
        status: e.status.trim() === "" ? null : e.status.trim(),
        period: null,
      }));
    const parsedExperiences: ProfileExperience[] = experiences
      .filter((e) => e.company.trim() !== "")
      .map((e) => ({
        company: e.company.trim(),
        role: e.role.trim() === "" ? null : e.role.trim(),
        period_months: e.months.trim() === "" ? null : Number(e.months),
        description: e.description.trim() === "" ? null : e.description.trim(),
      }));
    const parsedSkills: ProfileSkill[] = skills
      .filter((s) => s.name.trim() !== "")
      .map((s) => ({
        name: s.name.trim(),
        level: null,
        years: s.years.trim() === "" ? null : Number(s.years),
      }));
    const parsedCertificates: ProfileCertificate[] = certificates
      .filter((c) => c.name.trim() !== "")
      .map((c) => ({
        name: c.name.trim(),
        issuer: c.issuer.trim() === "" ? null : c.issuer.trim(),
        acquired_at: null,
      }));
    const parsedLanguages: ProfileLanguage[] = languages
      .filter((l) => l.test.trim() !== "")
      .map((l) => ({
        test: l.test.trim(),
        score: l.score.trim() === "" ? null : l.score.trim(),
        acquired_at: null,
      }));
    const parsedProjects: ProfileProject[] = projects
      .filter((p) => p.name.trim() !== "")
      .map((p) => ({
        name: p.name.trim(),
        role: p.role.trim() === "" ? null : p.role.trim(),
        description: p.description.trim() === "" ? null : p.description.trim(),
        tech: p.tech
          .split(",")
          .map((item) => item.trim())
          .filter((item) => item !== ""),
      }));

    return {
      desired_job: desiredJob.trim() === "" ? null : desiredJob.trim(),
      desired_conditions: conditions,
      educations: parsedEducations,
      experiences: parsedExperiences,
      skills: parsedSkills,
      certificates: parsedCertificates,
      languages: parsedLanguages,
      projects: parsedProjects,
    };
  }

  // 입력 중 실시간 완성도 (저장 시 서버가 같은 산식으로 기록한다)
  const sections = toSections();
  const completeness = computeProfileCompleteness(sections);
  const checklist: Array<{ label: string; filled: boolean }> = [
    { label: "희망 직무", filled: sections.desired_job !== null },
    { label: "희망 조건", filled: Object.keys(sections.desired_conditions).length > 0 },
    { label: "학력", filled: sections.educations.length > 0 },
    { label: "경력", filled: sections.experiences.length > 0 },
    { label: "스킬", filled: sections.skills.length > 0 },
    {
      label: "자격증·어학",
      filled: sections.certificates.length > 0 || sections.languages.length > 0,
    },
    { label: "프로젝트", filled: sections.projects.length > 0 },
  ];

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (userId === null) return;
    setError(null);
    setSubmitting(true);

    try {
      await updateProfile(supabase, userId, toSections());
      setSavedAt(Date.now());
    } catch {
      setError("저장에 실패했어. 잠시 후 다시 시도해 줄래?");
    }
    setSubmitting(false);
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
    window.location.assign("/login");
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
      {/* 상단 내비 — 분석 화면으로 */}
      <nav className="fixed top-4 right-4 z-10">
        <Link
          href="/analyze"
          className="flex items-center gap-1.5 rounded-full border-2 border-amber-100 bg-white/90 px-4 py-2 text-sm text-stone-600 shadow-sm transition-transform hover:-translate-y-0.5"
        >
          <span aria-hidden>🔍</span> 공고 분석하러 가기
        </Link>
      </nav>

      <div className="mx-auto max-w-xl">
        <div className="text-center">
          <span className="inline-block animate-float text-6xl" aria-hidden>
            🐥
          </span>
          <div className="bubble bubble-center mx-auto mt-4 max-w-sm text-sm text-stone-600">
            {completeness === 100
              ? "완벽해! 이제 어떤 공고든 정확하게 비교해 줄 수 있어."
              : "채울수록 분석이 정확해져. 부담 없이 아는 것부터!"}
          </div>
        </div>

        {/* 완성도 게이지 + 항목 체크리스트 (PRD S9) */}
        <div className="mt-6 rounded-[2rem] border-2 border-amber-100 bg-white p-6 shadow-[0_4px_0_#fde68a]">
          <div className="flex items-baseline justify-between">
            <h1 className="text-xl text-stone-700">내 프로필</h1>
            <span className="text-2xl text-amber-500">{completeness}%</span>
          </div>
          <div className="mt-3 h-3 overflow-hidden rounded-full bg-amber-50">
            <div
              className="h-full rounded-full bg-amber-300 transition-[width] duration-500"
              style={{ width: `${completeness}%` }}
              role="progressbar"
              aria-valuenow={completeness}
              aria-valuemin={0}
              aria-valuemax={100}
            />
          </div>
          <ul className="mt-4 flex flex-wrap gap-2">
            {checklist.map(({ label, filled }) => (
              <li
                key={label}
                className={`rounded-full px-3 py-1 text-xs ${
                  filled ? "bg-emerald-50 text-emerald-600" : "bg-stone-50 text-stone-300"
                }`}
              >
                {filled ? "✓" : "○"} {label}
              </li>
            ))}
          </ul>
        </div>

        <form onSubmit={handleSubmit} className="mt-6 space-y-6">
          {/* 🎯 희망 직무 + 희망 조건 */}
          <SectionCard title="🎯 희망 직무와 조건">
            <label className="block text-sm text-stone-600">
              희망 직무
              <input
                type="text"
                placeholder="예: 백엔드 개발자"
                value={desiredJob}
                onChange={(e) => setDesiredJob(e.target.value)}
                className={inputClass}
              />
            </label>
            <div className="mt-3 grid grid-cols-3 gap-2">
              <input
                type="text"
                placeholder="희망 연봉"
                value={desiredSalary}
                onChange={(e) => setDesiredSalary(e.target.value)}
                className={inputClass}
              />
              <input
                type="text"
                placeholder="희망 지역"
                value={desiredLocation}
                onChange={(e) => setDesiredLocation(e.target.value)}
                className={inputClass}
              />
              <input
                type="text"
                placeholder="고용 형태"
                value={desiredEmployment}
                onChange={(e) => setDesiredEmployment(e.target.value)}
                className={inputClass}
              />
            </div>
          </SectionCard>

          {/* 🎓 학력 */}
          <SectionCard title="🎓 학력">
            <ListRows
              items={educations}
              addLabel="+ 학력 추가"
              onAdd={() =>
                setEducations((rows) => [...rows, { school: "", major: "", status: "" }])
              }
              onRemove={(i) => setEducations((rows) => rows.filter((_, index) => index !== i))}
              renderItem={(row, i) => (
                <div className="grid grid-cols-3 gap-2">
                  <input
                    type="text"
                    placeholder="학교명"
                    value={row.school}
                    onChange={(e) =>
                      setEducations((rows) => patch(rows, i, { school: e.target.value }))
                    }
                    className={inputClass}
                  />
                  <input
                    type="text"
                    placeholder="전공"
                    value={row.major}
                    onChange={(e) =>
                      setEducations((rows) => patch(rows, i, { major: e.target.value }))
                    }
                    className={inputClass}
                  />
                  <input
                    type="text"
                    placeholder="상태 (재학/졸업)"
                    value={row.status}
                    onChange={(e) =>
                      setEducations((rows) => patch(rows, i, { status: e.target.value }))
                    }
                    className={inputClass}
                  />
                </div>
              )}
            />
          </SectionCard>

          {/* 💼 경력 */}
          <SectionCard title="💼 경력">
            <ListRows
              items={experiences}
              addLabel="+ 경력 추가"
              onAdd={() =>
                setExperiences((rows) => [
                  ...rows,
                  { company: "", role: "", months: "", description: "" },
                ])
              }
              onRemove={(i) => setExperiences((rows) => rows.filter((_, index) => index !== i))}
              renderItem={(row, i) => (
                <div className="space-y-2">
                  <div className="grid grid-cols-3 gap-2">
                    <input
                      type="text"
                      placeholder="회사명"
                      value={row.company}
                      onChange={(e) =>
                        setExperiences((rows) => patch(rows, i, { company: e.target.value }))
                      }
                      className={inputClass}
                    />
                    <input
                      type="text"
                      placeholder="역할"
                      value={row.role}
                      onChange={(e) =>
                        setExperiences((rows) => patch(rows, i, { role: e.target.value }))
                      }
                      className={inputClass}
                    />
                    <input
                      type="number"
                      min={0}
                      placeholder="개월 수"
                      value={row.months}
                      onChange={(e) =>
                        setExperiences((rows) => patch(rows, i, { months: e.target.value }))
                      }
                      className={inputClass}
                    />
                  </div>
                  <input
                    type="text"
                    placeholder="업무 설명 (선택)"
                    value={row.description}
                    onChange={(e) =>
                      setExperiences((rows) => patch(rows, i, { description: e.target.value }))
                    }
                    className={inputClass}
                  />
                </div>
              )}
            />
          </SectionCard>

          {/* 🛠️ 스킬 */}
          <SectionCard title="🛠️ 스킬">
            <ListRows
              items={skills}
              addLabel="+ 스킬 추가"
              onAdd={() => setSkills((rows) => [...rows, { name: "", years: "" }])}
              onRemove={(i) => setSkills((rows) => rows.filter((_, index) => index !== i))}
              renderItem={(row, i) => (
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="text"
                    placeholder="기술명 (예: Python)"
                    value={row.name}
                    onChange={(e) => setSkills((rows) => patch(rows, i, { name: e.target.value }))}
                    className={inputClass}
                  />
                  <input
                    type="number"
                    min={0}
                    step="any"
                    placeholder="사용 연차"
                    value={row.years}
                    onChange={(e) => setSkills((rows) => patch(rows, i, { years: e.target.value }))}
                    className={inputClass}
                  />
                </div>
              )}
            />
          </SectionCard>

          {/* 📜 자격증 */}
          <SectionCard title="📜 자격증">
            <ListRows
              items={certificates}
              addLabel="+ 자격증 추가"
              onAdd={() => setCertificates((rows) => [...rows, { name: "", issuer: "" }])}
              onRemove={(i) => setCertificates((rows) => rows.filter((_, index) => index !== i))}
              renderItem={(row, i) => (
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="text"
                    placeholder="자격증명 (예: 정보처리기사)"
                    value={row.name}
                    onChange={(e) =>
                      setCertificates((rows) => patch(rows, i, { name: e.target.value }))
                    }
                    className={inputClass}
                  />
                  <input
                    type="text"
                    placeholder="발급 기관 (선택)"
                    value={row.issuer}
                    onChange={(e) =>
                      setCertificates((rows) => patch(rows, i, { issuer: e.target.value }))
                    }
                    className={inputClass}
                  />
                </div>
              )}
            />
          </SectionCard>

          {/* 🗣️ 어학 */}
          <SectionCard title="🗣️ 어학">
            <ListRows
              items={languages}
              addLabel="+ 어학 추가"
              onAdd={() => setLanguages((rows) => [...rows, { test: "", score: "" }])}
              onRemove={(i) => setLanguages((rows) => rows.filter((_, index) => index !== i))}
              renderItem={(row, i) => (
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="text"
                    placeholder="시험명 (예: TOEIC)"
                    value={row.test}
                    onChange={(e) =>
                      setLanguages((rows) => patch(rows, i, { test: e.target.value }))
                    }
                    className={inputClass}
                  />
                  <input
                    type="text"
                    placeholder="점수/등급 (예: 900)"
                    value={row.score}
                    onChange={(e) =>
                      setLanguages((rows) => patch(rows, i, { score: e.target.value }))
                    }
                    className={inputClass}
                  />
                </div>
              )}
            />
          </SectionCard>

          {/* 🧩 프로젝트 */}
          <SectionCard title="🧩 프로젝트">
            <ListRows
              items={projects}
              addLabel="+ 프로젝트 추가"
              onAdd={() =>
                setProjects((rows) => [...rows, { name: "", role: "", description: "", tech: "" }])
              }
              onRemove={(i) => setProjects((rows) => rows.filter((_, index) => index !== i))}
              renderItem={(row, i) => (
                <div className="space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      type="text"
                      placeholder="프로젝트명"
                      value={row.name}
                      onChange={(e) =>
                        setProjects((rows) => patch(rows, i, { name: e.target.value }))
                      }
                      className={inputClass}
                    />
                    <input
                      type="text"
                      placeholder="맡은 역할 (선택)"
                      value={row.role}
                      onChange={(e) =>
                        setProjects((rows) => patch(rows, i, { role: e.target.value }))
                      }
                      className={inputClass}
                    />
                  </div>
                  <input
                    type="text"
                    placeholder="설명 (선택)"
                    value={row.description}
                    onChange={(e) =>
                      setProjects((rows) => patch(rows, i, { description: e.target.value }))
                    }
                    className={inputClass}
                  />
                  <input
                    type="text"
                    placeholder="사용 기술 — 콤마로 구분 (예: Python, Django, AWS)"
                    value={row.tech}
                    onChange={(e) =>
                      setProjects((rows) => patch(rows, i, { tech: e.target.value }))
                    }
                    className={inputClass}
                  />
                </div>
              )}
            />
          </SectionCard>

          {error !== null && (
            <p className="rounded-2xl border-2 border-rose-100 bg-rose-50 px-4 py-3 text-sm text-rose-600">
              🥺 {error}
            </p>
          )}
          {savedAt !== null && error === null && (
            <p className="rounded-2xl border-2 border-emerald-100 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
              ✅ 저장했어! 다음 분석부터 새 프로필로 비교할게.
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-full bg-amber-300 py-3 text-sm text-amber-950 shadow-[0_4px_0_#f59e0b] transition-transform hover:-translate-y-0.5 active:translate-y-0.5 active:shadow-none disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none"
          >
            {submitting ? "저장하는 중… 🎒" : "프로필 저장하기"}
          </button>
        </form>

        <div className="mt-10 text-center">
          <button
            type="button"
            onClick={handleSignOut}
            className="text-xs text-stone-400 underline transition-colors hover:text-stone-600"
          >
            여행 잠시 쉬기 (로그아웃)
          </button>
        </div>
      </div>
    </main>
  );
}

/** 배열 상태의 i번째 행에 부분 patch를 적용한다 */
function patch<T>(rows: T[], index: number, change: Partial<T>): T[] {
  return rows.map((row, i) => (i === index ? { ...row, ...change } : row));
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-[2rem] border-2 border-amber-100 bg-white p-6 shadow-[0_4px_0_#fde68a]">
      <h2 className="mb-3 text-base text-stone-700">{title}</h2>
      {children}
    </section>
  );
}

/** 추가/삭제 가능한 입력 목록 (온보딩 ListSection과 동일 패턴의 S9 로컬 버전) */
function ListRows<T>({
  items,
  addLabel,
  onAdd,
  onRemove,
  renderItem,
}: {
  items: T[];
  addLabel: string;
  onAdd: () => void;
  onRemove: (index: number) => void;
  renderItem: (item: T, index: number) => React.ReactNode;
}) {
  return (
    <div>
      <div className="space-y-3">
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
    </div>
  );
}
