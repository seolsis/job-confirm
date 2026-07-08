import { waitForHostSlot } from "./rate-limit";
import { isAllowedByRobots } from "./robots";
import { ScrapeError } from "./types";

/**
 * HTML 수집 모듈 — ARCHITECTURE.md 3.2 (서버사이드 fetch).
 *
 * robots.txt 확인과 호스트별 요청 간격 제한을 내장한다 (PRD 7.2 컴플라이언스).
 * fetchFn을 주입할 수 있어 네트워크 없이 단위 테스트할 수 있다.
 */

/** 수집 봇 식별자 — robots.txt의 User-agent 매칭에도 쓰인다 */
export const SCRAPER_USER_AGENT = "JobConfirmBot/0.1 (+https://github.com/seolsis/job-confirm)";

const DEFAULT_TIMEOUT_MS = 10_000;
/** 응답 크기 상한 (문자 수) — 비정상적으로 큰 페이지 방어 */
const MAX_HTML_LENGTH = 3_000_000;

export interface FetchHtmlOptions {
  /** 테스트 주입용. 기본값은 전역 fetch */
  fetchFn?: typeof fetch;
  /** robots.txt 확인을 건너뛸지 (테스트용. 운영에서는 항상 확인) */
  skipRobotsCheck?: boolean;
  /** 호스트별 요청 간격 제한을 건너뛸지 (테스트용) */
  skipRateLimit?: boolean;
  timeoutMs?: number;
  userAgent?: string;
}

export interface FetchedHtml {
  html: string;
  /** 리다이렉트를 따라간 최종 URL */
  finalUrl: string;
}

export async function fetchHtml(url: URL, options: FetchHtmlOptions = {}): Promise<FetchedHtml> {
  const {
    fetchFn = fetch,
    skipRobotsCheck = false,
    skipRateLimit = false,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    userAgent = SCRAPER_USER_AGENT,
  } = options;

  if (!skipRobotsCheck) {
    const allowed = await isAllowedByRobots(url, userAgent, fetchFn);
    if (!allowed) {
      throw new ScrapeError(
        "disallowed_by_robots",
        `robots.txt가 수집을 금지합니다: ${url.href} — 본문 붙여넣기로 안내`
      );
    }
  }

  if (!skipRateLimit) {
    await waitForHostSlot(url.host);
  }

  let response: Response;
  try {
    response = await fetchFn(url.href, {
      headers: {
        "user-agent": userAgent,
        accept: "text/html,application/xhtml+xml",
        "accept-language": "ko,en;q=0.8",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    throw new ScrapeError("fetch_failed", `요청 실패 (네트워크/타임아웃): ${url.href}`, { cause });
  }

  if (!response.ok) {
    throw new ScrapeError("fetch_failed", `HTTP ${response.status}: ${url.href}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType && !contentType.includes("html")) {
    throw new ScrapeError(
      "unsupported_content",
      `HTML이 아닌 응답 (${contentType}): ${url.href} — 텍스트 복사 안내`
    );
  }

  const html = await response.text();
  return {
    html: html.length > MAX_HTML_LENGTH ? html.slice(0, MAX_HTML_LENGTH) : html,
    finalUrl: response.url || url.href,
  };
}
