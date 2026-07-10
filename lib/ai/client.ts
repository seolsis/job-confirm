import "server-only"; // ANTHROPIC_API_KEY는 서버 전용 — 클라이언트 번들에 포함되면 빌드 실패

import Anthropic from "@anthropic-ai/sdk";

import { createGeminiClient } from "./gemini-client";
import { getAiProvider } from "./provider";

/**
 * LLM 클라이언트 팩토리 — AI_PROVIDER 환경 변수에 따라 Anthropic 또는
 * Gemini(어댑터)를 반환한다. 두 클라이언트는 extract/match가 쓰는
 * messages.stream(...).finalMessage() 표면이 동일하다 (gemini-client.ts 참고).
 */
export function createAiClient(): Anthropic {
  return getAiProvider() === "gemini" ? createGeminiClient() : createAnthropicClient();
}

/**
 * Anthropic 클라이언트 팩토리 — ARCHITECTURE.md 2장.
 * Route Handler에서만 사용한다. 클라이언트(브라우저)에서 LLM을 직접
 * 호출하는 경로는 만들지 않는다.
 */
export function createAnthropicClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "환경 변수 ANTHROPIC_API_KEY이(가) 설정되지 않았습니다. .env.example을 참고해 .env.local을 채워주세요."
    );
  }
  return new Anthropic({ apiKey });
}
