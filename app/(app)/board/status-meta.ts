import type { ApplicationStatus } from "@/lib/db/applications";

/** 칸반 6단계의 표시 메타 (PRD 3.2 S7) — 보드(S7)와 카드 상세(S8)가 공유 */
export const STATUS_META: Record<ApplicationStatus, { label: string; emoji: string }> = {
  interested: { label: "관심 공고", emoji: "👀" },
  applied: { label: "지원 완료", emoji: "📨" },
  doc_passed: { label: "합격", emoji: "📄" },
  interview: { label: "면접 예정", emoji: "🎤" },
  accepted: { label: "최종 합격", emoji: "🎉" },
  rejected: { label: "불합격", emoji: "🌧️" },
};

/** 불합격 이동 시 기록할 탈락 단계 선택지 (PRD 2.3 — 전환율 통계의 재료) */
export const REJECTED_STAGES = ["서류/필기", "면접", "기타"] as const;
