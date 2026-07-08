import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { supabaseAnonKey, supabaseUrl } from "./env";

/**
 * 서버 클라이언트 (anon key + 요청의 세션 쿠키) — ARCHITECTURE.md 3.4
 *
 * Server Component와 Route Handler 양쪽에서 사용자 소유 데이터에 접근할 때 쓴다.
 * 요청 쿠키로 사용자를 식별하며, 접근 범위는 RLS 정책이 보호한다.
 *
 * 사용 예:
 *   // Server Component
 *   const supabase = await createServerSupabaseClient();
 *   const { data } = await supabase.from("jobConfirm_profiles").select().single();
 *
 *   // Route Handler (app/api/*)
 *   const supabase = await createServerSupabaseClient();
 *   const { data: { user } } = await supabase.auth.getUser();
 */
export async function createServerSupabaseClient() {
  const cookieStore = await cookies();

  return createServerClient(supabaseUrl(), supabaseAnonKey(), {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Server Component에서 호출되면 쿠키를 쓸 수 없어 여기로 온다.
          // 세션 토큰 갱신은 proxy.ts가 요청 단계에서 대신 수행하므로 무시해도 안전하다.
        }
      },
    },
  });
}

/**
 * Route Handler 헬퍼 — 서버 클라이언트와 동일하다.
 * Route Handler에서는 쿠키 쓰기가 가능하므로 위의 catch 경로를 타지 않는다.
 * 의미를 명확히 하고 싶을 때 이 별칭을 사용한다.
 */
export const createRouteHandlerSupabaseClient = createServerSupabaseClient;
