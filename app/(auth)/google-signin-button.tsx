"use client";

import { useState } from "react";

import { createBrowserSupabaseClient } from "@/lib/supabase/browser";

/**
 * Google 로그인 버튼 (M2-6) — 로그인·회원가입 화면 공용.
 *
 * signInWithOAuth(PKCE)로 Google에 다녀온 뒤 /auth/callback이 코드를 세션으로
 * 교환한다. 가드가 보존한 ?next= 목적지는 callback까지 전달한다.
 * credential(Client ID/Secret)은 Supabase 대시보드에만 있다 — 앱 코드는 무관.
 */
export function GoogleSignInButton() {
  const [starting, setStarting] = useState(false);

  async function handleClick() {
    setStarting(true);
    const supabase = createBrowserSupabaseClient();
    const next = new URLSearchParams(window.location.search).get("next");
    const redirectTo = `${window.location.origin}/auth/callback${
      next !== null && next.startsWith("/") ? `?next=${encodeURIComponent(next)}` : ""
    }`;

    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo },
    });
    if (error) setStarting(false); // 성공 시엔 Google로 전체 이동하므로 되돌릴 필요 없음
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={starting}
      className="flex w-full items-center justify-center gap-2 rounded-full border-2 border-amber-100 bg-white py-3 text-sm text-stone-600 transition-transform hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-60"
    >
      <GoogleMark />
      {starting ? "Google로 가는 중…" : "Google로 함께 가기"}
    </button>
  );
}

/** Google "G" 마크 (인라인 SVG — 외부 에셋 없이) */
function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}
