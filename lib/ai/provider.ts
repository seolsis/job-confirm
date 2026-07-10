/**
 * LLM provider 선택 — 환경 변수 AI_PROVIDER로 Anthropic ↔ Gemini를 전환한다.
 *
 * 미설정/알 수 없는 값은 anthropic으로 동작한다 (기존 동작 보존 — 테스트도
 * AI_PROVIDER 없이 돌므로 기존 단언이 그대로 유지된다). Gemini를 쓰려면
 * .env.local에 AI_PROVIDER=gemini와 GOOGLE_API_KEY를 설정한다.
 *
 * 모델 ID는 provider별로 여기서 결정된다 — extract/match가 DB의 model_id로
 * 저장하고 구조화 캐시(extraction-cache.ts)가 같은 상수로 히트를 판정하므로,
 * provider를 바꾸면 기존 캐시는 model_mismatch로 자동 무효화되고 재분석된다.
 */

export type AiProvider = "anthropic" | "gemini";

export function getAiProvider(): AiProvider {
  return process.env.AI_PROVIDER === "gemini" ? "gemini" : "anthropic";
}

/** 1단계 공고 구조화(LLM #1) 모델 — provider별 */
export const EXTRACTION_MODEL_IDS: Record<AiProvider, string> = {
  anthropic: "claude-opus-4-8",
  gemini: "gemini-3.5-flash", // 무료 티어 제공 모델 (2.5-flash는 신규 사용자에게 제공 종료)
};

/** 2단계 프로필 매칭(LLM #2) 모델 — provider별 */
export const MATCH_MODEL_IDS: Record<AiProvider, string> = {
  anthropic: "claude-opus-4-8",
  gemini: "gemini-3.5-flash",
};
