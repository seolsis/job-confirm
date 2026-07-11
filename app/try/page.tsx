"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";

import type { PostingExtraction } from "@/lib/ai/schemas";

/**
 * 비로그인 체험 (M4-3, PRD 2.5 전환 퍼널) — 공개 페이지.
 *
 * URL 하나로 공고 구조화(요건/우대/마감 정리)까지 무료로 보여주고,
 * "내 프로필과의 적합도"는 가입 CTA로 연결한다. 무료 3회 (쿠키 기준).
 */

export default function TryPage() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [extracted, setExtracted] = useState<PostingExtraction | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setExtracted(null);
    try {
      const response = await fetch("/api/try", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = (await response.json()) as {
        extracted?: PostingExtraction;
        remaining?: number;
        error?: string;
      };
      if (data.extracted !== undefined) {
        setExtracted(data.extracted);
        setRemaining(data.remaining ?? null);
      } else {
        setError(data.error ?? "처리에 실패했어요. 잠시 후 다시 시도해 주세요.");
      }
    } catch {
      setError("네트워크가 불안정한 것 같아요. 잠시 후 다시 시도해 주세요.");
    }
    setLoading(false);
  }

  return (
    <main className="min-h-screen bg-gradient-to-b from-sky-100 via-[#fef6e4] to-[#fef6e4] px-4 py-16">
      <nav className="fixed top-4 right-4 z-10 flex gap-2">
        <Link
          href="/login"
          className="rounded-full border-2 border-amber-100 bg-white/90 px-4 py-2 text-sm text-stone-600 shadow-sm transition-transform hover:-translate-y-0.5"
        >
          로그인
        </Link>
        <Link
          href="/signup"
          className="rounded-full bg-amber-300 px-4 py-2 text-sm text-amber-950 shadow-[0_3px_0_#f59e0b] transition-transform hover:-translate-y-0.5"
        >
          가입하기
        </Link>
      </nav>

      <div className="mx-auto w-full max-w-2xl">
        <div className="text-center">
          <span
            className={`inline-block text-6xl ${loading ? "animate-hop" : "animate-float"}`}
            aria-hidden
          >
            🦉
          </span>
          <div className="bubble bubble-center mx-auto mt-4 max-w-sm text-sm text-stone-600">
            {loading
              ? "부엉 박사가 공고를 정리하는 중… 30초쯤 걸려!"
              : "가입 없이 공고 정리를 체험해 봐! 요건·우대·마감을 한눈에 정리해 줄게."}
          </div>
        </div>

        <div className="mt-8 rounded-[2rem] border-2 border-amber-100 bg-white p-6 shadow-[0_4px_0_#fde68a] sm:p-8">
          <h1 className="text-center text-2xl text-stone-700">공고 정리, 무료로 체험하기</h1>
          <form onSubmit={handleSubmit} className="mt-6">
            <input
              type="url"
              required
              placeholder="https://www.wanted.co.kr/wd/..."
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="w-full rounded-2xl border-2 border-amber-100 bg-white px-5 py-4 text-sm text-stone-700 outline-none placeholder:text-stone-300 focus:border-amber-300"
            />
            {error !== null && (
              <p className="mt-3 rounded-2xl border-2 border-rose-100 bg-rose-50 px-4 py-3 text-sm text-rose-600">
                🥺 {error}
              </p>
            )}
            <button
              type="submit"
              disabled={loading}
              className="mt-4 w-full rounded-full bg-amber-300 py-4 text-base text-amber-950 shadow-[0_4px_0_#f59e0b] transition-transform hover:-translate-y-0.5 active:translate-y-0.5 active:shadow-none disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none"
            >
              {loading ? "정리하는 중… 🐾" : "공고 정리해 보기 🔍"}
            </button>
          </form>
          {remaining !== null && (
            <p className="mt-3 text-center text-xs text-stone-400">
              무료 체험 남은 횟수: {remaining}회
            </p>
          )}
        </div>

        {extracted !== null && (
          <div className="animate-pop-in mt-8 space-y-6">
            {/* 구조화 요약 */}
            <section className="rounded-[2rem] border-2 border-amber-100 bg-white p-6 shadow-[0_4px_0_#fde68a]">
              <p className="text-sm text-stone-400">{extracted.company_name ?? "회사명 없음"}</p>
              <h2 className="mt-1 text-xl text-stone-700">
                {extracted.job_title ?? "직무 정보 없음"}
              </h2>
              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                {extracted.deadline.date !== null && (
                  <span className="rounded-full bg-sky-50 px-2.5 py-1 text-sky-600">
                    ⏰ 마감 {extracted.deadline.date}
                  </span>
                )}
                {extracted.deadline.is_rolling && (
                  <span className="rounded-full bg-sky-50 px-2.5 py-1 text-sky-600">상시 채용</span>
                )}
                {extracted.location !== null && (
                  <span className="rounded-full bg-stone-50 px-2.5 py-1 text-stone-500">
                    📍 {extracted.location}
                  </span>
                )}
                {extracted.experience_level.raw_text !== null && (
                  <span className="rounded-full bg-stone-50 px-2.5 py-1 text-stone-500">
                    💼 {extracted.experience_level.raw_text}
                  </span>
                )}
              </div>

              {extracted.responsibilities.length > 0 && (
                <div className="mt-5">
                  <h3 className="text-sm text-stone-700">📌 주요 업무</h3>
                  <ul className="mt-2 space-y-1 text-sm text-stone-600">
                    {extracted.responsibilities.map((item) => (
                      <li key={item}>· {item}</li>
                    ))}
                  </ul>
                </div>
              )}

              {extracted.requirements.length > 0 && (
                <div className="mt-5">
                  <h3 className="text-sm text-stone-700">✅ 자격 요건</h3>
                  <ul className="mt-2 space-y-1 text-sm text-stone-600">
                    {extracted.requirements.map((item) => (
                      <li key={item.text}>· {item.text}</li>
                    ))}
                  </ul>
                </div>
              )}

              {extracted.preferences.length > 0 && (
                <div className="mt-5">
                  <h3 className="text-sm text-stone-700">🌟 우대 사항</h3>
                  <ul className="mt-2 space-y-1 text-sm text-stone-600">
                    {extracted.preferences.map((item) => (
                      <li key={item.text}>· {item.text}</li>
                    ))}
                  </ul>
                </div>
              )}
            </section>

            {/* 전환 CTA (PRD 2.5) — 적합도는 가입 후 */}
            <section className="rounded-[2rem] border-2 border-sky-100 bg-white/90 p-6 text-center shadow-[0_4px_0_#bae6fd]">
              <div className="flex justify-center gap-3 text-3xl" aria-hidden>
                🐰🐢🐥
              </div>
              <p className="mt-3 text-base text-stone-700">
                이 공고, <strong className="text-amber-600">나한테 맞을까?</strong>
              </p>
              <p className="mt-1 text-sm text-stone-500">
                가입하고 프로필을 입력하면 요건별 충족 여부, 적합도 점수, 예상 면접 질문까지
                친구들이 다 봐줄게!
              </p>
              <Link
                href="/signup"
                className="mt-4 inline-block rounded-full bg-amber-300 px-8 py-3.5 text-sm text-amber-950 shadow-[0_4px_0_#f59e0b] transition-transform hover:-translate-y-0.5 active:translate-y-0.5 active:shadow-none"
              >
                무료로 가입하고 내 적합도 보기 →
              </Link>
            </section>
          </div>
        )}

        <p className="mt-8 text-center text-xs text-stone-400">
          정리 결과는 참고용이에요. 최종 판단은 공고 원문을 확인한 뒤 해주세요.
        </p>
      </div>
    </main>
  );
}
