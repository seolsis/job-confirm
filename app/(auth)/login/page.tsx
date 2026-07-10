"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";

import { createBrowserSupabaseClient } from "@/lib/supabase/browser";

import { GoogleSignInButton } from "../google-signin-button";

/**
 * S2 — 로그인 (PRD 3.1). 강아지(🐶)가 마중 나오는 문.
 * 이메일 + Google OAuth (M2-6 — 콜백은 /auth/callback).
 *
 * 성공 시 전체 내비게이션(location.assign)으로 이동한다 — @supabase/ssr이 심은
 * 세션 쿠키를 서버(proxy·Route Handler)가 확실히 읽게 하기 위함.
 * 미인증으로 보호 경로에 접근하면 proxy가 ?next=<경로>를 붙여 여기로 보낸다.
 */

/** useSearchParams는 정적 페이지에서 Suspense 경계가 필요하다 (Next 규칙) */
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // OAuth 콜백 실패(/login?error=oauth) 안내로 시작할 수 있다
  const [error, setError] = useState<string | null>(
    searchParams.get("error") === "oauth"
      ? "Google 로그인에 실패했어… 다시 시도하거나 이메일로 로그인해 줘."
      : null
  );
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    const supabase = createBrowserSupabaseClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });

    if (signInError) {
      setSubmitting(false);
      setError(
        signInError.message === "Invalid login credentials"
          ? "이메일 또는 비밀번호가 맞지 않아…"
          : `로그인에 실패했어: ${signInError.message}`
      );
      return;
    }

    // proxy 가드가 붙여준 원래 목적지로 복귀 (없으면 공고 입력 화면)
    const next = new URLSearchParams(window.location.search).get("next");
    window.location.assign(next !== null && next.startsWith("/") ? next : "/analyze");
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-sky-100 via-[#fef6e4] to-[#fef6e4] px-4 py-12">
      <div className="text-center">
        <span className="inline-block animate-wiggle text-6xl" aria-hidden>
          🐶
        </span>
        <div className="bubble bubble-center mx-auto mt-4 max-w-xs text-sm text-stone-600">
          어서 와! 기다리고 있었어. 다시 만나서 반가워!
        </div>
      </div>

      <div className="mt-6 w-full max-w-sm rounded-[2rem] border-2 border-amber-100 bg-white p-8 shadow-[0_4px_0_#fde68a]">
        <h1 className="text-center text-2xl text-stone-700">다시 떠나기</h1>

        <div className="mt-6">
          <GoogleSignInButton />
        </div>

        <div className="mt-5 flex items-center gap-3 text-xs text-stone-300" aria-hidden>
          <span className="h-px flex-1 bg-amber-100" />
          또는 이메일로
          <span className="h-px flex-1 bg-amber-100" />
        </div>

        <form onSubmit={handleSubmit} className="mt-5 space-y-4">
          <label className="block text-sm text-stone-600">
            이메일
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1.5 w-full rounded-2xl border-2 border-amber-100 bg-white px-4 py-2.5 text-sm text-stone-700 outline-none placeholder:text-stone-300 focus:border-amber-300"
            />
          </label>
          <label className="block text-sm text-stone-600">
            비밀번호
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1.5 w-full rounded-2xl border-2 border-amber-100 bg-white px-4 py-2.5 text-sm text-stone-700 outline-none placeholder:text-stone-300 focus:border-amber-300"
            />
          </label>

          {error !== null && (
            <p className="rounded-2xl border-2 border-rose-100 bg-rose-50 px-4 py-3 text-sm text-rose-600">
              🥺 {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-full bg-amber-300 py-3 text-sm text-amber-950 shadow-[0_4px_0_#f59e0b] transition-transform hover:-translate-y-0.5 active:translate-y-0.5 active:shadow-none disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none"
          >
            {submitting ? "문 여는 중… 🔑" : "로그인"}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-stone-500">
          아직 친구가 아니라면{" "}
          <Link href="/signup" className="text-amber-600 underline">
            여행 시작하기
          </Link>
        </p>
      </div>
    </main>
  );
}
