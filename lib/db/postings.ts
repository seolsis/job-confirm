import type { SupabaseClient } from "@supabase/supabase-js";

import type { ScrapedPosting, SourceSite } from "@/lib/scraper";

import { StorageError } from "./errors";

/**
 * job_postings 저장 계층 — AI_ANALYSIS_DESIGN.md 7.2
 *
 * 공고 원본은 사용자 무관 공유 캐시이므로 write는 service-role 클라이언트만
 * 가능하다 (RLS: 인증 사용자 select만 허용). 여기의 함수들은 클라이언트를
 * 주입받으므로 fake로 단위 테스트할 수 있다.
 *
 * url_hash 기반 캐시 조회·재수집은 상위 파이프라인(M1-8 이후)의 몫이다.
 */

const POSTINGS_TABLE = "jobConfirm_job_postings";

/** DB enum "jobConfirm_posting_status"와 1:1 대응 */
export type PostingStatus = "active" | "closed" | "fetch_failed";

/** jobConfirm_job_postings 행 */
export interface JobPostingRow {
  id: string;
  url: string | null;
  normalized_url: string | null;
  url_hash: string | null;
  source_site: SourceSite;
  raw_snapshot: string | null;
  snapshot_hash: string | null;
  status: PostingStatus;
  latest_extraction_id: string | null;
  fetched_at: string | null;
  created_at: string;
}

export async function getJobPostingById(
  supabase: SupabaseClient,
  postingId: string
): Promise<JobPostingRow | null> {
  const { data, error } = await supabase
    .from(POSTINGS_TABLE)
    .select("*")
    .eq("id", postingId)
    .maybeSingle();

  if (error) {
    throw new StorageError(`공고 조회 실패 (posting_id: ${postingId}): ${error.message}`, {
      cause: error,
    });
  }
  return (data as JobPostingRow | null) ?? null;
}

/**
 * 수집 산출물(ScrapedPosting) → job_postings 행 생성.
 * 캐시 조회 없이 항상 새 행을 만든다 — url_hash 중복 시 unique 제약으로 실패하므로
 * 상위 파이프라인이 먼저 캐시를 조회해야 한다 (manual_paste는 url_hash가 null이라 무관).
 */
export async function insertJobPosting(
  supabase: SupabaseClient,
  scraped: ScrapedPosting
): Promise<JobPostingRow> {
  const { data, error } = await supabase
    .from(POSTINGS_TABLE)
    .insert({
      url: scraped.url,
      normalized_url: scraped.normalizedUrl,
      url_hash: scraped.urlHash,
      source_site: scraped.sourceSite,
      raw_snapshot: scraped.bodyText,
      snapshot_hash: scraped.snapshotHash,
      fetched_at: scraped.fetchedAt,
    })
    .select()
    .single();

  if (error) {
    throw new StorageError(`공고 저장 실패 (source: ${scraped.sourceSite}): ${error.message}`, {
      cause: error,
    });
  }
  return data as JobPostingRow;
}
