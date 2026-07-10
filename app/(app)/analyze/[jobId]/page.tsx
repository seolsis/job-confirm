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
 * POST /api/analyses가 돌려준 jobId로 진입한다 (/analyze/{jobId}).
 * 진행 상태는 응답이 아니라 analysis_jobs 행을 Realtime으로 구독해 표시하므로
 * 새로고침·이탈 후에도 같은 URL로 다시 붙을 수 있다.
 *
 * 결과 조회 경로: job.posting_id → job_postings.latest_extraction_id
 * → match_analyses 최신 행. 전부 browser 클라이언트 + RLS(본인만 select)로 읽는다.
 */

/** 진행 단계 표시 순서·라벨 (PRD 2.2: 공고 수집 중 → 분석 중 → 프로필 비교 중) */
const PROGRESS_STEPS: Array<{ step: JobStep; label: string }> = [
  { step: "queued", label: "대기 중" },
  { step: "fetching", label: "공고 수집 중" },
  { step: "extracting", label: "공고 정리 중" },
  { step: "matching", label: "프로필 비교 중" },
  { step: "scoring", label: "적합도 계산 중" },
  { step: "done", label: "완료" },
];

/** error_code → 사용자 안내 (폴백 UI 분기 — ARCHITECTURE.md 3.3) */
const ERROR_MESSAGES: Record<JobErrorCode, string> = {
  fetch_failed: "공고를 가져오지 못했습니다. 공고 본문을 직접 붙여넣어 다시 시도해 주세요.",
  not_a_posting: "입력하신 내용이 채용공고가 아닌 것 같습니다. URL이나 본문을 확인해 주세요.",
  llm_error: "분석 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.",
  quota_exceeded: "무료 분석 한도를 초과했습니다. 잠시 후 다시 시도해 주세요.",
};

/** 등급 라벨 (AI_ANALYSIS_DESIGN.md 5.2 등급 구간) */
const GRADE_LABELS: Record<MatchAnalysisRow["grade"], string> = {
  recommend: "적극 추천",
  challenge: "도전 가능",
  prepare: "준비 필요",
  large_gap: "갭이 큼",
  insufficient_profile: "프로필 부족",
};

/** 등급별 파스텔 배지 색 — 긍정(민트)→중립(블루)→주의(앰버)→부정(핑크)→정보(퍼플) */
const GRADE_BADGE_CLASSES: Record<MatchAnalysisRow["grade"], string> = {
  recommend: "bg-emerald-100 text-emerald-700",
  challenge: "bg-indigo-100 text-indigo-700",
  prepare: "bg-amber-100 text-amber-700",
  large_gap: "bg-rose-100 text-rose-700",
  insufficient_profile: "bg-violet-100 text-violet-700",
};

/** 판정 아이콘 (PRD 2.2: 충족 ✅ / 부분 충족 ⚠️ / 미충족 ❌ / 판단 불가 ❔) */
const VERDICT_BADGES: Record<JudgmentVerdict, { icon: string; label: string }> = {
  met: { icon: "✅", label: "충족" },
  partial: { icon: "⚠️", label: "부분 충족" },
  not_met: { icon: "❌", label: "미충족" },
  unknown: { icon: "❔", label: "판단 불가" },
};

/** 판정별 카드 강조색 — 아이콘 칩 배경 + 좌측 보더 */
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
  low: "bg-slate-100 text-slate-600",
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
            setJobError("분석을 찾을 수 없습니다. 주소를 확인하거나 로그인 상태를 확인해 주세요.");
          } else {
            applyRow(row);
          }
        })
        .catch(() => setJobError("분석 상태를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요."));
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
          setResultError("분석 결과를 찾을 수 없습니다.");
        } else {
          setAnalysis(row);
        }
      } catch {
        if (!cancelled) setResultError("분석 결과를 불러오지 못했습니다.");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [job, analysis, supabase]);

  return (
    <main className="min-h-screen bg-gradient-to-br from-indigo-50 via-white to-violet-50 px-4 py-10">
      <div className="mx-auto max-w-3xl">
        <h1 className="text-2xl font-bold text-slate-800">공고 분석</h1>

        {jobError !== null ? (
          <ErrorBox message={jobError} />
        ) : job === null ? (
          <p className="mt-6 text-sm text-slate-500">분석 상태를 불러오는 중…</p>
        ) : job.step === "failed" ? (
          <ErrorBox
            message={
              job.error_code !== null
                ? ERROR_MESSAGES[job.error_code]
                : "분석에 실패했습니다. 다시 시도해 주세요."
            }
            detail={job.error_code ?? undefined}
          />
        ) : (
          <>
            <ProgressList currentStep={job.step} />
            {job.step === "done" &&
              (analysis !== null ? (
                <AnalysisResult analysis={analysis} />
              ) : resultError !== null ? (
                <ErrorBox message={resultError} />
              ) : (
                <p className="mt-6 text-sm text-slate-500">결과를 불러오는 중…</p>
              ))}
          </>
        )}
      </div>
    </main>
  );
}

function ErrorBox({ message, detail }: { message: string; detail?: string }) {
  return (
    <div className="mt-6 rounded-2xl border border-rose-100 bg-rose-50 p-4 text-sm text-rose-700">
      <p>{message}</p>
      {detail !== undefined && <p className="mt-1 text-xs text-rose-400">오류 코드: {detail}</p>}
    </div>
  );
}

/** 진행 단계 목록 — 현재 단계까지 완료 표시 (캐시 히트로 건너뛴 단계도 지난 것으로 표시) */
function ProgressList({ currentStep }: { currentStep: JobStep }) {
  const currentIndex = PROGRESS_STEPS.findIndex((s) => s.step === currentStep);
  return (
    <ol className="mt-6 space-y-2 rounded-2xl border border-slate-100 bg-white p-5 shadow-sm shadow-slate-100">
      {PROGRESS_STEPS.map(({ step, label }, index) => {
        const isDone = index < currentIndex || currentStep === "done";
        const isCurrent = index === currentIndex && currentStep !== "done";
        return (
          <li
            key={step}
            className={`flex items-center gap-2 text-sm ${
              isDone
                ? "text-slate-400"
                : isCurrent
                  ? "font-semibold text-indigo-600"
                  : "text-slate-300"
            }`}
          >
            <span
              aria-hidden
              className={`flex h-5 w-5 items-center justify-center rounded-full text-xs ${
                isDone
                  ? "bg-emerald-100 text-emerald-600"
                  : isCurrent
                    ? "animate-pulse bg-indigo-100 text-indigo-600"
                    : "bg-slate-100 text-slate-300"
              }`}
            >
              {isDone ? "✓" : isCurrent ? "●" : "○"}
            </span>
            {label}
            {isCurrent && <span className="animate-pulse">…</span>}
          </li>
        );
      })}
    </ol>
  );
}

function AnalysisResult({ analysis }: { analysis: MatchAnalysisRow }) {
  const { result } = analysis;
  return (
    <div className="mt-8 space-y-6">
      {/* 결론 먼저: 점수 + 등급 + 종합 코멘트 (PRD S6 상단) */}
      <section className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm shadow-slate-100">
        <div className="flex flex-wrap items-baseline gap-3">
          <span className="text-4xl font-bold text-slate-800">
            {analysis.score !== null ? `${analysis.score}점` : "점수 없음"}
          </span>
          <span
            className={`rounded-full px-3 py-1 text-sm font-medium ${GRADE_BADGE_CLASSES[analysis.grade]}`}
          >
            {GRADE_LABELS[analysis.grade]}
          </span>
          {analysis.critical_gap_count > 0 && (
            <span className="rounded-full bg-rose-100 px-3 py-1 text-xs font-medium text-rose-700">
              필수요건 미충족 {analysis.critical_gap_count}건
            </span>
          )}
        </div>
        <p className="mt-3 text-sm text-slate-600">{result.overall_comment}</p>
        {analysis.grade === "insufficient_profile" && (
          <p className="mt-2 text-xs text-slate-400">
            프로필에 정보가 부족해 점수를 낼 수 없었습니다. 프로필을 채우면 분석이 정확해집니다.
          </p>
        )}
      </section>

      {/* 요건별 판정 (매칭 상세) */}
      <ResultSection title="요건별 판정">
        <ul className="space-y-3">
          {result.requirement_judgments.map((judgment) => {
            const badge = VERDICT_BADGES[judgment.verdict];
            return (
              <li
                key={judgment.requirement_text}
                className={`rounded-xl border p-3 ${VERDICT_CARD_CLASSES[judgment.verdict]}`}
              >
                <div className="flex items-start gap-2 text-sm">
                  <span aria-label={badge.label}>{badge.icon}</span>
                  <div>
                    <p className="font-medium text-slate-800">{judgment.requirement_text}</p>
                    <p className="mt-1 text-slate-600">{judgment.reason}</p>
                    {judgment.profile_evidence !== null && (
                      <p className="mt-1 text-xs text-slate-400">
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
        <ResultSection title="강점">
          <ul className="space-y-2 text-sm">
            {result.strengths.map((item) => (
              <li key={item.strength} className="flex gap-2">
                <span aria-hidden className="mt-1 text-emerald-400">
                  ●
                </span>
                <p>
                  <span className="font-medium text-slate-800">{item.strength}</span>
                  <span className="text-slate-600"> — {item.how_to_appeal}</span>
                </p>
              </li>
            ))}
          </ul>
        </ResultSection>
      )}

      {result.gaps.length > 0 && (
        <ResultSection title="보완점">
          <ul className="space-y-2 text-sm">
            {result.gaps.map((item) => (
              <li key={item.gap} className="flex items-start gap-2">
                <span aria-hidden className="mt-1 text-rose-300">
                  ●
                </span>
                <p>
                  <span className="font-medium text-slate-800">{item.gap}</span>
                  {item.severity === "critical" && (
                    <span className="ml-2 rounded-full bg-rose-100 px-2 py-0.5 text-xs font-medium text-rose-700">
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
        <ResultSection title="공부하면 좋을 기술">
          <ul className="space-y-2 text-sm">
            {result.skills_to_learn.map((item) => (
              <li key={item.skill} className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium text-slate-800">{item.skill}</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${PRIORITY_BADGE_CLASSES[item.priority]}`}
                >
                  {item.priority}
                </span>
                <span className="text-slate-600"> — {item.suggestion}</span>
              </li>
            ))}
          </ul>
        </ResultSection>
      )}

      {result.expected_interview_questions.length > 0 && (
        <ResultSection title="예상 면접 질문">
          <ul className="space-y-3 text-sm">
            {result.expected_interview_questions.map((item) => (
              <li
                key={item.question}
                className="rounded-xl border border-violet-100 bg-violet-50/50 p-3"
              >
                <p className="font-medium text-slate-800">{item.question}</p>
                <p className="mt-1 text-xs text-violet-500">의도: {item.intent}</p>
              </li>
            ))}
          </ul>
        </ResultSection>
      )}

      {/* 신뢰 장치 (PRD S6) */}
      <p className="border-t border-slate-100 pt-4 text-xs text-slate-400">
        AI 분석은 참고용입니다. 최종 판단은 공고 원문을 확인한 뒤 해주세요.
      </p>
    </div>
  );
}

function ResultSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm shadow-slate-100">
      <h2 className="mb-3 text-base font-semibold text-slate-800">{title}</h2>
      {children}
    </section>
  );
}
