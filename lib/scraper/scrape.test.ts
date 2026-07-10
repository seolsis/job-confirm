import { describe, expect, it } from "vitest";

import { clearRobotsCache } from "./robots";
import { scrapeJobPosting, ScrapeError } from "./index";

/**
 * 수집 오케스트레이터의 상세 문서(detailUrl) 흐름 테스트 — fetch 주입, 네트워크 없음.
 * 사람인처럼 본문이 별도 문서에 있는 사이트에서:
 *  1) 상세 문서를 추가 수집해 본문을 뽑고, 제목은 메인 페이지 메타를 쓴다
 *  2) 상세 수집이 실패하면 메인 페이지 추출로 조용히 폴백한다
 */

const MAIN_URL = "https://www.saramin.co.kr/zf_user/jobs/relay/view?rec_idx=99&view_type=list";

const mainHtml = `<!doctype html><html lang="ko"><head>
  <title>[테스트컴퍼니] 백엔드 개발자 채용 - 사람인</title>
  <meta property="og:site_name" content="사람인">
</head><body><div class="jview"><h1>백엔드 개발자</h1></div></body></html>`;

const detailHtml = `<!doctype html><html lang="ko"><head><title>채용공고 상세</title></head>
<body><div class="user_content">
  <p>주요업무: 커머스 백엔드 API 서버 설계·개발·운영, 데이터 파이프라인 구축과 성능 개선을 담당합니다.</p>
  <p>자격요건: Python 기반 서버 개발 3년 이상, RDBMS 설계 및 운영 경험, Git 등 협업 도구 사용 능력이 필요합니다.</p>
  <p>우대사항: AWS 등 클라우드 운영 경험, 대용량 트래픽 처리 경험, 커머스 도메인 이해가 있으면 좋습니다.</p>
</div></body></html>`;

function makeFetch(handlers: Record<string, () => Response>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [match, respond] of Object.entries(handlers)) {
      if (url.includes(match)) return respond();
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

const htmlResponse = (body: string) =>
  new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });

describe("scrapeJobPosting — 상세 문서 수집 (사람인)", () => {
  it("상세 문서에서 본문을, 메인 페이지에서 제목을 가져온다", async () => {
    clearRobotsCache();
    const fetchFn = makeFetch({
      "robots.txt": () => htmlResponse("User-agent: *\nAllow: /"),
      "view-detail": () => htmlResponse(detailHtml),
      "relay/view": () => htmlResponse(mainHtml),
    });

    const posting = await scrapeJobPosting(MAIN_URL, { fetchFn, skipRateLimit: true });

    expect(posting.sourceSite).toBe("saramin");
    expect(posting.bodyText).toContain("자격요건: Python 기반 서버 개발 3년 이상");
    // 상세 문서 title("채용공고 상세")이 아니라 메인 페이지의 실제 공고명
    expect(posting.title).toBe("[테스트컴퍼니] 백엔드 개발자 채용 - 사람인");
    expect(posting.siteName).toBe("사람인");
  });

  it("상세 수집이 실패하면 메인 페이지 추출로 폴백한다 (여기선 본문 부족 → empty_content)", async () => {
    clearRobotsCache();
    const fetchFn = makeFetch({
      "robots.txt": () => htmlResponse("User-agent: *\nAllow: /"),
      "view-detail": () => new Response("blocked", { status: 403 }),
      "relay/view": () => htmlResponse(mainHtml), // 메인에는 본문이 없다 (실측과 동일)
    });

    const error = await scrapeJobPosting(MAIN_URL, { fetchFn, skipRateLimit: true }).catch(
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(ScrapeError);
    expect((error as ScrapeError).code).toBe("empty_content");
  });
});
