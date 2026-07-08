import { createBrowserClient } from "@supabase/ssr";

import { supabaseAnonKey, supabaseUrl } from "./env";

/**
 * 브라우저 클라이언트 (anon key) — ARCHITECTURE.md 3.4
 *
 * 사용처: Client Component에서의 화면 조회·취준탭 CRUD, Realtime 구독.
 * 접근 범위는 전적으로 RLS 정책이 보호한다.
 *
 * 이 Supabase 프로젝트는 다른 프로젝트와 공유되므로
 * 테이블 접근 시 반드시 "jobConfirm_" 접두사 테이블만 사용한다.
 */
export function createBrowserSupabaseClient() {
  return createBrowserClient(supabaseUrl(), supabaseAnonKey());
}
