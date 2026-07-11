"use client";

import Link from "next/link";
import { use, useEffect, useMemo, useState } from "react";

import {
  APPLICATION_STATUSES,
  daysUntil,
  getApplicationCard,
  updateApplicationMemo,
  updateApplicationSchedule,
  updateApplicationStatus,
  type ApplicationCard,
  type ApplicationStatus,
  type ScheduleEntry,
} from "@/lib/db/applications";
import { getMatchAnalysisById, type MatchAnalysisRow } from "@/lib/db/match-analyses";
import { createBrowserSupabaseClient } from "@/lib/supabase/browser";

import { AnalysisResult } from "../../analysis-result";
import { REJECTED_STAGES, STATUS_META } from "../status-meta";

/**
 * S8 — 공고 카드 상세 (M3-4, PRD 3.1).
 *
 * 분석 결과 다시 보기(공용 AnalysisResult), 메모 작성, 상태 변경(6단계 자유 이동 —
 * 불합격 선택 시 탈락 단계 기록), 마감 D-day, 원문 링크.
 * 상태·메모는 RLS가 허용하는 클라이언트 직접 update (이력은 DB 트리거).
 */
export default function ApplicationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);

  const [card, setCard] = useState<ApplicationCard | null>(null);
  const [analysis, setAnalysis] = useState<MatchAnalysisRow | null>(null);
  const [showAnalysis, setShowAnalysis] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [memo, setMemo] = useState("");
  const [memoSaved, setMemoSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const loaded = await getApplicationCard(supabase, id);
        if (loaded === null) {
          setError("카드를 찾을 수 없어… 주소를 확인하거나 로그인 상태를 확인해 줘.");
        } else {
          setCard(loaded);
          setMemo(loaded.application.memo ?? "");
          if (loaded.application.latest_analysis_id !== null) {
            // 분석 결과는 미리 받아두고 [다시 보기]로 펼친다
            const analysisRow = await getMatchAnalysisById(
              supabase,
              loaded.application.latest_analysis_id
            );
            setAnalysis(analysisRow);
          }
        }
      } catch {
        setError("카드를 불러오지 못했어. 새로고침해 줄래?");
      }
      setLoading(false);
    })();
  }, [supabase, id]);

  async function handleStatusChange(status: ApplicationStatus, rejectedAtStage?: string) {
    if (card === null) return;
    const previous = card.application;
    // 낙관적 반영
    setCard({
      ...card,
      application: {
        ...previous,
        status,
        rejected_at_stage:
          status === "rejected" ? (rejectedAtStage ?? previous.rejected_at_stage) : null,
      },
    });
    try {
      const updated = await updateApplicationStatus(supabase, previous.id, status, {
        rejectedAtStage:
          status === "rejected"
            ? (rejectedAtStage ?? previous.rejected_at_stage ?? STATUS_META[previous.status].label)
            : null,
      });
      setCard((current) => (current === null ? null : { ...current, application: updated }));
    } catch {
      setCard((current) => (current === null ? null : { ...current, application: previous }));
      setError("상태를 저장하지 못했어… 잠시 후 다시 시도해 줘.");
    }
  }

  async function handleMemoSave() {
    if (card === null) return;
    setSaving(true);
    setMemoSaved(false);
    try {
      const updated = await updateApplicationMemo(supabase, card.application.id, memo);
      setCard((current) => (current === null ? null : { ...current, application: updated }));
      setMemoSaved(true);
    } catch {
      setError("메모를 저장하지 못했어… 잠시 후 다시 시도해 줘.");
    }
    setSaving(false);
  }

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-sky-100 via-[#fef6e4] to-[#fef6e4] px-4">
        <p className="text-center text-sm text-stone-400">
          <span className="animate-hop inline-block text-3xl" aria-hidden>
            🐾
          </span>
          <br />
          카드를 펼치는 중…
        </p>
      </main>
    );
  }

  if (card === null) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-sky-100 via-[#fef6e4] to-[#fef6e4] px-4">
        <div className="text-center">
          <div className="animate-float text-6xl" aria-hidden>
            🥺
          </div>
          <div className="bubble bubble-center mx-auto mt-5 max-w-xs text-sm text-stone-600">
            {error ?? "카드를 찾을 수 없어…"}
          </div>
          <Link href="/board" className="mt-6 inline-block text-sm text-amber-600 underline">
            보드로 돌아가기
          </Link>
        </div>
      </main>
    );
  }

  const dday = daysUntil(card.deadline_date);
  const status = card.application.status;

  return (
    <main className="min-h-screen bg-gradient-to-b from-sky-100 via-[#fef6e4] to-[#fef6e4] px-4 py-10">
      <div className="mx-auto max-w-3xl">
        <Link
          href="/board"
          className="text-sm text-stone-400 transition-colors hover:text-stone-600"
        >
          ← 보드로 돌아가기
        </Link>

        {/* 카드 헤더 — 회사/직무/마감/원문 (PRD S8) */}
        <section className="mt-4 rounded-[2rem] border-2 border-amber-100 bg-white p-6 shadow-[0_4px_0_#fde68a]">
          <p className="text-sm text-stone-400">{card.company_name ?? "회사명 없음"}</p>
          <h1 className="mt-1 text-xl text-stone-700">{card.job_title ?? "직무 정보 없음"}</h1>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            {dday !== null &&
              (dday < 0 ? (
                <span className="rounded-full bg-stone-100 px-2.5 py-1 text-stone-400">마감됨</span>
              ) : (
                <span
                  className={`rounded-full px-2.5 py-1 ${
                    dday <= 3 ? "bg-rose-100 font-medium text-rose-600" : "bg-sky-50 text-sky-600"
                  }`}
                >
                  {dday === 0 ? "오늘 마감!" : `마감까지 D-${dday}`}
                </span>
              ))}
            {card.url !== null && (
              <a
                href={card.url}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-full border-2 border-amber-100 bg-white px-2.5 py-1 text-stone-500 transition-colors hover:text-stone-700"
              >
                공고 원문 보기 ↗
              </a>
            )}
          </div>

          {/* 상태 변경 — 6단계 자유 이동 (PRD 2.3) */}
          <div className="mt-5">
            <p className="text-xs text-stone-400">지금 어느 정거장이야?</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {APPLICATION_STATUSES.map((candidate) => {
                const meta = STATUS_META[candidate];
                const active = candidate === status;
                return (
                  <button
                    key={candidate}
                    type="button"
                    onClick={() => void handleStatusChange(candidate)}
                    className={`rounded-full px-3 py-1.5 text-xs transition-colors ${
                      active
                        ? "bg-amber-300 text-amber-950"
                        : "border-2 border-amber-100 bg-white text-stone-500 hover:bg-amber-50"
                    }`}
                  >
                    {meta.emoji} {meta.label}
                  </button>
                );
              })}
            </div>

            {/* 불합격 시 탈락 단계 기록 (전환율 통계의 재료 — PRD 2.3) */}
            {status === "rejected" && (
              <div className="mt-3 rounded-2xl border-2 border-stone-100 bg-stone-50/60 p-3">
                <p className="text-xs text-stone-500">어느 단계에서 아쉬웠어? (통계에 쓰여)</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {REJECTED_STAGES.map((stage) => (
                    <button
                      key={stage}
                      type="button"
                      onClick={() => void handleStatusChange("rejected", stage)}
                      className={`rounded-full px-3 py-1 text-xs ${
                        card.application.rejected_at_stage === stage
                          ? "bg-stone-400 text-white"
                          : "border-2 border-stone-200 bg-white text-stone-500"
                      }`}
                    >
                      {stage}
                    </button>
                  ))}
                  {card.application.rejected_at_stage !== null &&
                    !REJECTED_STAGES.includes(
                      card.application.rejected_at_stage as (typeof REJECTED_STAGES)[number]
                    ) && (
                      <span className="rounded-full bg-stone-400 px-3 py-1 text-xs text-white">
                        {card.application.rejected_at_stage}
                      </span>
                    )}
                </div>
              </div>
            )}
          </div>
        </section>

        {/* 일정 (P1, PRD S8 — 면접일·시험일 입력, 보드 카드에 다가오는 일정 칩) */}
        <ScheduleSection
          applicationId={card.application.id}
          schedule={card.application.schedule}
          onSaved={(schedule) =>
            setCard((current) =>
              current === null
                ? null
                : { ...current, application: { ...current.application, schedule } }
            )
          }
          onError={() => setError("일정을 저장하지 못했어… 잠시 후 다시 시도해 줘.")}
        />

        {/* 메모 (PRD S8 — 지원 이유, 면접 후기 등) */}
        <section className="mt-6 rounded-[2rem] border-2 border-amber-100 bg-white p-6 shadow-[0_4px_0_#fde68a]">
          <h2 className="text-base text-stone-700">📝 메모</h2>
          <textarea
            rows={5}
            placeholder="지원 이유, 준비할 것, 면접 후기… 뭐든 적어둬!"
            value={memo}
            onChange={(e) => {
              setMemo(e.target.value);
              setMemoSaved(false);
            }}
            className="mt-3 w-full rounded-2xl border-2 border-amber-100 bg-white px-4 py-3 text-sm text-stone-700 outline-none placeholder:text-stone-300 focus:border-amber-300"
          />
          <div className="mt-2 flex items-center justify-between">
            <span className="text-xs text-emerald-600">{memoSaved ? "✅ 저장했어!" : ""}</span>
            <button
              type="button"
              onClick={() => void handleMemoSave()}
              disabled={saving}
              className="rounded-full bg-amber-300 px-5 py-2 text-xs text-amber-950 shadow-[0_3px_0_#f59e0b] transition-transform hover:-translate-y-0.5 active:translate-y-0.5 active:shadow-none disabled:opacity-60"
            >
              {saving ? "저장 중…" : "메모 저장"}
            </button>
          </div>
        </section>

        {/* 분석 결과 다시 보기 (PRD S8) */}
        {analysis !== null && (
          <section className="mt-6">
            <button
              type="button"
              onClick={() => setShowAnalysis((v) => !v)}
              className="w-full rounded-full border-2 border-amber-200 bg-white py-3 text-sm text-stone-600 transition-transform hover:-translate-y-0.5"
            >
              🦉 부엉 박사의 분석 리포트 {showAnalysis ? "접기 ▲" : "다시 보기 ▼"}
            </button>
            {showAnalysis && <AnalysisResult analysis={analysis} />}
          </section>
        )}

        {error !== null && card !== null && (
          <p className="mt-4 rounded-2xl border-2 border-rose-100 bg-rose-50 px-4 py-3 text-sm text-rose-600">
            🥺 {error}
          </p>
        )}
      </div>
    </main>
  );
}

/** 일정 종류 선택지 (P1) — 보드 카드 칩(SCHEDULE_ICONS)과 동일 분류 */
const SCHEDULE_TYPES = [
  { value: "interview", label: "🎤 면접" },
  { value: "test", label: "✏️ 시험" },
  { value: "deadline", label: "⏰ 마감" },
  { value: "other", label: "📅 기타" },
] as const;

/** 일정 입력 (P1, PRD S8) — 추가/삭제 시 즉시 저장한다 (RLS 본인 update) */
function ScheduleSection({
  applicationId,
  schedule,
  onSaved,
  onError,
}: {
  applicationId: string;
  schedule: ScheduleEntry[];
  onSaved: (schedule: ScheduleEntry[]) => void;
  onError: () => void;
}) {
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);
  const [type, setType] = useState<string>("interview");
  const [date, setDate] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  async function save(next: ScheduleEntry[]) {
    setSaving(true);
    try {
      const updated = await updateApplicationSchedule(supabase, applicationId, next);
      onSaved(updated.schedule);
    } catch {
      onError();
    }
    setSaving(false);
  }

  async function handleAdd() {
    if (date === "") return;
    const entry: ScheduleEntry = { type, at: date };
    const trimmed = note.trim();
    if (trimmed !== "") entry.note = trimmed;
    await save([...schedule, entry].sort((a, b) => a.at.localeCompare(b.at)));
    setDate("");
    setNote("");
  }

  const sorted = [...schedule].sort((a, b) => a.at.localeCompare(b.at));

  return (
    <section className="mt-6 rounded-[2rem] border-2 border-amber-100 bg-white p-6 shadow-[0_4px_0_#fde68a]">
      <h2 className="text-base text-stone-700">📅 일정</h2>

      {sorted.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {sorted.map((entry, index) => {
            const dday = daysUntil(entry.at);
            const typeLabel =
              SCHEDULE_TYPES.find((t) => t.value === entry.type)?.label ?? `📅 ${entry.type}`;
            return (
              <li
                key={`${entry.at}-${entry.type}-${index}`}
                className="flex items-center justify-between gap-2 rounded-2xl border-2 border-amber-50 bg-amber-50/50 px-4 py-2.5 text-sm"
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-stone-700">{typeLabel}</span>
                  <span className="text-stone-500">{entry.at}</span>
                  {dday !== null && dday >= 0 && (
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] ${
                        dday <= 3 ? "bg-rose-100 text-rose-600" : "bg-sky-50 text-sky-600"
                      }`}
                    >
                      {dday === 0 ? "오늘!" : `D-${dday}`}
                    </span>
                  )}
                  {entry.note !== undefined && (
                    <span className="text-xs text-stone-400">{entry.note}</span>
                  )}
                </span>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void save(schedule.filter((s) => s !== entry))}
                  className="shrink-0 text-xs text-rose-300 transition-colors hover:text-rose-500 disabled:opacity-50"
                >
                  빼기
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-stone-400">면접일·시험일을 적어두면 카드에 표시해 줄게!</p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select
          value={type}
          onChange={(e) => setType(e.target.value)}
          className="rounded-full border-2 border-amber-100 bg-white px-3 py-2 text-sm text-stone-600 outline-none focus:border-amber-300"
        >
          {SCHEDULE_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="rounded-full border-2 border-amber-100 bg-white px-3 py-2 text-sm text-stone-600 outline-none focus:border-amber-300"
        />
        <input
          type="text"
          placeholder="메모 (선택)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="w-40 rounded-full border-2 border-amber-100 bg-white px-3 py-2 text-sm text-stone-600 outline-none placeholder:text-stone-300 focus:border-amber-300"
        />
        <button
          type="button"
          disabled={saving || date === ""}
          onClick={() => void handleAdd()}
          className="rounded-full bg-amber-300 px-4 py-2 text-xs text-amber-950 shadow-[0_3px_0_#f59e0b] transition-transform hover:-translate-y-0.5 active:translate-y-0.5 active:shadow-none disabled:opacity-50 disabled:shadow-none"
        >
          + 추가
        </button>
      </div>
    </section>
  );
}
