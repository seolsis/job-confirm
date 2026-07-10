"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type DragEvent } from "react";

import {
  APPLICATION_STATUSES,
  daysUntil,
  listApplicationCards,
  updateApplicationStatus,
  type ApplicationCard,
  type ApplicationStatus,
} from "@/lib/db/applications";
import { createBrowserSupabaseClient } from "@/lib/supabase/browser";

import { GRADE_BADGE_CLASSES, GRADE_LABELS } from "../analysis-result";
import { STATUS_META } from "./status-meta";

/**
 * S7 — 취준탭 칸반 보드 (M3-3, PRD 2.3·3.2).
 *
 * 8개 컬럼(관심→…→최종 합격/불합격), 카드는 회사·직무·적합도 뱃지·마감 D-day.
 * 드래그&드롭으로 상태 변경 — RLS가 본인 카드 update를 직접 허용하는 예외 경로이고
 * (ARCHITECTURE.md 4.2), 이력은 DB 트리거가 자동 기록한다.
 * 불합격 컬럼으로 옮기면 이동 전 상태를 탈락 단계로 자동 기록한다 (PRD 2.3).
 * 8컬럼은 가로 스크롤로 대응한다 (PRD S7 — 모바일 탭 전환형은 추후).
 */
export default function BoardPage() {
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);

  const [cards, setCards] = useState<ApplicationCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<ApplicationStatus | null>(null);

  useEffect(() => {
    listApplicationCards(supabase)
      .then(setCards)
      .catch(() => setError("보드를 불러오지 못했어. 새로고침해 줄래?"));
  }, [supabase]);

  /** 드롭 → 낙관적 이동 후 저장. 실패하면 되돌린다 */
  async function moveCard(applicationId: string, to: ApplicationStatus) {
    if (cards === null) return;
    const card = cards.find((c) => c.application.id === applicationId);
    if (card === undefined || card.application.status === to) return;

    const from = card.application.status;
    // 불합격 이동: 이동 전 단계를 탈락 단계로 기록 (상세에서 수정 가능)
    const rejectedAtStage = to === "rejected" ? STATUS_META[from].label : null;

    setCards((current) =>
      (current ?? []).map((c) =>
        c.application.id === applicationId
          ? {
              ...c,
              application: { ...c.application, status: to, rejected_at_stage: rejectedAtStage },
            }
          : c
      )
    );

    try {
      await updateApplicationStatus(supabase, applicationId, to, { rejectedAtStage });
    } catch {
      // 되돌림 + 안내
      setCards((current) =>
        (current ?? []).map((c) =>
          c.application.id === applicationId
            ? {
                ...c,
                application: {
                  ...c.application,
                  status: from,
                  rejected_at_stage: card.application.rejected_at_stage,
                },
              }
            : c
        )
      );
      setError("상태를 저장하지 못했어… 잠시 후 다시 시도해 줘.");
    }
  }

  function handleDrop(event: DragEvent, status: ApplicationStatus) {
    event.preventDefault();
    setDragOverColumn(null);
    const applicationId = event.dataTransfer.getData("text/plain");
    if (applicationId !== "") void moveCard(applicationId, status);
  }

  return (
    <main className="min-h-screen bg-gradient-to-b from-sky-100 via-[#fef6e4] to-[#fef6e4] px-4 py-10">
      {/* 상단 내비 */}
      <nav className="fixed top-4 right-4 z-10 flex gap-2">
        <Link
          href="/analyze"
          className="flex items-center gap-1.5 rounded-full border-2 border-amber-100 bg-white/90 px-4 py-2 text-sm text-stone-600 shadow-sm transition-transform hover:-translate-y-0.5"
        >
          <span aria-hidden>🔍</span> 공고 분석
        </Link>
        <Link
          href="/profile"
          className="flex items-center gap-1.5 rounded-full border-2 border-amber-100 bg-white/90 px-4 py-2 text-sm text-stone-600 shadow-sm transition-transform hover:-translate-y-0.5"
        >
          <span aria-hidden>🐥</span> 내 프로필
        </Link>
      </nav>

      <h1 className="text-center text-2xl text-stone-700">취준 여행 보드 🗂️</h1>
      <p className="mt-2 text-center text-xs text-stone-400">
        카드를 끌어서 다음 정거장으로 옮길 수 있어
      </p>

      {error !== null && (
        <p className="mx-auto mt-4 max-w-md rounded-2xl border-2 border-rose-100 bg-rose-50 px-4 py-3 text-center text-sm text-rose-600">
          🥺 {error}
        </p>
      )}

      {cards === null ? (
        <p className="mt-16 text-center text-sm text-stone-400">
          <span className="animate-hop inline-block text-3xl" aria-hidden>
            🐾
          </span>
          <br />
          보드를 펼치는 중…
        </p>
      ) : cards.length === 0 ? (
        <EmptyBoard />
      ) : (
        <div className="mt-8 flex gap-4 overflow-x-auto pb-6">
          {APPLICATION_STATUSES.map((status) => {
            const columnCards = cards.filter((c) => c.application.status === status);
            const meta = STATUS_META[status];
            return (
              <section
                key={status}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOverColumn(status);
                }}
                onDragLeave={() => setDragOverColumn((c) => (c === status ? null : c))}
                onDrop={(e) => handleDrop(e, status)}
                className={`w-64 shrink-0 rounded-[1.5rem] border-2 p-3 transition-colors ${
                  dragOverColumn === status
                    ? "border-amber-300 bg-amber-50"
                    : "border-amber-100 bg-white/70"
                }`}
              >
                <h2 className="px-1 text-sm text-stone-600">
                  <span aria-hidden>{meta.emoji}</span> {meta.label}
                  <span className="ml-1 text-xs text-stone-300">{columnCards.length}</span>
                </h2>
                <div className="mt-3 space-y-3">
                  {columnCards.map((card) => (
                    <BoardCard key={card.application.id} card={card} />
                  ))}
                  {columnCards.length === 0 && (
                    <p className="rounded-xl border-2 border-dashed border-stone-100 py-6 text-center text-xs text-stone-300">
                      여기로 끌어다 놓기
                    </p>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </main>
  );
}

/** 카드 — 회사·직무·적합도 뱃지·D-day (PRD S7). 드래그 가능, 클릭하면 상세(S8) */
function BoardCard({ card }: { card: ApplicationCard }) {
  const dday = daysUntil(card.deadline_date);

  return (
    <Link
      href={`/board/${card.application.id}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", card.application.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      className="block cursor-grab rounded-2xl border-2 border-amber-100 bg-white p-3 shadow-[0_3px_0_#fde68a] transition-transform hover:-translate-y-0.5 active:cursor-grabbing"
    >
      <p className="text-xs text-stone-400">{card.company_name ?? "회사명 없음"}</p>
      <p className="mt-0.5 line-clamp-2 text-sm text-stone-700">
        {card.job_title ?? "직무 정보 없음"}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {card.grade !== null && (
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] ${GRADE_BADGE_CLASSES[card.grade]}`}
          >
            {card.score !== null ? `${card.score}점` : GRADE_LABELS[card.grade]}
          </span>
        )}
        <DdayChip dday={dday} />
        {card.application.memo !== null && (
          <span aria-label="메모 있음" title="메모 있음" className="text-[11px]">
            📝
          </span>
        )}
      </div>
    </Link>
  );
}

/** 마감 D-day 칩 — 임박(D-3 이내)은 강조, 지난 마감은 회색 (PRD S7) */
function DdayChip({ dday }: { dday: number | null }) {
  if (dday === null) return null;
  if (dday < 0) {
    return (
      <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[11px] text-stone-400">
        마감됨
      </span>
    );
  }
  const urgent = dday <= 3;
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[11px] ${
        urgent ? "bg-rose-100 font-medium text-rose-600" : "bg-sky-50 text-sky-600"
      }`}
    >
      {dday === 0 ? "오늘 마감!" : `D-${dday}`}
    </span>
  );
}

/** 빈 보드 — 첫 진입 이탈 방지 (PRD 7.1의 빈 상태 설계) */
function EmptyBoard() {
  return (
    <div className="mx-auto mt-16 max-w-md text-center">
      <div className="animate-float text-6xl" aria-hidden>
        🧺
      </div>
      <div className="bubble bubble-center mx-auto mt-5 max-w-xs text-sm text-stone-600">
        아직 보드가 비어 있어! 공고를 분석하고 [취준탭에 저장]을 누르면 여기에 카드가 생겨.
      </div>
      <Link
        href="/analyze"
        className="mt-6 inline-block rounded-full bg-amber-300 px-8 py-3.5 text-sm text-amber-950 shadow-[0_4px_0_#f59e0b] transition-transform hover:-translate-y-0.5 active:translate-y-0.5 active:shadow-none"
      >
        첫 공고 분석하러 가기 🔍
      </Link>
    </div>
  );
}
