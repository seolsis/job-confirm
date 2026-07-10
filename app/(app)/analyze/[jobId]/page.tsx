"use client";

import Link from "next/link";
import { use, useEffect, useMemo, useState } from "react";

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

import { AnalysisResult } from "../../analysis-result";

/**
 * S6 — 분석 진행 + 결과 화면 (PRD 3.2, ARCHITECTURE.md 3.3)
 *
 * "동물 친구들의 모험" 컨셉: 분석 진행은 친구들이 차례로 일하는 여행길로,
 * 결과는 부엉 박사의 리포트(공용 AnalysisResult)로 표현한다. 데이터 로직:
 * analysis_jobs 행을 Realtime으로 구독하고, done이면
 * posting → latest_extraction_id → match_analyses 최신 행을 읽는다 (RLS 본인).
 * 결과 하단의 [취준탭에 저장]이 M3의 진입점이다 (PRD 2.2 마지막 단계).
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
          <>
            <SadFriendBox
              message={
                job.error_code !== null
                  ? ERROR_MESSAGES[job.error_code]
                  : "분석에 실패했어… 다시 시도해 줄래?"
              }
              detail={job.error_code ?? undefined}
            />
            {/* 다음 행동 안내 — 수집 실패류는 붙여넣기 폴백으로 바로 보낸다 (PRD 7.1) */}
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              {(job.error_code === "fetch_failed" || job.error_code === "not_a_posting") && (
                <Link
                  href="/analyze?mode=paste"
                  className="rounded-full bg-amber-300 px-6 py-3 text-sm text-amber-950 shadow-[0_4px_0_#f59e0b] transition-transform hover:-translate-y-0.5 active:translate-y-0.5 active:shadow-none"
                >
                  📋 본문 붙여넣기로 다시 해볼래
                </Link>
              )}
              <Link
                href="/analyze"
                className="rounded-full border-2 border-amber-200 bg-white px-6 py-3 text-sm text-stone-600 transition-transform hover:-translate-y-0.5"
              >
                다른 공고 분석하기
              </Link>
            </div>
          </>
        ) : (
          <>
            <JourneyTrail currentStep={job.step} />
            {job.step === "done" &&
              (analysis !== null ? (
                <>
                  <AnalysisResult analysis={analysis} />
                  <SaveToBoardButton analysisId={analysis.id} />
                </>
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

/** [취준탭에 저장] — 분석 결과를 보드 카드로 (M3-2, 기본 상태 '관심 공고') */
function SaveToBoardButton({ analysisId }: { analysisId: string }) {
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "saving" }
    | { kind: "saved"; applicationId: string; alreadySaved: boolean }
    | { kind: "error" }
  >({ kind: "idle" });

  async function handleSave() {
    setState({ kind: "saving" });
    try {
      const response = await fetch("/api/applications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ analysisId }),
      });
      const data = (await response.json()) as { applicationId?: string; alreadySaved?: boolean };
      if (typeof data.applicationId === "string") {
        setState({
          kind: "saved",
          applicationId: data.applicationId,
          alreadySaved: data.alreadySaved === true,
        });
      } else {
        setState({ kind: "error" });
      }
    } catch {
      setState({ kind: "error" });
    }
  }

  if (state.kind === "saved") {
    return (
      <div className="mt-6 text-center">
        <p className="text-sm text-stone-500">
          {state.alreadySaved
            ? "이미 보드에 있던 공고야 — 최신 분석으로 이어뒀어!"
            : "보드에 담았어! 🎒"}
        </p>
        <div className="mt-3 flex justify-center gap-3">
          <Link
            href={`/board/${state.applicationId}`}
            className="rounded-full bg-amber-300 px-6 py-3 text-sm text-amber-950 shadow-[0_4px_0_#f59e0b] transition-transform hover:-translate-y-0.5 active:translate-y-0.5 active:shadow-none"
          >
            🗂️ 카드 보러 가기
          </Link>
          <Link
            href="/analyze"
            className="rounded-full border-2 border-amber-200 bg-white px-6 py-3 text-sm text-stone-600 transition-transform hover:-translate-y-0.5"
          >
            다른 공고 분석하기
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-6 text-center">
      <button
        type="button"
        onClick={handleSave}
        disabled={state.kind === "saving"}
        className="rounded-full bg-amber-300 px-8 py-3.5 text-sm text-amber-950 shadow-[0_4px_0_#f59e0b] transition-transform hover:-translate-y-0.5 active:translate-y-0.5 active:shadow-none disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none"
      >
        {state.kind === "saving" ? "담는 중… 🎒" : "🎒 취준탭에 저장하기"}
      </button>
      {state.kind === "error" && (
        <p className="mt-2 text-xs text-rose-500">저장에 실패했어… 다시 눌러 줄래?</p>
      )}
    </div>
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
