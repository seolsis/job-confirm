import { describe, expect, it } from "vitest";

import { saraminAdapter } from "./saramin";

/**
 * 사람인 어댑터 단위 테스트 — 네트워크 없음.
 * 핵심: 메인 페이지에는 본문이 없으므로(2026-07-10 실측) detailUrl로
 * 상세 문서(relay/view-detail)를 지목하고, 그 문서에서 본문을 뽑는다.
 */

describe("saraminAdapter.matches", () => {
  it("saramin.co.kr 도메인만 처리한다", () => {
    expect(
      saraminAdapter.matches(new URL("https://www.saramin.co.kr/zf_user/jobs/relay/view?rec_idx=1"))
    ).toBe(true);
    expect(saraminAdapter.matches(new URL("https://saramin.co.kr/x"))).toBe(true);
    expect(saraminAdapter.matches(new URL("https://www.wanted.co.kr/wd/1"))).toBe(false);
    expect(saraminAdapter.matches(new URL("https://evil.com/?host=saramin.co.kr"))).toBe(false);
  });
});

describe("saraminAdapter.detailUrl (본문이 담긴 상세 문서)", () => {
  it("rec_idx가 있으면 view-detail URL을 만든다", () => {
    const detail = saraminAdapter.detailUrl!(
      new URL("https://www.saramin.co.kr/zf_user/jobs/relay/view?rec_idx=54403748&view_type=list")
    );
    expect(detail?.href).toBe(
      "https://www.saramin.co.kr/zf_user/jobs/relay/view-detail?rec_idx=54403748"
    );
  });

  it("rec_idx가 없으면 null (목록·기타 페이지)", () => {
    expect(
      saraminAdapter.detailUrl!(new URL("https://www.saramin.co.kr/zf_user/jobs/list"))
    ).toBeNull();
    expect(
      saraminAdapter.detailUrl!(
        new URL("https://www.saramin.co.kr/zf_user/jobs/relay/view?rec_idx=")
      )
    ).toBeNull();
  });
});

describe("saraminAdapter.extract", () => {
  const detailHtml = `<!doctype html><html lang="ko"><head><title>채용공고 상세</title></head>
  <body><div class="user_content">
    <p>모집부문: 백엔드 개발자</p>
    <p>자격요건: Python 기반 서버 개발 3년 이상, RDBMS 설계 및 운영 경험, 협업 도구 사용 능력</p>
    <p>우대사항: AWS 운영 경험, 대용량 트래픽 처리 경험</p>
  </div></body></html>`;

  it("상세 문서의 .user_content에서 본문을 뽑는다", () => {
    const content = saraminAdapter.extract(detailHtml);

    expect(content).not.toBeNull();
    expect(content!.bodyText).toContain("자격요건: Python 기반 서버 개발 3년 이상");
    expect(content!.bodyText).toContain("우대사항: AWS 운영 경험");
  });

  it("본문 선택자가 전부 비면 null (범용 추출기 폴백 대상)", () => {
    expect(
      saraminAdapter.extract("<html><body><div class='jview'>짧음</div></body></html>")
    ).toBeNull();
  });
});
