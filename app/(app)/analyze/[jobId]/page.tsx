"use client";

import { use, useEffect, useMemo, useState } from "react";

import type { JudgmentVerdict } from "@/lib/ai/match-schemas";
import {
  getAnalysisJob,
  type AnalysisJobRow,
  type JobErrorCode,
  type JobStep,
} from "@/lib/db/analysis-jobs";
import { getLatestMatchAnalysis, type MatchAnalysisRow } from "@/lib/db/match-analyses";
import { getJobPostingById } from "@/lib/db/postings";
import { subscribeToAnalysisJob } from "@/lib/realtime/analysis-jobs";
import { createBrowserSupabaseClient } from "@/lib/supabase/browser";

/**
 * S6 — 분석 진행 + 결과 화면 (PRD 3.2, ARCHITECTURE.md 3.3)
 *
 * "동물 친구들의 모험" 컨셉: 분석 진행은 친구들이 차례로 일하는 여행길로,
 * 결과는 부엉 박사의 리포트로 표현한다. 데이터 로직은 그대로다 —
 * analysis_jobs 행을 Realtime으로 구독하고, done이면
 * posting → latest_extraction_id → match_analyses 최신 행을 읽는다 (RLS 본인).
 */

/** 진행 단계 = 여행길의 정거장 — 담당 친구와 대사 (PRD 2.2의 단계 표시) */
const JOURNEY_STATIONS: Array<{
  step: JobStep;
  emoji: string;
  label: string;
  saying: string;
}> = [
  { step: "queued", emoji: "🧳", label: "출발 준비", saying: "짐을 싸는 중이야…" },
  { step: "fetching", emoji: "🐿️", label: "공고 배달", saying: "다람이가 공고를 물어오는 중!" },
  { step: "extracting", emoji: "🦉", label: "꼼꼼 정리", saying: "부엉 박사가 정리하는 중…" },
  { step: "matching", emoji: "🐰", label: "나랑 비교", saying: "토돌이가 너와 비교하는 중!" },
  { step: "scoring", emoji: "🐢", label: "점수 계산", saying: "거북이가 신중하게 계산 중…" },
  { step: "done", emoji: "🏁", label: "도착!", saying: "다 왔어!" },
];

/** error_code → 친구들의 안내 (폴백 UI 분기 — ARCHITECTURE.md 3.3) */
const ERROR_MESSAGES: Record<JobErrorCode, string> = {
  fetch_failed: "다람이가 공고를 물어오지 못했어… 공고 본문을 직접 붙여넣어서 다시 시도해 줄래?",
  not_a_posting: "음, 이건 채용공고가 아닌 것 같아. URL이나 본문을 다시 확인해 줘!",
  llm_error: "분석하다가 발을 헛디뎠어… 잠시 후 다시 시도해 줘.",
  quota_exceeded: "오늘은 친구들이 너무 많이 일했어. 잠시 후 다시 시도해 줘!",
};

/** 등급 라벨 (AI_ANALYSIS_DESIGN.md 5.2 등급 구간) */
const GRADE_LABELS: Record<MatchAnalysisRow["grade"], string> = {
  recommend: "적극 추천",
  challenge: "도전 가능",
  prepare: "준비 필요",
  large_gap: "갭이 큼",
  insufficient_profile: "프로필 부족",
};

/** 등급별 파스텔 배지 색 — 긍정(민트)→중립(하늘)→주의(앰버)→부정(핑크)→정보(퍼플) */
const GRADE_BADGE_CLASSES: Record<MatchAnalysisRow["grade"], string> = {
  recommend: "bg-emerald-100 text-emerald-700",
  challenge: "bg-sky-100 text-sky-700",
  prepare: "bg-amber-100 text-amber-700",
  large_gap: "bg-rose-100 text-rose-700",
  insufficient_profile: "bg-violet-100 text-violet-700",
};

/** 등급별 부엉 박사의 한마디 */
const GRADE_SAYINGS: Record<MatchAnalysisRow["grade"], string> = {
  recommend: "훌륭해! 자신 있게 지원해 보자.",
  challenge: "해볼 만해! 몇 가지만 보완하면 돼.",
  prepare: "조금 더 준비하면 좋겠어. 같이 채워보자.",
  large_gap: "지금은 갭이 커. 하지만 길은 있어!",
  insufficient_profile: "네 프로필을 더 알려주면 정확하게 봐줄 수 있어.",
};

/** 판정 아이콘 (PRD 2.2: 충족 ✅ / 부분 충족 ⚠️ / 미충족 ❌ / 판단 불가 ❔) */
const VERDICT_BADGES: Record<JudgmentVerdict, { icon: string; label: string }> = {
  met: { icon: "✅", label: "충족" },
  partial: { icon: "⚠️", label: "부분 충족" },
  not_met: { icon: "❌", label: "미충족" },
  unknown: { icon: "❔", label: "판단 불가" },
};

/** 판정별 카드 강조색 */
const VERDICT_CARD_CLASSES: Record<JudgmentVerdict, string> = {
  met: "border-emerald-100 bg-emerald-50/60",
  partial: "border-amber-100 bg-amber-50/60",
  not_met: "border-rose-100 bg-rose-50/60",
  unknown: "border-violet-100 bg-violet-50/60",
};

/** 학습 우선순위별 파스텔 배지 색 */
const PRIORITY_BADGE_CLASSES: Record<"high" | "medium" | "low", string> = {
  high: "bg-rose-100 text-rose-700",
  medium: "bg-amber-100 text-amber-700",
  low: "bg-stone-100 text-stone-500",
};

export default function AnalysisJobPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = use(params);
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);

  const [job, setJob] = useState<AnalysisJobRow | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<MatchAnalysisRow | null>(null);
  const [resultError, setResultError] = useState<string | null>(null);

  // 구독을 먼저 열고 초기 상태를 1회 조회한다 (lib/realtime/analysis-jobs.ts 사용 규칙).
  // 조인 완료(SUBSCRIBED) 시점에 한 번 더 조회한다 — 초기 조회~조인 완료 사이의
  // 전이(예: scoring→done)를 놓치면 진행 화면이 이전 단계에 멈춘다 (M2-3 실측 레이스)
  useEffect(() => {
    // Realtime 이벤트와 재조회의 도착 순서 역전 대비 — 더 새로운 행만 반영한다
    const applyRow = (row: AnalysisJobRow): void => {
      setJob((current) =>
        current === null || new Date(row.updated_at) >= new Date(current.updated_at) ? row : current
      );
    };
    const fetchJob = (): void => {
      getAnalysisJob(supabase, jobId)
        .then((row) => {
          if (row === null) {
            setJobError("이 여행을 찾을 수 없어… 주소를 확인하거나 로그인 상태를 확인해 줘.");
          } else {
            applyRow(row);
          }
        })
        .catch(() => setJobError("진행 상황을 불러오지 못했어. 잠시 후 다시 시도해 줘."));
    };

    const unsubscribe = subscribeToAnalysisJob(supabase, jobId, applyRow, fetchJob);
    fetchJob();
    return unsubscribe;
  }, [supabase, jobId]);

  // done이 되면 결과를 조회한다: posting → latest_extraction_id → 최신 매칭 결과
  useEffect(() => {
    if (job?.step !== "done" || analysis !== null) return;
    let cancelled = false;

    (async () => {
      try {
        const posting = job.posting_id ? await getJobPostingById(supabase, job.posting_id) : null;
        const extractionId = posting?.latest_extraction_id ?? null;
        const row = extractionId ? await getLatestMatchAnalysis(supabase, extractionId) : null;
        if (cancelled) return;
        if (row === null) {
          setResultError("분석 결과를 찾을 수 없어…");
        } else {
          setAnalysis(row);
        }
      } catch {
        if (!cancelled) setResultError("분석 결과를 불러오지 못했어. 새로고침해 줄래?");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [job, analysis, supabase]);

  return (
    <main className="min-h-screen bg-gradient-to-b from-sky-100 via-[#fef6e4] to-[#fef6e4] px-4 py-10">
      <div className="mx-auto max-w-3xl">
        <h1 className="text-center text-2xl text-stone-700">공고 분석 여행 🗺️</h1>

        {jobError !== null ? (
          <SadFriendBox message={jobError} />
        ) : job === null ? (
          <p className="mt-10 text-center text-sm text-stone-400">
            <span className="animate-hop inline-block text-3xl" aria-hidden>
              🐾
            </span>
            <br />
            여행 소식을 확인하는 중…
          </p>
        ) : job.step === "failed" ? (
          <SadFriendBox
            message={
              job.error_code !== null
                ? ERROR_MESSAGES[job.error_code]
                : "분석에 실패했어… 다시 시도해 줄래?"
            }
            detail={job.error_code ?? undefined}
          />
        ) : (
          <>
            <JourneyTrail currentStep={job.step} />
            {job.step === "done" &&
              (analysis !== null ? (
                <AnalysisResult analysis={analysis} />
              ) : resultError !== null ? (
                <SadFriendBox message={resultError} />
              ) : (
                <p className="mt-6 text-center text-sm text-stone-400">
                  부엉 박사가 리포트를 정리하는 중…
                </p>
              ))}
          </>
        )}
      </div>
    </main>
  );
}

/** 실패·오류 — 친구가 미안해하는 카드 */
function SadFriendBox({ message, detail }: { message: string; detail?: string }) {
  return (
    <div className="mx-auto mt-10 max-w-md text-center">
      <div className="animate-float text-6xl" aria-hidden>
        🥺
      </div>
      <div className="bubble bubble-center mt-5 text-sm text-stone-600">{message}</div>
      {detail !== undefined && <p className="mt-3 text-xs text-stone-300">오류 코드: {detail}</p>}
    </div>
  );
}

/**
 * 진행 상태 = 여행길 — 정거장마다 담당 친구가 있고, 현재 정거장의 친구가
 * 폴짝폴짝 일한다(hop, transform 전용). 캐시 히트로 건너뛴 단계는 지나간 것으로 표시.
 */
function JourneyTrail({ currentStep }: { currentStep: JobStep }) {
  const currentIndex = JOURNEY_STATIONS.findIndex((s) => s.step === currentStep);
  const current = JOURNEY_STATIONS[currentIndex];

  return (
    <div className="mt-8 rounded-[2rem] border-2 border-amber-100 bg-white p-6 shadow-[0_4px_0_#fde68a]">
      <ol className="flex items-start justify-between">
        {JOURNEY_STATIONS.map(({ step, emoji, label }, index) => {
          const isDone = index < currentIndex || currentStep === "done";
          const isCurrent = index === currentIndex && currentStep !== "done";
          return (
            <li key={step} className="flex flex-1 flex-col items-center text-center">
              <div className="flex w-full items-center">
                {/* 정거장 사이 길 (점선) */}
                <span
                  aria-hidden
                  className={`h-0.5 flex-1 border-t-2 border-dashed ${
                    index === 0
                      ? "border-transparent"
                      : isDone || isCurrent
                        ? "border-amber-300"
                        : "border-stone-200"
                  }`}
                />
                <span
                  aria-hidden
                  className={`flex h-12 w-12 items-center justify-center rounded-full border-2 text-2xl ${
                    isDone
                      ? "border-emerald-200 bg-emerald-50"
                      : isCurrent
                        ? "animate-hop border-amber-300 bg-amber-50"
                        : "border-stone-200 bg-stone-50 opacity-50 grayscale"
                  }`}
                >
                  {isDone ? "✅" : emoji}
                </span>
                <span
                  aria-hidden
                  className={`h-0.5 flex-1 border-t-2 border-dashed ${
                    index === JOURNEY_STATIONS.length - 1
                      ? "border-transparent"
                      : isDone
                        ? "border-amber-300"
                        : "border-stone-200"
                  }`}
                />
              </div>
              <span
                className={`mt-2 text-[11px] leading-tight sm:text-xs ${
                  isCurrent ? "text-amber-600" : isDone ? "text-stone-400" : "text-stone-300"
                }`}
              >
                {label}
              </span>
            </li>
          );
        })}
      </ol>

      {current !== undefined && currentStep !== "done" && (
        <p className="mt-5 text-center text-sm text-stone-500">
          <span className="animate-wiggle inline-block" aria-hidden>
            {current.emoji}
          </span>{" "}
          {current.saying}
        </p>
      )}
    </div>
  );
}

function AnalysisResult({ analysis }: { analysis: MatchAnalysisRow }) {
  const { result } = analysis;
  return (
    <div className="mt-8 space-y-6">
      {/* 부엉 박사의 리포트 — 결론 먼저 (PRD S6 상단) */}
      <section className="animate-pop-in rounded-[2rem] border-2 border-amber-100 bg-white p-6 text-center shadow-[0_4px_0_#fde68a]">
        <div className="text-5xl" aria-hidden>
          🦉
        </div>
        <p className="mt-1 text-xs text-amber-500">부엉 박사의 리포트</p>
        <div className="mt-4 flex flex-wrap items-baseline justify-center gap-3">
          <span className="text-5xl text-stone-700">
            {analysis.score !== null ? `${analysis.score}점` : "점수 없음"}
          </span>
          <span className={`rounded-full px-3 py-1 text-sm ${GRADE_BADGE_CLASSES[analysis.grade]}`}>
            {GRADE_LABELS[analysis.grade]}
          </span>
          {analysis.critical_gap_count > 0 && (
            <span className="rounded-full bg-rose-100 px-3 py-1 text-xs text-rose-700">
              필수요건 미충족 {analysis.critical_gap_count}건
            </span>
          )}
        </div>
        <div className="bubble bubble-center mx-auto mt-5 max-w-md text-left text-sm text-stone-600">
          {GRADE_SAYINGS[analysis.grade]} {result.overall_comment}
        </div>
        {analysis.grade === "insufficient_profile" && (
          <p className="mt-3 text-xs text-stone-400">
            프로필에 정보가 부족해서 점수를 낼 수 없었어. 프로필을 채우면 더 정확해져!
          </p>
        )}
      </section>

      {/* 요건별 판정 (매칭 상세) */}
      <ResultSection emoji="📋" title="요건별 판정">
        <ul className="space-y-3">
          {result.requirement_judgments.map((judgment) => {
            const badge = VERDICT_BADGES[judgment.verdict];
            return (
              <li
                key={judgment.requirement_text}
                className={`rounded-2xl border-2 p-3 ${VERDICT_CARD_CLASSES[judgment.verdict]}`}
              >
                <div className="flex items-start gap-2 text-sm">
                  <span aria-label={badge.label}>{badge.icon}</span>
                  <div>
                    <p className="text-stone-700">{judgment.requirement_text}</p>
                    <p className="mt-1 text-stone-500">{judgment.reason}</p>
                    {judgment.profile_evidence !== null && (
                      <p className="mt-1 text-xs text-stone-400">
                        근거: {judgment.profile_evidence}
                      </p>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </ResultSection>

      {result.strengths.length > 0 && (
        <ResultSection emoji="💪" title="너의 강점">
          <ul className="space-y-2 text-sm">
            {result.strengths.map((item) => (
              <li key={item.strength} className="flex gap-2">
                <span aria-hidden className="mt-0.5">
                  🌟
                </span>
                <p>
                  <span className="text-stone-700">{item.strength}</span>
                  <span className="text-stone-500"> — {item.how_to_appeal}</span>
                </p>
              </li>
            ))}
          </ul>
        </ResultSection>
      )}

      {result.gaps.length > 0 && (
        <ResultSection emoji="🌱" title="같이 채워갈 부분">
          <ul className="space-y-2 text-sm">
            {result.gaps.map((item) => (
              <li key={item.gap} className="flex items-start gap-2">
                <span aria-hidden className="mt-0.5">
                  🍃
                </span>
                <p>
                  <span className="text-stone-700">{item.gap}</span>
                  {item.severity === "critical" && (
                    <span className="ml-2 rounded-full bg-rose-100 px-2 py-0.5 text-xs text-rose-700">
                      필수
                    </span>
                  )}
                </p>
              </li>
            ))}
          </ul>
        </ResultSection>
      )}

      {result.skills_to_learn.length > 0 && (
        <ResultSection emoji="📚" title="공부하면 좋을 기술">
          <ul className="space-y-2 text-sm">
            {result.skills_to_learn.map((item) => (
              <li key={item.skill} className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-stone-700">{item.skill}</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs ${PRIORITY_BADGE_CLASSES[item.priority]}`}
                >
                  {item.priority}
                </span>
                <span className="text-stone-500"> — {item.suggestion}</span>
              </li>
            ))}
          </ul>
        </ResultSection>
      )}

      {result.expected_interview_questions.length > 0 && (
        <ResultSection emoji="🎤" title="예상 면접 질문">
          <ul className="space-y-3 text-sm">
            {result.expected_interview_questions.map((item) => (
              <li
                key={item.question}
                className="rounded-2xl border-2 border-violet-100 bg-violet-50/50 p-3"
              >
                <p className="text-stone-700">{item.question}</p>
                <p className="mt-1 text-xs text-violet-500">의도: {item.intent}</p>
              </li>
            ))}
          </ul>
        </ResultSection>
      )}

      {/* 신뢰 장치 (PRD S6) */}
      <p className="pt-2 text-center text-xs text-stone-400">
        친구들의 분석은 참고용이에요. 최종 판단은 공고 원문을 확인한 뒤 해주세요.
      </p>
    </div>
  );
}

function ResultSection({
  emoji,
  title,
  children,
}: {
  emoji: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[2rem] border-2 border-amber-100 bg-white p-6 shadow-[0_4px_0_#fde68a]">
      <h2 className="mb-4 text-base text-stone-700">
        <span aria-hidden>{emoji}</span> {title}
      </h2>
      {children}
    </section>
  );
}
