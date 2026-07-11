"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";

import { createBrowserSupabaseClient } from "@/lib/supabase/browser";

import { GoogleSignInButton } from "../google-signin-button";

/**
 * S2 — 회원가입 (PRD 3.1). 새 친구를 맞이하는 문.
 * 이메일 + Google OAuth (M2-6 — Google 가입은 /auth/callback에서 온보딩으로 이어진다).
 *
 * 가입 성공 시 DB 트리거("jobConfirm_on_auth_user_created")가
 * jobConfirm_profiles 행을 자동 생성한다 (마이그레이션 4.1절).
 *
 * Supabase 프로젝트의 이메일 확인(Confirm email) 설정에 따라 두 경로로 갈린다:
 *  - 확인 꺼짐: 즉시 세션 발급 → 프로필 온보딩으로 이동
 *  - 확인 켜짐: 세션 없음 → 확인 메일 안내 표시
 */
export default function SignupPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [needsEmailConfirm, setNeedsEmailConfirm] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    const supabase = createBrowserSupabaseClient();
    const { data, error: signUpError } = await supabase.auth.signUp({ email, password });

    if (signUpError) {
      setSubmitting(false);
      setError(`가입에 실패했어: ${signUpError.message}`);
      return;
    }

    if (data.session === null) {
      // 이메일 확인이 켜져 있는 프로젝트 — 메일의 링크를 눌러야 로그인 가능
      setSubmitting(false);
      setNeedsEmailConfirm(true);
      return;
    }

    // 가입 직후 바로 프로필 온보딩으로 — 로그인→프로필→분석 흐름 (M2 목표)
    window.location.assign("/profile/onboarding");
  }

  if (needsEmailConfirm) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-sky-100 via-[#fef6e4] to-[#fef6e4] px-4 py-12">
        <div className="text-center">
          <span className="inline-block animate-float text-6xl" aria-hidden>
            📮🐶
          </span>
          <div className="bubble bubble-center mx-auto mt-4 max-w-xs text-sm text-stone-600">
            편지를 보냈어! 메일함을 확인해 줘.
          </div>
        </div>
        <div className="mt-6 w-full max-w-sm rounded-[2rem] border-2 border-amber-100 bg-white p-8 text-center shadow-[0_4px_0_#fde68a]">
          <h1 className="text-xl text-stone-700">확인 메일을 보냈어요</h1>
          <p className="mt-3 text-sm leading-relaxed text-stone-500">
            {email} 로 보낸 메일의 링크를 누르면 가입이 완료돼요. 완료 후{" "}
            <Link href="/login" className="text-amber-600 underline">
              로그인
            </Link>
            해 주세요.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-sky-100 via-[#fef6e4] to-[#fef6e4] px-4 py-12">
      <div className="text-center">
        <span className="inline-block animate-hop text-6xl" aria-hidden>
          🐶
        </span>
        <div className="bubble bubble-center mx-auto mt-4 max-w-xs text-sm text-stone-600">
          처음 왔구나! 반가워. 같이 여행할 준비를 해보자!
        </div>
      </div>

      <div className="mt-6 w-full max-w-sm rounded-[2rem] border-2 border-amber-100 bg-white p-8 shadow-[0_4px_0_#fde68a]">
        <h1 className="text-center text-2xl text-stone-700">여행 시작하기</h1>

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
            비밀번호 (6자 이상)
            <input
              type="password"
              required
              minLength={6}
              autoComplete="new-password"
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
            {submitting ? "가방 싸는 중… 🧳" : "가입하고 떠나기"}
          </button>
        </form>

        {/* 약관 동의 고지 (M4-5) */}
        <p className="mt-4 text-center text-xs text-stone-400">
          가입하면{" "}
          <Link href="/terms" className="underline">
            이용약관
          </Link>
          과{" "}
          <Link href="/privacy" className="underline">
            개인정보처리방침
          </Link>
          에 동의하는 것으로 봐요.
        </p>

        <p className="mt-6 text-center text-sm text-stone-500">
          이미 친구라면{" "}
          <Link href="/login" className="text-amber-600 underline">
            로그인
          </Link>
        </p>
      </div>
    </main>
  );
}
