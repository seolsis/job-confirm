import { NextResponse, type NextRequest } from "next/server";

import { ensureProfile } from "@/lib/db/profiles";
import { createRouteHandlerSupabaseClient } from "@/lib/supabase/server";

/**
 * GET /auth/callback — Google OAuth 복귀 지점 (M2-6, PRD S2).
 *
 * 브라우저의 signInWithOAuth(PKCE)가 Google → Supabase를 거쳐 여기로
 * ?code=... 를 들고 돌아온다. 서버에서 코드를 세션으로 교환하면
 * @supabase/ssr이 세션 쿠키를 심는다 (code verifier는 브라우저 클라이언트가
 * 쿠키에 남겨둔 것을 서버가 읽는다 — 공식 Next.js 패턴).
 *
 * 교환 후 목적지:
 *  - 프로필이 비어 있으면(첫 Google 가입) 온보딩으로 — 가입 트리거가
 *    jobConfirm_profiles 행을 만들지만 내용은 비어 있다
 *  - 아니면 ?next=<가드가 보존한 경로> 또는 공고 입력 화면
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const nextParam = searchParams.get("next");
  const next = nextParam !== null && nextParam.startsWith("/") ? nextParam : "/analyze";

  if (code !== null) {
    const supabase = await createRouteHandlerSupabaseClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);

    if (error === null && data.user !== null) {
      // 트리거 이전 계정·트리거 실패 대비 self-heal 포함 (M2-1의 profiles 자동 생성 확인)
      const profile = await ensureProfile(supabase, data.user.id);
      const target = profile.completeness === 0 ? "/profile/onboarding" : next;
      return NextResponse.redirect(`${origin}${target}`);
    }
    console.error("[auth/callback] 코드 교환 실패", error);
  }

  return NextResponse.redirect(`${origin}/login?error=oauth`);
}
