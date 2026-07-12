"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

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

/** 희망 직무 선택지 (중복 선택) — 자유 입력 대신 카테고리 다중 선택으로 정규화 */
const JOB_CATEGORY_OPTIONS = [
  "백엔드 개발",
  "프론트엔드 개발",
  "모바일 개발",
  "데이터/AI",
  "인프라/DevOps",
  "기획/PM",
  "디자인",
  "마케팅",
  "영업",
  "경영지원/인사",
  "재무/회계",
  "생산/제조",
  "공기업/공공",
  "연구개발",
  "CS/고객지원",
  "기타",
];

/** 희망 지역 선택지 (중복 선택) */
const REGION_OPTIONS = [
  "서울",
  "경기",
  "인천",
  "강원",
  "대전",
  "세종",
  "충남",
  "충북",
  "광주",
  "전남",
  "전북",
  "대구",
  "경북",
  "부산",
  "울산",
  "경남",
  "제주",
  "전국/원격",
];

/** 희망 연봉 슬라이더 범위 (만원 단위) */
const SALARY_FLOOR = 0;
const SALARY_CEIL = 15000;
const SALARY_STEP = 100;

/** 희망 직무의 "직접 입력" 옵션 — 선택 시 아래에 텍스트 입력이 나타난다 */
const OTHER_JOB_OPTION = "기타";

/** 고용 형태 선택지 (드롭다운, 중복 선택) */
const EMPLOYMENT_OPTIONS = ["정규직", "계약직", "인턴", "파견직", "프리랜서"];

/**
 * "경력 없음" 표시용 더미 경력 행 — 스키마 변경 없이 experiences 배열 안에
 * 이 한 행만 넣어 "신입(정보 없음이 아니라 확인된 무경력)"임을 저장한다.
 * 빈 배열(아직 입력 안 함)과 구분돼야 완성도·매칭 판정에 의미가 생긴다.
 */
const NO_EXPERIENCE_SENTINEL_COMPANY = "경력 없음 (신입)";

function toggleIn(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

/** 다중 선택 칩 — 희망 직무·희망 지역이 공유하는 토글 버튼 그리드 */
function ChipMultiSelect({
  options,
  selected,
  onToggle,
}: {
  options: string[];
  selected: string[];
  onToggle: (option: string) => void;
}) {
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {options.map((option) => {
        const active = selected.includes(option);
        return (
          <button
            key={option}
            type="button"
            onClick={() => onToggle(option)}
            aria-pressed={active}
            className={`rounded-full border-2 px-3 py-1.5 text-xs transition-colors ${
              active
                ? "border-amber-300 bg-amber-200 text-amber-900"
                : "border-amber-100 bg-white text-stone-500 hover:bg-amber-50"
            }`}
          >
            {option}
          </button>
        );
      })}
    </div>
  );
}

/** 드롭다운 다중 선택 — 고용 형태처럼 목록이 짧고 "닫혀 있는 게 기본"인 필드용 */
function DropdownMultiSelect({
  options,
  selected,
  onToggle,
  placeholder,
}: {
  options: string[];
  selected: string[];
  onToggle: (option: string) => void;
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleOutside(event: MouseEvent) {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [open]);

  return (
    <div ref={rootRef} className="relative mt-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between rounded-2xl border-2 border-amber-100 bg-white px-4 py-2.5 text-left text-sm text-stone-700 outline-none transition-colors focus:border-amber-300"
      >
        <span className={selected.length === 0 ? "text-stone-300" : "text-stone-700"}>
          {selected.length > 0 ? selected.join(", ") : placeholder}
        </span>
        <span aria-hidden className="text-stone-400">
          {open ? "▲" : "▼"}
        </span>
      </button>
      {open && (
        <div className="absolute z-30 mt-1.5 w-full rounded-2xl border-2 border-amber-100 bg-white p-1.5 shadow-lg">
          {options.map((option) => {
            const active = selected.includes(option);
            return (
              <button
                key={option}
                type="button"
                onClick={() => onToggle(option)}
                aria-pressed={active}
                className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm transition-colors ${
                  active ? "bg-amber-100 text-amber-900" : "text-stone-600 hover:bg-amber-50"
                }`}
              >
                <span
                  aria-hidden
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border-2 text-[10px] ${
                    active ? "border-amber-400 bg-amber-400 text-white" : "border-stone-200"
                  }`}
                >
                  {active ? "✓" : ""}
                </span>
                {option}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * 희망 연봉 듀얼 레인지 슬라이더 (만원 단위). 네이티브 range input 2개를
 * 겹쳐 각각의 썸(::-webkit-slider-thumb 등, globals.css의 .range-thumb)만
 * 클릭 가능하게 만드는 CSS-only 기법 — 라이브러리 없이 드래그 범위 선택.
 */
function SalaryRangeSlider({
  min,
  max,
  onChange,
}: {
  min: number;
  max: number;
  onChange: (min: number, max: number) => void;
}) {
  const minPct = ((min - SALARY_FLOOR) / (SALARY_CEIL - SALARY_FLOOR)) * 100;
  const maxPct = ((max - SALARY_FLOOR) / (SALARY_CEIL - SALARY_FLOOR)) * 100;

  return (
    <div className="mt-1.5">
      <div className="flex items-center justify-between text-sm text-stone-700">
        <span>{min.toLocaleString()}만원</span>
        <span>{max.toLocaleString()}만원</span>
      </div>
      <div className="relative mt-3 h-5">
        <div className="absolute top-1/2 h-1.5 w-full -translate-y-1/2 rounded-full bg-amber-50" />
        <div
          className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-amber-300"
          style={{ left: `${minPct}%`, right: `${100 - maxPct}%` }}
        />
        <input
          type="range"
          aria-label="희망 연봉 최소"
          min={SALARY_FLOOR}
          max={SALARY_CEIL}
          step={SALARY_STEP}
          value={min}
          onChange={(e) => onChange(Math.min(Number(e.target.value), max - SALARY_STEP), max)}
          className="range-thumb pointer-events-none absolute inset-x-0 top-1/2 z-10 w-full -translate-y-1/2 appearance-none bg-transparent"
        />
        <input
          type="range"
          aria-label="희망 연봉 최대"
          min={SALARY_FLOOR}
          max={SALARY_CEIL}
          step={SALARY_STEP}
          value={max}
          onChange={(e) => onChange(min, Math.max(Number(e.target.value), min + SALARY_STEP))}
          className="range-thumb pointer-events-none absolute inset-x-0 top-1/2 z-20 w-full -translate-y-1/2 appearance-none bg-transparent"
        />
      </div>
    </div>
  );
}

export default function ProfilePage() {
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);

  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const [desiredJobs, setDesiredJobs] = useState<string[]>([]);
  const [desiredJobOther, setDesiredJobOther] = useState("");
  const [desiredSalaryMin, setDesiredSalaryMin] = useState(3000);
  const [desiredSalaryMax, setDesiredSalaryMax] = useState(5000);
  const [desiredLocations, setDesiredLocations] = useState<string[]>([]);
  const [desiredEmployments, setDesiredEmployments] = useState<string[]>([]);
  const [educations, setEducations] = useState<EducationInput[]>([]);
  const [experiences, setExperiences] = useState<ExperienceInput[]>([]);
  const [noExperience, setNoExperience] = useState(false);
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
          {
            // 희망 직무 — 목록에 없는 값(예전 자유 입력·직접 입력)은 "기타" +
            // 아래 텍스트 입력으로 되돌린다
            const rawJobs =
              profile.desired_job !== null && profile.desired_job.trim() !== ""
                ? profile.desired_job
                    .split(",")
                    .map((v) => v.trim())
                    .filter((v) => v !== "")
                : [];
            const known = rawJobs.filter(
              (v) => JOB_CATEGORY_OPTIONS.includes(v) && v !== OTHER_JOB_OPTION
            );
            const custom = rawJobs.filter((v) => !JOB_CATEGORY_OPTIONS.includes(v));
            const hasOther = custom.length > 0 || rawJobs.includes(OTHER_JOB_OPTION);
            setDesiredJobs(hasOther ? [...known, OTHER_JOB_OPTION] : known);
            setDesiredJobOther(custom.join(", "));
          }

          const conditions = profile.desired_conditions as Record<string, unknown>;

          // 연봉 — 새 형식 {min,max}과 예전 자유 입력 문자열("3500-4000만원") 둘 다 대응
          const salary = conditions.salary;
          if (salary !== null && typeof salary === "object" && !Array.isArray(salary)) {
            const { min, max } = salary as { min?: unknown; max?: unknown };
            if (typeof min === "number") setDesiredSalaryMin(min);
            if (typeof max === "number") setDesiredSalaryMax(max);
          } else if (typeof salary === "string") {
            const match = /(\d[\d,]*)\s*[-~]\s*(\d[\d,]*)/.exec(salary);
            if (match) {
              setDesiredSalaryMin(Number(match[1].replace(/,/g, "")));
              setDesiredSalaryMax(Number(match[2].replace(/,/g, "")));
            }
          }

          // 지역 — 새 형식 string[]과 예전 자유 입력 문자열 둘 다 대응
          const location = conditions.location;
          if (Array.isArray(location)) {
            setDesiredLocations(location.filter((v): v is string => typeof v === "string"));
          } else if (typeof location === "string" && location.trim() !== "") {
            setDesiredLocations(
              location
                .split(",")
                .map((v) => v.trim())
                .filter((v) => v !== "")
            );
          }

          // 고용 형태 — 새 형식 string[]과 예전 자유 입력 문자열 둘 다 대응
          const employment = conditions.employment_type;
          if (Array.isArray(employment)) {
            setDesiredEmployments(employment.filter((v): v is string => typeof v === "string"));
          } else if (typeof employment === "string" && employment.trim() !== "") {
            setDesiredEmployments(
              employment
                .split(",")
                .map((v) => v.trim())
                .filter((v) => v !== "")
            );
          }
          setEducations(
            profile.educations.map((e) => ({
              school: e.school,
              major: e.major ?? "",
              status: e.status ?? "",
            }))
          );
          {
            const isNoExperience =
              profile.experiences.length === 1 &&
              profile.experiences[0].company === NO_EXPERIENCE_SENTINEL_COMPANY;
            setNoExperience(isNoExperience);
            setExperiences(
              isNoExperience
                ? []
                : profile.experiences.map((e) => ({
                    company: e.company,
                    role: e.role ?? "",
                    months: e.period_months !== null ? String(e.period_months) : "",
                    description: e.description ?? "",
                  }))
            );
          }
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
    const conditions: Record<string, unknown> = {
      salary: { min: desiredSalaryMin, max: desiredSalaryMax },
    };
    if (desiredLocations.length > 0) conditions.location = desiredLocations;
    if (desiredEmployments.length > 0) conditions.employment_type = desiredEmployments;

    const parsedEducations: ProfileEducation[] = educations
      .filter((e) => e.school.trim() !== "")
      .map((e) => ({
        school: e.school.trim(),
        major: e.major.trim() === "" ? null : e.major.trim(),
        degree: null,
        status: e.status.trim() === "" ? null : e.status.trim(),
        period: null,
      }));
    const parsedExperiences: ProfileExperience[] = noExperience
      ? [
          {
            company: NO_EXPERIENCE_SENTINEL_COMPANY,
            role: null,
            period_months: 0,
            description: null,
          },
        ]
      : experiences
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

    // "기타" 선택 시 직접 입력한 값으로 대체한다 (콤마로 여러 개 입력 가능).
    // 아무것도 안 썼으면 "기타" 그 자체를 값으로 남긴다.
    const finalJobs = desiredJobs.flatMap((option) => {
      if (option !== OTHER_JOB_OPTION) return [option];
      const custom = desiredJobOther
        .split(",")
        .map((v) => v.trim())
        .filter((v) => v !== "");
      return custom.length > 0 ? custom : [OTHER_JOB_OPTION];
    });

    return {
      desired_job: finalJobs.length > 0 ? finalJobs.join(", ") : null,
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
      {/* 상단 내비 — 분석 화면·설정으로 */}
      <nav className="fixed top-4 right-4 z-10 flex gap-2">
        <Link
          href="/analyze"
          className="flex items-center gap-1.5 rounded-full border-2 border-amber-100 bg-white/90 px-4 py-2 text-sm text-stone-600 shadow-sm transition-transform hover:-translate-y-0.5"
        >
          <span aria-hidden>🔍</span> 공고 분석하러 가기
        </Link>
        <Link
          href="/settings"
          aria-label="설정"
          className="flex items-center rounded-full border-2 border-amber-100 bg-white/90 px-3 py-2 text-sm text-stone-600 shadow-sm transition-transform hover:-translate-y-0.5"
        >
          <span aria-hidden>⚙️</span>
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
            <div className="text-sm text-stone-600">
              희망 직무 <span className="text-xs text-stone-400">(중복 선택 가능)</span>
              <ChipMultiSelect
                options={JOB_CATEGORY_OPTIONS}
                selected={desiredJobs}
                onToggle={(option) => setDesiredJobs((prev) => toggleIn(prev, option))}
              />
              {desiredJobs.includes(OTHER_JOB_OPTION) && (
                <input
                  type="text"
                  placeholder="직접 입력 (콤마로 여러 개 가능, 예: 공기업 전산직)"
                  value={desiredJobOther}
                  onChange={(e) => setDesiredJobOther(e.target.value)}
                  className={inputClass}
                />
              )}
            </div>

            <div className="mt-5 text-sm text-stone-600">
              희망 연봉
              <SalaryRangeSlider
                min={desiredSalaryMin}
                max={desiredSalaryMax}
                onChange={(next, nextMax) => {
                  setDesiredSalaryMin(next);
                  setDesiredSalaryMax(nextMax);
                }}
              />
            </div>

            <div className="mt-5 text-sm text-stone-600">
              희망 지역 <span className="text-xs text-stone-400">(중복 선택 가능)</span>
              <ChipMultiSelect
                options={REGION_OPTIONS}
                selected={desiredLocations}
                onToggle={(option) => setDesiredLocations((prev) => toggleIn(prev, option))}
              />
            </div>

            <div className="mt-5 text-sm text-stone-600">
              고용 형태 <span className="text-xs text-stone-400">(중복 선택 가능)</span>
              <DropdownMultiSelect
                options={EMPLOYMENT_OPTIONS}
                selected={desiredEmployments}
                onToggle={(option) => setDesiredEmployments((prev) => toggleIn(prev, option))}
                placeholder="선택해 줘"
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
            {/* 커스텀 체크박스 — 네이티브 input은 숨기고(peer) 테마에 맞는 박스를 그린다 */}
            <label className="inline-flex w-fit cursor-pointer items-center gap-2 rounded-full border-2 border-amber-100 bg-white py-2 pr-4 pl-2.5 text-sm text-stone-600 transition-colors select-none hover:bg-amber-50 has-checked:border-amber-300 has-checked:bg-amber-100 has-checked:text-amber-900">
              <input
                type="checkbox"
                checked={noExperience}
                onChange={(e) => {
                  setNoExperience(e.target.checked);
                  if (e.target.checked) setExperiences([]);
                }}
                className="peer sr-only"
              />
              <span
                aria-hidden
                className="flex h-5 w-5 items-center justify-center rounded-lg border-2 border-amber-200 bg-white text-[11px] text-transparent transition-all peer-checked:border-amber-400 peer-checked:bg-amber-400 peer-checked:text-white peer-focus-visible:ring-2 peer-focus-visible:ring-amber-300"
              >
                ✓
              </span>
              🐣 경력 없음 (신입이에요)
            </label>

            {!noExperience && (
              <div className="mt-3">
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
              </div>
            )}
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
