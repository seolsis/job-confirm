import "server-only"; // GOOGLE_API_KEY는 서버 전용 — 클라이언트 번들에 포함되면 빌드 실패

import type Anthropic from "@anthropic-ai/sdk";
import { ApiError, GoogleGenAI, type GenerateContentResponse } from "@google/genai";

/**
 * Gemini 어댑터 — Anthropic 클라이언트의 messages.stream(...).finalMessage()
 * 표면만 흉내 내는 최소 구현. extract.ts / match.ts는 이 표면만 사용하므로
 * (테스트의 fake 클라이언트가 그 증거) 기존 모듈을 수정하지 않고 주입할 수 있다.
 *
 * 파라미터 변환:
 *  - system(text 블록 배열) → systemInstruction (cache_control은 무시 — Gemini는 암시적 캐시)
 *  - output_config.format.schema → responseJsonSchema (구조화 출력 강제)
 *  - output_config.effort → thinkingConfig (high면 동적 thinking, 그 외 비활성)
 *  - thinking(adaptive) 파라미터는 무시 — Gemini 쪽 개념이 다르다
 *
 * 응답 변환:
 *  - finishReason STOP → end_turn, MAX_TOKENS → max_tokens,
 *    안전 차단 계열/프롬프트 차단 → refusal (extract/match의 재시도 정책이 그대로 동작)
 *  - usageMetadata → tokenUsage 매핑 (cache_read = 암시적 캐시 히트 토큰)
 *
 * 일시적 오류 재시도 (2026-07-10 실측 — 503 UNAVAILABLE "high demand", 네트워크
 * 타임아웃으로 전체 분석이 즉시 실패하는 문제 발견):
 * Anthropic SDK는 429/5xx를 자동으로 지수 백오프 재시도하지만, 이 어댑터는
 * fetch 계층을 직접 다루므로 같은 안전망이 없다. extract.ts/match.ts의
 * 재시도(maxRetries)는 ExtractionError/MatchError(refusal 등 판정 결과)만
 * 잡고 원시 예외는 그대로 던지므로, 여기서 429/5xx/네트워크 오류에 한해
 * 별도로 재시도한다.
 */

/** extract.ts / match.ts가 실제로 보내는 파라미터의 구조적 타입 */
interface AnthropicShapedStreamParams {
  model: string;
  max_tokens: number;
  system?: string | Array<{ type: string; text: string }>;
  messages: Array<{ role: string; content: unknown }>;
  output_config?: {
    effort?: string;
    format?: { type: string; schema?: unknown };
  };
  [key: string]: unknown;
}

/** 재시도 대상 HTTP 상태 — 과부하/일시 장애/쿼터 (429는 quota_exceeded 매핑과 별개로 몇 초 뒤엔 풀리는 경우가 많아 재시도 가치가 있다) */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_TRANSIENT_RETRIES = 3;
const BASE_DELAY_MS = 800;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** ApiError.status(HTTP 상태) 또는 네트워크 계층 예외(TypeError: fetch failed 등)를 재시도 대상으로 판단 */
function isRetryable(error: unknown): boolean {
  if (error instanceof ApiError) return RETRYABLE_STATUS.has(error.status);
  // fetch 자체가 실패한 경우(undici HeadersTimeoutError, ECONNRESET 등) — SDK가 TypeError로 감싼다
  return error instanceof TypeError;
}

/** 지수 백오프 + 지터로 일시적 오류만 재시도한다. 재시도 대상이 아니거나 소진되면 그대로 던진다 */
async function withTransientRetry<T>(call: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
    try {
      return await call();
    } catch (error) {
      lastError = error;
      if (attempt === MAX_TRANSIENT_RETRIES || !isRetryable(error)) throw error;
      const delay = BASE_DELAY_MS * 2 ** attempt + Math.random() * 300;
      await sleep(delay);
    }
  }
  throw lastError;
}

/** 안전/정책 차단 계열 finishReason — Anthropic의 refusal에 대응시킨다 */
const REFUSAL_FINISH_REASONS = new Set([
  "SAFETY",
  "RECITATION",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "IMAGE_SAFETY",
]);

/**
 * Gemini 클라이언트 팩토리 — createAnthropicClient()와 대칭.
 * 반환 타입을 Anthropic으로 캐스팅해 기존 주입 지점(AnalysisPipelineDeps.anthropic 등)에
 * 그대로 꽂는다 — 테스트의 fake 클라이언트(`fake as unknown as Anthropic`)와 같은 방식.
 */
export function createGeminiClient(): Anthropic {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "환경 변수 GOOGLE_API_KEY이(가) 설정되지 않았습니다. .env.example을 참고해 .env.local을 채워주세요."
    );
  }
  const genai = new GoogleGenAI({ apiKey });

  const adapter = {
    messages: {
      stream(params: AnthropicShapedStreamParams) {
        return {
          async finalMessage() {
            const response = await withTransientRetry(() =>
              genai.models.generateContent({
                model: params.model,
                contents: toUserText(params.messages),
                config: {
                  systemInstruction: toSystemText(params.system),
                  maxOutputTokens: params.max_tokens,
                  responseMimeType: "application/json",
                  ...(params.output_config?.format?.schema !== undefined && {
                    responseJsonSchema: params.output_config.format.schema,
                  }),
                  // effort high(매칭)는 동적 thinking, 그 외(구조화 등 정형 작업)는 비활성
                  thinkingConfig: {
                    thinkingBudget: params.output_config?.effort === "high" ? -1 : 0,
                  },
                },
              })
            );
            return toAnthropicShapedMessage(params.model, response);
          },
        };
      },
    },
  };

  return adapter as unknown as Anthropic;
}

/** system 파라미터(문자열 또는 text 블록 배열) → 단일 시스템 프롬프트 문자열 */
function toSystemText(system: AnthropicShapedStreamParams["system"]): string | undefined {
  if (system === undefined) return undefined;
  if (typeof system === "string") return system;
  return system.map((block) => block.text).join("\n\n");
}

/** messages 배열 → 사용자 입력 텍스트 (extract/match는 user 1건에 문자열 content만 보낸다) */
function toUserText(messages: AnthropicShapedStreamParams["messages"]): string {
  return messages
    .map(({ content }) => {
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        return content
          .filter(
            (block): block is { type: string; text: string } =>
              typeof block === "object" && block !== null && block.type === "text"
          )
          .map((block) => block.text)
          .join("\n");
      }
      return "";
    })
    .join("\n\n");
}

/** Gemini 응답 → extract/match가 읽는 필드(stop_reason/content/usage)만 갖춘 메시지 */
function toAnthropicShapedMessage(model: string, response: GenerateContentResponse) {
  const finishReason = response.candidates?.[0]?.finishReason as string | undefined;
  const promptBlocked = response.promptFeedback?.blockReason != null;

  let stop_reason: "end_turn" | "max_tokens" | "refusal";
  if (promptBlocked || (finishReason !== undefined && REFUSAL_FINISH_REASONS.has(finishReason))) {
    stop_reason = "refusal";
  } else if (finishReason === "MAX_TOKENS") {
    stop_reason = "max_tokens";
  } else {
    stop_reason = "end_turn";
  }

  const text = response.text ?? "";
  const usage = response.usageMetadata;

  return {
    type: "message" as const,
    role: "assistant" as const,
    model,
    stop_reason,
    content: text === "" ? [] : [{ type: "text" as const, text }],
    usage: {
      input_tokens: usage?.promptTokenCount ?? 0,
      // thinking 토큰도 출력으로 과금되므로 output에 합산한다
      output_tokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
      cache_read_input_tokens: usage?.cachedContentTokenCount ?? 0,
      cache_creation_input_tokens: 0, // Gemini 암시적 캐시에는 쓰기 비용 개념이 없다
    },
  };
}
