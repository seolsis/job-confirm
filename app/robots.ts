import type { MetadataRoute } from "next";

/**
 * robots.txt (M4-5) — 공개 페이지만 색인 허용.
 * 로그인 뒤 화면·API는 크롤러가 볼 이유가 없다.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: ["/", "/try", "/login", "/signup", "/terms", "/privacy"],
      disallow: ["/api/", "/analyze", "/board", "/profile", "/settings", "/admin", "/auth/"],
    },
  };
}
