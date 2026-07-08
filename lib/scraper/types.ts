/**
 * 수집(스크래핑) 모듈 공통 타입 — ARCHITECTURE.md 3.2, AI_ANALYSIS_DESIGN.md 2장 [0] 전처리
 *
 * 이 모듈은 "URL → 정제된 공고 본문 텍스트"까지만 책임진다.
 * DB 저장·LLM 호출은 상위 파이프라인(M1-5 이후)의 몫이다.
 */

/** 수집 출처 — DB enum "jobConfirm_posting_source"와 1:1 대응 */
export type SourceSite = "wanted" | "saramin" | "generic" | "manual_paste";

/** 어댑터가 HTML에서 뽑아낸 내용 (아직 정규화·해시 전) */
export interface ExtractedContent {
  /** 페이지 제목 (title/og:title) — 구조화 프롬프트의 추출 힌트 (AI_ANALYSIS_DESIGN.md 3.1) */
  title: string | null;
  /** 사이트명 (og:site_name) — 구조화 프롬프트의 추출 힌트 */
  siteName: string | null;
  /** 공고 본문 텍스트 (정제 전) */
  bodyText: string;
}

/**
 * 사이트별 어댑터 인터페이스.
 *
 * 어댑터는 순수 함수로 구성한다 — 네트워크 접근 없이 HTML 문자열만 받아
 * 본문을 추출하므로 픽스처 HTML로 단위 테스트할 수 있다.
 * 본문을 찾지 못하면 null을 반환하고, 오케스트레이터가 범용 추출기로 폴백한다.
 */
export interface SiteAdapter {
  /** manual_paste는 어댑터가 아니라 폴백 입력이므로 제외 */
  sourceSite: Exclude<SourceSite, "manual_paste">;
  /** 이 어댑터가 처리할 URL인지 판별 (정규화된 URL 기준) */
  matches(url: URL): boolean;
  /** HTML에서 공고 본문 추출. 실패(구조 변경, 빈 페이지 등) 시 null */
  extract(html: string): ExtractedContent | null;
}

/**
 * 수집 최종 산출물 — job_postings 행 생성에 필요한 필드와 대응.
 * (url/normalized_url/url_hash/source_site/raw_snapshot/snapshot_hash/fetched_at)
 */
export interface ScrapedPosting {
  sourceSite: SourceSite;
  /** manual_paste는 URL이 없다 (DB에서도 nullable) */
  url: string | null;
  normalizedUrl: string | null;
  /** 캐시·중복감지 키. manual_paste는 null */
  urlHash: string | null;
  title: string | null;
  siteName: string | null;
  /** 정제된 본문 텍스트 — job_postings.raw_snapshot 후보 */
  bodyText: string;
  /** 본문 해시 — 재수집 시 변경 감지용 (job_postings.snapshot_hash) */
  snapshotHash: string;
  /** ISO 8601 */
  fetchedAt: string;
}

/** 수집 실패 사유 — 상위 파이프라인에서 analysis_jobs.error_code('fetch_failed')로 매핑된다 */
export type ScrapeErrorCode =
  | "invalid_url" // URL 형식이 아니거나 http(s)가 아님
  | "disallowed_by_robots" // robots.txt가 수집을 금지 → 붙여넣기 폴백 안내
  | "fetch_failed" // 네트워크 오류, 4xx/5xx, 타임아웃
  | "unsupported_content" // HTML이 아닌 응답 (PDF, 이미지 등)
  | "empty_content"; // 본문 추출 결과가 비어 있음 → 붙여넣기 폴백 안내

export class ScrapeError extends Error {
  readonly code: ScrapeErrorCode;

  constructor(code: ScrapeErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ScrapeError";
    this.code = code;
  }
}
