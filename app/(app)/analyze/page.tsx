"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";

/**
 * S4 — 메인 공고 입력 (PRD 3.2). "동물 친구들의 모험" 컨셉:
 * 토돌이(🐰)에게 공고를 건네주는 화면. 검색엔진처럼 단순하게.
 *
 * URL 입력 + 붙여넣기 폴백(수집 실패 대응, PRD 7.1의 MVP 필수 항목).
 * POST /api/analyses는 파이프라인을 동기로 완주하므로(수십 초) 제출 중에는
 * 친구들이 일하는 연출을 보여주고, 성공/실패 모두 jobId가 있으면
 * S6(/analyze/{jobId})로 이동한다 — 실패한 잡도 error_code 안내를 S6가 표시한다.
 */

type InputMode = "url" | "paste";

export default function AnalyzeInputPage() {
  const [mode, setMode] = useState<InputMode>("url");
  const [url, setUrl] = useState("");
  const [pastedText, setPastedText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsProfile, setNeedsProfile] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNeedsProfile(false);
    setSubmitting(true);

    try {
      const response = await fetch("/api/analyses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(mode === "url" ? { url } : { pastedText }),
      });
      const data = (await response.json()) as {
        jobId?: string;
        error?: string;
        code?: string;
        errorCode?: string;
      };

      // 성공이든 파이프라인 실패든 잡이 만들어졌다면 S6가 상태를 보여준다
      if (typeof data.jobId === "string") {
        window.location.assign(`/analyze/${data.jobId}`);
        return;
      }
      if (data.code === "profile_required") {
        setNeedsProfile(true);
        setSubmitting(false);
        return;
      }
      setError(data.error ?? "분석 요청에 실패했어. 잠시 후 다시 시도해 줄래?");
      setSubmitting(false);
    } catch {
      setError("네트워크가 불안정한 것 같아. 잠시 후 다시 시도해 줘!");
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-sky-100 via-[#fef6e4] to-[#fef6e4] px-4 py-16">
      <div className="w-full max-w-2xl">
        {/* 토돌이의 인사 */}
        <div className="text-center">
          <span
            className={`inline-block text-6xl ${submitting ? "animate-hop" : "animate-float"}`}
            aria-hidden
          >
            🐰
          </span>
          <div className="bubble bubble-center mx-auto mt-4 max-w-sm text-sm text-stone-600">
            {submitting
              ? "친구들이 출발했어! 공고를 살펴보고 올게."
              : "궁금한 공고를 보여줘! 너한테 맞는지 같이 봐줄게."}
          </div>
        </div>

        <div className="mt-8 rounded-[2rem] border-2 border-amber-100 bg-white p-6 shadow-[0_4px_0_#fde68a] sm:p-8">
          <h1 className="text-center text-2xl text-stone-700">이 공고, 나한테 맞을까?</h1>

          {/* 입력 방식 토글 — URL / 본문 붙여넣기 폴백 */}
          <div className="mt-6 flex justify-center gap-1 rounded-full bg-amber-50 p-1">
            <ModeButton active={mode === "url"} onClick={() => setMode("url")}>
              🔗 URL로 분석
            </ModeButton>
            <ModeButton active={mode === "paste"} onClick={() => setMode("paste")}>
              📋 본문 붙여넣기
            </ModeButton>
          </div>

          <form onSubmit={handleSubmit} className="mt-4">
            {mode === "url" ? (
              <input
                type="url"
                required
                placeholder="https://www.wanted.co.kr/wd/..."
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                className="w-full rounded-2xl border-2 border-amber-100 bg-white px-5 py-4 text-sm text-stone-700 outline-none placeholder:text-stone-300 focus:border-amber-300"
              />
            ) : (
              <textarea
                required
                rows={10}
                placeholder="공고 본문을 통째로 붙여넣어 줘 (다람이가 못 가는 사이트도 분석할 수 있어!)"
                value={pastedText}
                onChange={(e) => setPastedText(e.target.value)}
                className="w-full rounded-2xl border-2 border-amber-100 bg-white px-5 py-4 text-sm text-stone-700 outline-none placeholder:text-stone-300 focus:border-amber-300"
              />
            )}

            {error !== null && (
              <p className="mt-3 rounded-2xl border-2 border-rose-100 bg-rose-50 px-4 py-3 text-sm text-rose-600">
                🥺 {error}
              </p>
            )}
            {needsProfile && (
              <div className="mt-3 rounded-2xl border-2 border-amber-100 bg-amber-50 p-4 text-sm text-amber-800">
                🐥 먼저 너에 대해 알려줘야 비교할 수 있어!{" "}
                <Link href="/profile/onboarding" className="underline">
                  1분 만에 프로필 입력하기
                </Link>
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="mt-4 w-full rounded-full bg-amber-300 py-4 text-base text-amber-950 shadow-[0_4px_0_#f59e0b] transition-transform hover:-translate-y-0.5 active:translate-y-0.5 active:shadow-none disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none"
            >
              {submitting ? "친구들이 분석하는 중… 🐾" : "분석 부탁하기 🔍"}
            </button>
          </form>

          {/* 제출 중 — 친구들이 순서대로 일하러 가는 연출 (hop + 시차) */}
          {submitting && (
            <div className="mt-6 text-center" aria-hidden>
              <div className="flex justify-center gap-4 text-3xl">
                {["🐿️", "🦉", "🐰", "🐢"].map((friend, index) => (
                  <span
                    key={friend}
                    className="animate-hop inline-block"
                    style={{ animationDelay: `${index * 0.15}s` }}
                  >
                    {friend}
                  </span>
                ))}
              </div>
              <p className="mt-3 text-xs text-stone-400">30초 정도 걸려. 조금만 기다려 줘!</p>
            </div>
          )}
        </div>

        <p className="mt-8 text-center text-xs text-stone-400">
          친구들의 분석은 참고용이에요. 최종 판단은 공고 원문을 확인한 뒤 해주세요.
        </p>
      </div>
    </main>
  );
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-4 py-2 text-sm transition-colors ${
        active ? "bg-white text-amber-700 shadow-sm" : "text-stone-400 hover:text-stone-600"
      }`}
    >
      {children}
    </button>
  );
}
