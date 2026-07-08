import type Anthropic from "@anthropic-ai/sdk";

import {
  buildExtractUserMessage,
  EXTRACT_PROMPT_VERSION,
  EXTRACT_SYSTEM_PROMPT,
} from "./prompts/extract-v1";
import {
  EXTRACTION_JSON_SCHEMA,
  EXTRACTION_SCHEMA_VERSION,
  type PostingExtraction,
} from "./schemas";

/**
 * 1단계 — 공고 구조화 (LLM 호출 #1) — docs/AI_ANALYSIS_DESIGN.md 3장, 6.1
 *
 * 정제된 공고 본문 → 표준 스키마 JSON. 사용자와 무관한 공유 캐시 대상이므로
 * 프로필 정보는 절대 입력에 넣지 않는다 (같은 공고는 사용자 간 결과를 재사용).
 *
 * 이 모듈은 순수하게 "입력 → LLM 호출 → 구조화 결과"만 담당한다.
 * DB 저장·캐시 조회·쿼터는 상위 파이프라인(M1-6 이후)의 몫이고,
 * Anthropic 클라이언트는 주입받으므로 fake 클라이언트로 단위 테스트할 수 있다.
 */

/** 기본 모델 (docs/AI_ANALYSIS_DESIGN.md 전제). DB의 model_id로 그대로 저장된다 */
export const EXTRACTION_MODEL_ID = "claude-opus-4-8";

/** 호출 파라미터 (6.1 표): 추출은 정형 작업이라 effort medium */
const EXTRACTION_MAX_TOKENS = 8_000;
const EXTRACTION_EFFORT = "medium";

/** 실패 사유 — 상위 파이프라인에서 analysis_jobs.error_code('llm_error')로 매핑 */
export type ExtractionErrorCode =
  | "refusal" // 안전 분류기/모델 거부 (stop_reason: refusal)
  | "truncated" // max_tokens 도달로 출력이 잘림
  | "empty_output" // 출력에 텍스트 블록이 없음
  | "invalid_json"; // structured outputs 상 발생하지 않아야 하지만 방어적으로 처리

export class ExtractionError extends Error {
  readonly code: ExtractionErrorCode;

  constructor(code: ExtractionErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ExtractionError";
    this.code = code;
  }
}

export interface ExtractionInput {
  /** 정제된 공고 본문 (lib/scraper 산출물) */
  bodyText: string;
  /** 추출 힌트 (AI_ANALYSIS_DESIGN.md 3.1) */
  title?: string | null;
  siteName?: string | null;
}

/** posting_extractions 행 생성에 필요한 필드와 1:1 대응하는 산출물 */
export interface ExtractionResult {
  extracted: PostingExtraction;
  modelId: string;
  promptVersion: string;
  schemaVersion: string;
  /** posting_extractions.token_usage (jsonb) — 비용 대시보드의 원천 (6.2) */
  tokenUsage: {
    input: number;
    output: number;
    cache_read: number;
    cache_creation: number;
  };
}

export interface ExtractOptions {
  /** LLM 응답이 refusal/max_tokens로 끝났을 때 재시도 횟수 (8장: 1회) */
  maxRetries?: number;
}

/**
 * 공고 본문을 표준 스키마로 구조화한다.
 *
 * - 항상 스트리밍 호출(client.messages.stream) — 수십 초 응답의 HTTP 타임아웃 방지 (3.1)
 * - structured outputs(output_config.format)로 스키마를 강제 — 파싱 실패가 원천 차단 (6.1)
 * - 고정 시스템 프롬프트에 cache_control — 입력 토큰 ~90% 절감 (3.3)
 * - refusal/max_tokens 종료 시 1회 재시도 후 ExtractionError (8장)
 */
export async function extractJobPosting(
  client: Anthropic,
  input: ExtractionInput,
  options: ExtractOptions = {}
): Promise<ExtractionResult> {
  const { maxRetries = 1 } = options;

  let lastError: ExtractionError | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await extractOnce(client, input);
    } catch (error) {
      if (error instanceof ExtractionError) {
        lastError = error; // 일시적일 수 있는 종료 사유 — 재시도
        continue;
      }
      throw error; // API 오류(429/5xx)는 SDK가 이미 지수 백오프로 재시도했으므로 그대로 전파
    }
  }
  throw lastError ?? new ExtractionError("empty_output", "구조화 결과가 비어 있습니다");
}

async function extractOnce(client: Anthropic, input: ExtractionInput): Promise<ExtractionResult> {
  const stream = client.messages.stream({
    model: EXTRACTION_MODEL_ID,
    max_tokens: EXTRACTION_MAX_TOKENS,
    thinking: { type: "adaptive" },
    output_config: {
      effort: EXTRACTION_EFFORT,
      format: { type: "json_schema", schema: EXTRACTION_JSON_SCHEMA },
    },
    system: [
      {
        type: "text",
        text: EXTRACT_SYSTEM_PROMPT, // 바이트 고정 — 가변 값 금지 (캐시 무효화 방지)
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: buildExtractUserMessage({
          siteName: input.siteName ?? null,
          title: input.title ?? null,
          bodyText: input.bodyText,
        }),
      },
    ],
  });

  const message = await stream.finalMessage();

  // stop_reason을 먼저 확인한다 — refusal이면 content가 비어 있거나 부분 출력이다
  if (message.stop_reason === "refusal") {
    throw new ExtractionError("refusal", "모델이 요청을 거부했습니다 (stop_reason: refusal)");
  }
  if (message.stop_reason === "max_tokens") {
    throw new ExtractionError("truncated", "출력이 max_tokens에서 잘렸습니다");
  }

  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
  if (text === "") {
    throw new ExtractionError("empty_output", "출력에 텍스트 블록이 없습니다");
  }

  return {
    extracted: parseExtraction(text),
    modelId: EXTRACTION_MODEL_ID,
    promptVersion: EXTRACT_PROMPT_VERSION,
    schemaVersion: EXTRACTION_SCHEMA_VERSION,
    tokenUsage: {
      input: message.usage.input_tokens,
      output: message.usage.output_tokens,
      cache_read: message.usage.cache_read_input_tokens ?? 0,
      cache_creation: message.usage.cache_creation_input_tokens ?? 0,
    },
  };
}

/**
 * structured outputs 응답 텍스트 → 타입 확정.
 * 스키마가 서버에서 강제되므로 실패하지 않아야 하지만, 방어적으로 감싼다.
 * (순수 함수 — 단위 테스트 대상)
 */
export function parseExtraction(text: string): PostingExtraction {
  try {
    return JSON.parse(text) as PostingExtraction;
  } catch (cause) {
    throw new ExtractionError("invalid_json", "구조화 결과 JSON 파싱 실패", { cause });
  }
}
