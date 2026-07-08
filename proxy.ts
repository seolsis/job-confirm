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
 * (app) 라우트 그룹의 로그인 가드(미인증 시 /login 리다이렉트)는
 * 로그인 화면이 생기는 M2에서 이 파일에 추가한다.
 */
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
  await supabase.auth.getUser();

  return response;
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
