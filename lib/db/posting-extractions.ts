import type { SupabaseClient } from "@supabase/supabase-js";

import type { ExtractionResult } from "@/lib/ai/extract";
import type { PostingExtraction } from "@/lib/ai/schemas";

import { StorageError } from "./errors";

/**
 * posting_extractions 저장 계층 — AI_ANALYSIS_DESIGN.md 7.2
 *
 * 1단계 구조화 결과는 공고당 버전별로 쌓인다 (재수집·프롬프트 개선).
 * 행 저장 후 job_postings.latest_extraction_id를 새 행으로 갱신해
 * "최신 유효 버전" 포인터를 유지한다.
 *
 * write는 service-role 클라이언트만 가능하다 (공유 캐시 — RLS는 select만 허용).
 */

const EXTRACTIONS_TABLE = "jobConfirm_posting_extractions";
const POSTINGS_TABLE = "jobConfirm_job_postings";

/** extractJobPosting()의 tokenUsage와 동일 구조 (jsonb 컬럼) */
export interface TokenUsage {
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
}

/** jobConfirm_posting_extractions 행 */
export interface PostingExtractionRow {
  id: string;
  posting_id: string;
  extracted: PostingExtraction;
  /** 발췌 컬럼 — 저장 시 extracted에서 복제 (목록·정렬·D-day 쿼리용) */
  company_name: string | null;
  job_title: string | null;
  deadline_date: string | null;
  /** 회귀 비교용 버전 기록 (설계 원칙 5) */
  model_id: string;
  prompt_version: string;
  schema_version: string;
  token_usage: TokenUsage | null;
  created_at: string;
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * LLM이 정규화한 마감일을 date 컬럼에 넣기 전 서버에서 한 번 더 검증한다 (3.2).
 * 형식이 다르거나 실존하지 않는 날짜("2026-02-31")면 null — 원문은 extracted의
 * deadline.raw_text에 보존돼 있으므로 정보 손실은 없다.
 * (순수 함수 — 단위 테스트 대상)
 */
export function normalizeDeadlineDate(date: string | null): string | null {
  if (date === null || !ISO_DATE_PATTERN.test(date)) return null;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  // Date는 2026-02-31을 3월 3일로 조용히 이월하므로 되돌려 비교해 걸러낸다
  return parsed.toISOString().slice(0, 10) === date ? date : null;
}

/** 발췌 컬럼 파생 — 저장 시 extracted에서 복제한다 (순수 함수 — 단위 테스트 대상) */
export function deriveExcerptColumns(extracted: PostingExtraction): {
  company_name: string | null;
  job_title: string | null;
  deadline_date: string | null;
} {
  return {
    company_name: extracted.company_name,
    job_title: extracted.job_title,
    deadline_date: normalizeDeadlineDate(extracted.deadline.date),
  };
}

/** 구조화 결과 단건 조회 — 카드 저장 API가 analysis.extraction_id → posting_id를 따라갈 때 사용 */
export async function getExtractionById(
  supabase: SupabaseClient,
  extractionId: string
): Promise<PostingExtractionRow | null> {
  const { data, error } = await supabase
    .from(EXTRACTIONS_TABLE)
    .select("*")
    .eq("id", extractionId)
    .maybeSingle();

  if (error) {
    throw new StorageError(`구조화 결과 조회 실패 (id: ${extractionId}): ${error.message}`, {
      cause: error,
    });
  }
  return (data as PostingExtractionRow | null) ?? null;
}

/**
 * 공고의 최신 구조화 결과 조회 — 구조화 캐시(6.2)의 후보.
 * 버전별로 쌓이는 행 중 created_at 기준 최신 1건만 본다
 * (버전은 앞으로만 움직이므로 이전 행이 현재 버전과 일치할 일은 없다).
 * 실패한 구조화는 애초에 저장되지 않으므로(M1-7) 행 존재 = 성공 상태다.
 */
export async function getLatestExtraction(
  supabase: SupabaseClient,
  postingId: string
): Promise<PostingExtractionRow | null> {
  const { data, error } = await supabase
    .from(EXTRACTIONS_TABLE)
    .select("*")
    .eq("posting_id", postingId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new StorageError(
      `최신 구조화 결과 조회 실패 (posting_id: ${postingId}): ${error.message}`,
      { cause: error }
    );
  }
  return (data as PostingExtractionRow | null) ?? null;
}

/**
 * 구조화 결과 저장 + latest_extraction_id 포인터 갱신.
 *
 * 포인터 갱신이 실패하면 StorageError를 던진다 — 행 자체는 이미 저장됐지만
 * (append-only라 무해) 포인터가 이전 버전을 가리키는 상태를 성공으로 치지 않는다.
 */
export async function savePostingExtraction(
  supabase: SupabaseClient,
  postingId: string,
  result: ExtractionResult
): Promise<PostingExtractionRow> {
  const { data, error } = await supabase
    .from(EXTRACTIONS_TABLE)
    .insert({
      posting_id: postingId,
      extracted: result.extracted,
      ...deriveExcerptColumns(result.extracted),
      model_id: result.modelId,
      prompt_version: result.promptVersion,
      schema_version: result.schemaVersion,
      token_usage: result.tokenUsage,
    })
    .select()
    .single();

  if (error) {
    throw new StorageError(`구조화 결과 저장 실패 (posting_id: ${postingId}): ${error.message}`, {
      cause: error,
    });
  }
  const row = data as PostingExtractionRow;

  const { error: pointerError } = await supabase
    .from(POSTINGS_TABLE)
    .update({ latest_extraction_id: row.id })
    .eq("id", postingId);

  if (pointerError) {
    throw new StorageError(
      `latest_extraction_id 갱신 실패 (posting_id: ${postingId}, extraction_id: ${row.id}): ${pointerError.message}`,
      { cause: pointerError }
    );
  }

  return row;
}
