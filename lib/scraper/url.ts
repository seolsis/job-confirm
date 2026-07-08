import { createHash } from "node:crypto";

import { ScrapeError } from "./types";

/**
 * URL 정규화 + 해시 — AI_ANALYSIS_DESIGN.md 2장 [0] 전처리.
 *
 * 같은 공고를 가리키는 URL 변형(트래킹 파라미터, 해시 프래그먼트 등)을
 * 하나의 url_hash로 수렴시켜 구조화 캐시·중복 감지의 키로 쓴다.
 */

/**
 * 제거할 트래킹 파라미터.
 * 화이트리스트가 아닌 블랙리스트 방식인 이유: 채용 사이트는 공고 ID를
 * 쿼리 파라미터로 쓰는 경우가 많아(예: 사람인 rec_idx) 모르는 파라미터는 보존해야 한다.
 */
const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
  "igshid",
  "ref",
  "referrer",
  "src",
  "trk",
]);

/** http(s) URL로 파싱. 실패 시 ScrapeError("invalid_url") */
export function parseHttpUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch (cause) {
    throw new ScrapeError("invalid_url", `URL 형식이 아닙니다: ${rawUrl}`, { cause });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ScrapeError("invalid_url", `http(s) URL만 지원합니다: ${rawUrl}`);
  }
  return url;
}

/**
 * URL 정규화:
 *  - 호스트 소문자화 (URL 파서가 수행)
 *  - 해시 프래그먼트 제거
 *  - 트래킹 파라미터 제거
 *  - 남은 쿼리 파라미터 키 순 정렬 (순서만 다른 URL을 같은 키로)
 *  - 루트가 아닌 경로의 말단 슬래시 제거
 */
export function normalizeUrl(rawUrl: string): string {
  const url = parseHttpUrl(rawUrl);

  url.hash = "";

  const kept = [...url.searchParams.entries()].filter(
    ([key]) => !TRACKING_PARAMS.has(key.toLowerCase())
  );
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = new URLSearchParams(kept).toString();

  if (url.pathname !== "/" && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }

  return url.toString();
}

/** 정규화된 URL의 캐시 키 (job_postings.url_hash) */
export function urlHash(normalizedUrl: string): string {
  return sha256(normalizedUrl);
}

/** 본문 텍스트의 변경 감지 해시 (job_postings.snapshot_hash) */
export function snapshotHash(bodyText: string): string {
  return sha256(bodyText);
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
