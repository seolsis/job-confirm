import { describe, expect, it } from "vitest";

import { wantedAdapter } from "./wanted";

/**
 * 원티드 어댑터 단위 테스트 — 어댑터는 순수 함수이므로 픽스처 HTML로 검증한다.
 * __NEXT_DATA__ 1순위, JSON-LD 폴백, 둘 다 없으면 null (types.ts 계약).
 */

/** __NEXT_DATA__ 픽스처 — 실제 원티드 공고(/wd/*)의 initialData 구조 축약본 */
function htmlWithNextData(initialData: Record<string, unknown>): string {
  const payload = JSON.stringify({ props: { pageProps: { initialData } } });
  return `<html><head>
    <meta property="og:site_name" content="원티드" />
    <script id="__NEXT_DATA__" type="application/json">${payload}</script>
  </head><body></body></html>`;
}

const fullInitialData = {
  position: "백엔드 개발자",
  company: { company_name: "테스트컴퍼니" },
  address: { full_location: "서울 강남구 테헤란로 1", location: "서울" },
  career: { annual_from: 2, annual_to: 7, is_newbie: false },
  close_time: "2026-08-31",
  due_time: null,
  intro: "팀 소개입니다.",
  main_tasks: "• API 서버 개발",
  requirements: "• Python 3년 이상",
  preferred_points: "• AWS 운영 경험",
  benefits: "• 점심 지원",
};

const jsonLdHtml = `<html><head>
  <meta property="og:site_name" content="원티드" />
  <script type="application/ld+json">${JSON.stringify({
    "@type": "JobPosting",
    title: "백엔드 개발자",
    description: "<p>주요 업무 요약</p>",
    hiringOrganization: { name: "테스트컴퍼니" },
    validThrough: "2026-08-31",
  })}</script>
</head><body></body></html>`;

describe("wantedAdapter.matches", () => {
  it("wanted.co.kr 및 서브도메인만 처리한다", () => {
    expect(wantedAdapter.matches(new URL("https://www.wanted.co.kr/wd/1"))).toBe(true);
    expect(wantedAdapter.matches(new URL("https://wanted.co.kr/wd/1"))).toBe(true);
    expect(wantedAdapter.matches(new URL("https://www.saramin.co.kr/job/1"))).toBe(false);
  });
});

describe("wantedAdapter.extract — __NEXT_DATA__ 1순위", () => {
  it("자격요건·우대사항·혜택을 포함한 전체 본문을 만든다 (JSON-LD 요약 누락 이슈의 수정)", () => {
    const result = wantedAdapter.extract(htmlWithNextData(fullInitialData));

    expect(result).not.toBeNull();
    expect(result?.title).toBe("백엔드 개발자");
    expect(result?.siteName).toBe("원티드");
    expect(result?.bodyText).toContain("회사: 테스트컴퍼니");
    expect(result?.bodyText).toContain("경력: 2년 ~ 7년");
    expect(result?.bodyText).toContain("근무지: 서울 강남구 테헤란로 1");
    expect(result?.bodyText).toContain("마감: 2026-08-31");
    expect(result?.bodyText).toContain("[자격요건]");
    expect(result?.bodyText).toContain("• Python 3년 이상");
    expect(result?.bodyText).toContain("[우대사항]");
    expect(result?.bodyText).toContain("[혜택 및 복지]");
  });

  it("선택 필드(경력·근무지·마감·섹션)가 없어도 동작한다", () => {
    const result = wantedAdapter.extract(
      htmlWithNextData({
        position: "백엔드 개발자",
        company: { company_name: null },
        address: null,
        career: null,
        close_time: null,
        due_time: null,
        intro: null,
        main_tasks: "• API 서버 개발",
        requirements: null,
        preferred_points: null,
        benefits: null,
      })
    );

    expect(result?.bodyText).toContain("공고 제목: 백엔드 개발자");
    expect(result?.bodyText).toContain("[주요업무]");
    expect(result?.bodyText).not.toContain("[자격요건]");
    expect(result?.bodyText).not.toContain("경력:");
  });

  it("본문 섹션이 전부 비면 initialData를 버리고 폴백을 시도한다", () => {
    const result = wantedAdapter.extract(
      htmlWithNextData({ position: "백엔드 개발자", company: { company_name: null } })
    );
    expect(result).toBeNull(); // JSON-LD도 없으므로 범용 추출기 폴백 대상
  });
});

describe("wantedAdapter.extract — JSON-LD 폴백", () => {
  it("__NEXT_DATA__가 없으면 JSON-LD JobPosting을 파싱한다", () => {
    const result = wantedAdapter.extract(jsonLdHtml);

    expect(result).not.toBeNull();
    expect(result?.title).toBe("백엔드 개발자");
    expect(result?.bodyText).toContain("회사: 테스트컴퍼니");
    expect(result?.bodyText).toContain("주요 업무 요약");
  });

  it("둘 다 없으면 null을 반환한다 (범용 추출기 폴백)", () => {
    expect(wantedAdapter.extract("<html><body><p>본문</p></body></html>")).toBeNull();
  });
});
