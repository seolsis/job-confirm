import { genericAdapter } from "./adapters/generic";
import { saraminAdapter } from "./adapters/saramin";
import { wantedAdapter } from "./adapters/wanted";
import { cleanText } from "./clean";
import { fetchHtml, type FetchHtmlOptions } from "./fetch";
import { extractPageMeta, loadHtml } from "./html";
import { parseHttpUrl, normalizeUrl, snapshotHash, urlHash } from "./url";
import { ScrapeError, type ExtractedContent, type ScrapedPosting, type SiteAdapter } from "./types";

/**
 * 수집 파이프라인 진입점 — AI_ANALYSIS_DESIGN.md 2장 [0] 전처리.
 *
 *   URL → 정규화/해시 → robots·간격 제한을 지키며 수집 → 어댑터 추출
 *   → 실패 시 범용 추출기 폴백 → 정제 → ScrapedPosting
 *
 * DB 저장·캐시 조회·LLM 호출은 하지 않는다 — 상위 파이프라인(M1-5 이후)이
 * url_hash로 캐시를 조회한 뒤 미스일 때만 이 함수를 부른다.
 */

/** 등록된 사이트 어댑터 (선언 순서대로 매칭 시도) — 새 사이트는 여기에 추가 */
const SITE_ADAPTERS: SiteAdapter[] = [wantedAdapter, saraminAdapter];

/** 최종 본문으로 인정할 최소 길이 — 미만이면 붙여넣기 폴백 안내 */
const MIN_BODY_LENGTH = 50;

export async function scrapeJobPosting(
  rawUrl: string,
  options: FetchHtmlOptions & { now?: () => Date } = {}
): Promise<ScrapedPosting> {
  const { now = () => new Date(), ...fetchOptions } = options;

  const normalizedUrl = normalizeUrl(rawUrl);
  const url = parseHttpUrl(normalizedUrl);

  const { html } = await fetchHtml(url, fetchOptions);

  const adapter = SITE_ADAPTERS.find((a) => a.matches(url));
  let sourceSite = adapter?.sourceSite ?? genericAdapter.sourceSite;
  let content: ExtractedContent | null = null;

  // 본문이 별도 문서에 있는 사이트(사람인 iframe 등) — 상세 문서를 추가 수집해 우선 추출.
  // 상세 수집·추출이 실패하면 조용히 메인 페이지 추출로 내려간다.
  const detailUrl = adapter?.detailUrl?.(url) ?? null;
  if (adapter && detailUrl !== null) {
    try {
      const { html: detailHtml } = await fetchHtml(detailUrl, fetchOptions);
      content = adapter.extract(detailHtml);
      if (content !== null) {
        // 상세 문서의 title은 무의미한 경우가 많다("채용공고 상세") —
        // 실제 공고명이 있는 메인 페이지 메타를 우선한다
        const mainMeta = extractPageMeta(loadHtml(html));
        content = {
          ...content,
          title: mainMeta.title ?? content.title,
          siteName: content.siteName ?? mainMeta.siteName,
        };
      }
    } catch {
      content = null;
    }
  }

  // 전용 어댑터(메인 페이지) → 실패 시 범용 추출기 폴백
  if (content === null) content = adapter?.extract(html) ?? null;
  if (content === null) {
    sourceSite = genericAdapter.sourceSite;
    content = genericAdapter.extract(html);
  }

  const bodyText = content === null ? "" : cleanText(content.bodyText);
  if (bodyText.length < MIN_BODY_LENGTH) {
    throw new ScrapeError(
      "empty_content",
      `본문을 추출하지 못했습니다: ${normalizedUrl} — 본문 붙여넣기로 안내`
    );
  }

  return {
    sourceSite,
    url: rawUrl.trim(),
    normalizedUrl,
    urlHash: urlHash(normalizedUrl),
    title: content?.title ?? null,
    siteName: content?.siteName ?? null,
    bodyText,
    snapshotHash: snapshotHash(bodyText),
    fetchedAt: now().toISOString(),
  };
}

/**
 * 수집 실패 폴백: 본문 붙여넣기 입력 — AI_ANALYSIS_DESIGN.md 8장.
 * source_site: manual_paste로 동일 파이프라인(구조화 단계)에 진입한다.
 */
export function manualPastePosting(
  pastedText: string,
  options: { now?: () => Date } = {}
): ScrapedPosting {
  const { now = () => new Date() } = options;

  const bodyText = cleanText(pastedText);
  if (bodyText.length < MIN_BODY_LENGTH) {
    throw new ScrapeError("empty_content", "붙여넣은 본문이 너무 짧습니다");
  }

  return {
    sourceSite: "manual_paste",
    url: null,
    normalizedUrl: null,
    urlHash: null,
    title: null,
    siteName: null,
    bodyText,
    snapshotHash: snapshotHash(bodyText),
    fetchedAt: now().toISOString(),
  };
}

// 상위 파이프라인·테스트에서 쓰는 공개 API 재노출
export { ScrapeError } from "./types";
export type { ScrapedPosting, ScrapeErrorCode, SiteAdapter, SourceSite } from "./types";
export { normalizeUrl, urlHash, snapshotHash } from "./url";
export { cleanText } from "./clean";
export { fetchHtml, SCRAPER_USER_AGENT } from "./fetch";
