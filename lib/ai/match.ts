import type Anthropic from "@anthropic-ai/sdk";

import type { ProfileSnapshot } from "@/lib/db/profile-snapshots";

import {
  buildMatchUserMessage,
  MATCH_PROMPT_VERSION,
  MATCH_SYSTEM_PROMPT,
} from "./prompts/match-v1";
import { MATCH_JSON_SCHEMA, MATCH_SCHEMA_VERSION, type MatchResult } from "./match-schemas";
import type { PostingExtraction } from "./schemas";

/**
 * 2단계 — 프로필 매칭 (LLM 호출 #2) — docs/AI_ANALYSIS_DESIGN.md 4장, 6.1
 *
 * 구조화된 공고 JSON + 프로필 스냅샷 → 요건별 판정 + 8종 분석 JSON.
 * 사용자별 결과이므로 공유 캐시 대상이 아니다 (구조화 캐시와 다름).
 *
 * 이 모듈은 순수하게 "입력 → LLM 호출 → 판정 결과"만 담당한다.
 * 점수 산출은 M1-11(서버 규칙, LLM 아님), DB 저장·스냅샷 관리는 상위 파이프라인의 몫이고,
 * Anthropic 클라이언트는 주입받으므로 fake 클라이언트로 단위 테스트할 수 있다.
 * extract.ts와 대칭 구조 — 호출 파라미터만 다르다 (6.1 표).
 */

/** 기본 모델 (6.1). DB의 model_id로 그대로 저장된다 */
export const MATCH_MODEL_ID = "claude-opus-4-8";

/** 호출 파라미터 (6.1 표): 판단 품질이 제품 핵심이라 effort high, 출력이 길어 16k */
const MATCH_MAX_TOKENS = 16_000;
const MATCH_EFFORT = "high";

/** 실패 사유 — 상위 파이프라인에서 analysis_jobs.error_code('llm_error')로 매핑 */
export type MatchErrorCode =
  | "refusal" // 안전 분류기/모델 거부 (stop_reason: refusal)
  | "truncated" // max_tokens 도달로 출력이 잘림
  | "empty_output" // 출력에 텍스트 블록이 없음
  | "invalid_json"; // structured outputs 상 발생하지 않아야 하지만 방어적으로 처리

export class MatchError extends Error {
  readonly code: MatchErrorCode;

  constructor(code: MatchErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MatchError";
    this.code = code;
  }
}

export interface MatchInput {
  /** 1단계 산출물 (posting_extractions.extracted) */
  extraction: PostingExtraction;
  /** 분석 시점의 프로필 사본 (profile_snapshots.snapshot) — 원본 참조 금지 (7.3) */
  profileSnapshot: ProfileSnapshot;
}

/** match_analyses 행 생성에 필요한 필드와 1:1 대응하는 산출물 */
export interface MatchAnalysisOutput {
  result: MatchResult;
  modelId: string;
  promptVersion: string;
  schemaVersion: string;
  /** match_analyses.token_usage (jsonb) — 비용 대시보드의 원천 (6.2) */
  tokenUsage: {
    input: number;
    output: number;
    cache_read: number;
    cache_creation: number;
  };
}

export interface MatchOptions {
  /** LLM 응답이 refusal/max_tokens로 끝났을 때 재시도 횟수 (8장: 1회) */
  maxRetries?: number;
}

/**
 * 공고-프로필 매칭 분석을 실행한다.
 *
 * - 항상 스트리밍 호출(client.messages.stream) — 수십 초 응답의 HTTP 타임아웃 방지
 * - structured outputs(output_config.format)로 스키마를 강제 (6.1)
 * - 고정 시스템 프롬프트에 cache_control — 입력 토큰 절감 (3.3)
 * - refusal/max_tokens 종료 시 1회 재시도 후 MatchError (8장)
 */
export async function analyzeMatch(
  client: Anthropic,
  input: MatchInput,
  options: MatchOptions = {}
): Promise<MatchAnalysisOutput> {
  const { maxRetries = 1 } = options;

  let lastError: MatchError | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await matchOnce(client, input);
    } catch (error) {
      if (error instanceof MatchError) {
        lastError = error; // 일시적일 수 있는 종료 사유 — 재시도
        continue;
      }
      throw error; // API 오류(429/5xx)는 SDK가 이미 지수 백오프로 재시도했으므로 그대로 전파
    }
  }
  throw lastError ?? new MatchError("empty_output", "매칭 결과가 비어 있습니다");
}

async function matchOnce(client: Anthropic, input: MatchInput): Promise<MatchAnalysisOutput> {
  const stream = client.messages.stream({
    model: MATCH_MODEL_ID,
    max_tokens: MATCH_MAX_TOKENS,
    thinking: { type: "adaptive" },
    output_config: {
      effort: MATCH_EFFORT,
      format: { type: "json_schema", schema: MATCH_JSON_SCHEMA },
    },
    system: [
      {
        type: "text",
        text: MATCH_SYSTEM_PROMPT, // 바이트 고정 — 가변 값 금지 (캐시 무효화 방지)
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: buildMatchUserMessage({
          extraction: input.extraction,
          profileSnapshot: input.profileSnapshot,
        }),
      },
    ],
  });

  const message = await stream.finalMessage();

  if (message.stop_reason === "refusal") {
    throw new MatchError("refusal", "모델이 요청을 거부했습니다 (stop_reason: refusal)");
  }
  if (message.stop_reason === "max_tokens") {
    throw new MatchError("truncated", "출력이 max_tokens에서 잘렸습니다");
  }

  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
  if (text === "") {
    throw new MatchError("empty_output", "출력에 텍스트 블록이 없습니다");
  }

  return {
    result: parseMatchResult(text),
    modelId: MATCH_MODEL_ID,
    promptVersion: MATCH_PROMPT_VERSION,
    schemaVersion: MATCH_SCHEMA_VERSION,
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
export function parseMatchResult(text: string): MatchResult {
  try {
    return JSON.parse(text) as MatchResult;
  } catch (cause) {
    throw new MatchError("invalid_json", "매칭 결과 JSON 파싱 실패", { cause });
  }
}
