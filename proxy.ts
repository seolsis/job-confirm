import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { supabaseAnonKey, supabaseUrl } from "@/lib/supabase/env";

/**
 * Supabase 세션 갱신 프록시.
 *
 * Next.js 16에서 middleware.ts가 proxy.ts로 개명되었다 (역할 동일).
 *
 * 역할: 만료된 세션 토큰을 요청 단계에서 선제 갱신하고, 갱신된 쿠키를
 * 요청(이후의 Server Component가 읽음)과 응답(브라우저에 저장) 양쪽에 반영한다.
 * Server Component는 쿠키를 쓸 수 없으므로 갱신은 반드시 여기서 일어나야 한다.
 *
 * 추가 역할 (M2-1): (app) 라우트 그룹의 로그인 가드 —
 * 미인증 사용자가 보호 경로에 오면 /login?next=<경로>로 보내고,
 * 로그인된 사용자가 인증 화면에 오면 홈으로 돌려보낸다.
 */

/** 로그인 필수 경로 접두사 — app/(app) 라우트 그룹과 1:1 (ARCHITECTURE.md 5장) */
const PROTECTED_PREFIXES = ["/analyze", "/board", "/profile", "/settings"];
/** 로그인 상태로 볼 필요 없는 인증 화면 */
const AUTH_PAGES = ["/login", "/signup"];

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(supabaseUrl(), supabaseAnonKey(), {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        // 갱신된 토큰을 같은 요청을 읽는 Server Component에도 보이게 하고,
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        // 브라우저에도 저장되게 응답 쿠키로도 내려보낸다.
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options)
        );
      },
    },
  });

  // 세션이 있으면 검증·갱신한다 (없으면 no-op).
  // 주의: createServerClient와 auth.getUser() 사이에 다른 로직을 넣지 말 것 —
  // 토큰 갱신 전에 세션을 읽으면 무작위 로그아웃 문제가 생길 수 있다.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;

  // 미인증 → 보호 경로 차단 (로그인 후 원래 목적지로 복귀하도록 next 전달)
  if (
    user === null &&
    PROTECTED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
  ) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    url.searchParams.set("next", path);
    return withResponseCookies(NextResponse.redirect(url), response);
  }

  // 로그인 상태 → 인증 화면은 공고 입력 화면으로
  if (user !== null && AUTH_PAGES.includes(path)) {
    const url = request.nextUrl.clone();
    url.pathname = "/analyze";
    url.search = "";
    return withResponseCookies(NextResponse.redirect(url), response);
  }

  return response;
}

/** 리다이렉트 응답에도 세션 갱신 쿠키를 실어 보낸다 (갱신 유실 방지) */
function withResponseCookies(redirect: NextResponse, from: NextResponse): NextResponse {
  for (const cookie of from.cookies.getAll()) {
    redirect.cookies.set(cookie);
  }
  return redirect;
}

export const config = {
  matcher: [
    /*
     * 다음을 제외한 모든 요청 경로에서 실행:
     * - _next/static (정적 파일)
     * - _next/image (이미지 최적화)
     * - favicon.ico 및 이미지 에셋
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
