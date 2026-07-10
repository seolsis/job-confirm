"use client";

import type { JudgmentVerdict } from "@/lib/ai/match-schemas";
import type { MatchAnalysisRow } from "@/lib/db/match-analyses";

/**
 * 부엉 박사의 분석 리포트 — S6(분석 결과)와 S8(카드 상세의 다시 보기)이 공유한다.
 * 표시 전용(순수 렌더링) — 데이터 조회·저장은 각 화면의 몫.
 */

/** 등급 라벨 (AI_ANALYSIS_DESIGN.md 5.2 등급 구간) */
export const GRADE_LABELS: Record<MatchAnalysisRow["grade"], string> = {
  recommend: "적극 추천",
  challenge: "도전 가능",
  prepare: "준비 필요",
  large_gap: "갭이 큼",
  insufficient_profile: "프로필 부족",
};

/** 등급별 파스텔 배지 색 — 긍정(민트)→중립(하늘)→주의(앰버)→부정(핑크)→정보(퍼플) */
export const GRADE_BADGE_CLASSES: Record<MatchAnalysisRow["grade"], string> = {
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

export function AnalysisResult({ analysis }: { analysis: MatchAnalysisRow }) {
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
