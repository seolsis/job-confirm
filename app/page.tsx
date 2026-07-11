"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";

/**
 * S1 — 랜딩: "취업 준비를 함께하는 동물 친구들의 모험" (스크롤 스토리)
 *
 * 스크롤 자체가 이야기 진행이다:
 *   장면1 하늘 — 열기구를 탄 곰이 여행을 제안한다
 *   장면2 구름길 — 스크롤하면 토끼가 구름 위를 걸어 화면을 가로지른다 (sticky 스테이지)
 *   장면3 숲 — 친구들이 각자 맡은 일을 소개한다 (스크롤 등장)
 *   장면4 섬 — 도착. 여행 시작 CTA
 *
 * 60fps 설계:
 *  - 스크롤 리스너는 passive 1개 + rAF 스로틀. 프레임당 rect 측정 1회 →
 *    CSS 변수(--sp)만 갱신하고, 실제 이동은 transform(컴포지터)으로 처리
 *  - 등장 연출은 IntersectionObserver(클래스 토글) — 스크롤마다 JS 실행 없음
 *  - 모든 keyframe은 transform/opacity 전용 (globals.css)
 */
export default function LandingPage() {
  const walkSceneRef = useRef<HTMLDivElement>(null);

  // 장면2: 스크롤 진행도(0~1)를 --sp로 — 토끼의 가로 이동에 쓰인다
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const scene = walkSceneRef.current;
    if (scene === null) return;

    let rafId = 0;
    let scheduled = false;
    const update = () => {
      scheduled = false;
      const rect = scene.getBoundingClientRect(); // 프레임당 1회 읽기 → 이후 쓰기만
      const total = rect.height - window.innerHeight;
      const progress = total > 0 ? Math.min(1, Math.max(0, -rect.top / total)) : 0;
      scene.style.setProperty("--sp", progress.toFixed(4));
    };
    const onScroll = () => {
      if (!scheduled) {
        scheduled = true;
        rafId = requestAnimationFrame(update);
      }
    };

    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(rafId);
    };
  }, []);

  // 장면3·4: 보이는 순간 .on을 붙여 등장 (transform/opacity 트랜지션)
  useEffect(() => {
    const targets = document.querySelectorAll(".reveal");
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("on");
            observer.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.25 }
    );
    targets.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  return (
    <div className="overflow-x-clip">
      {/* ── 장면 1 · 하늘 — 여행의 시작 ─────────────────────────────────── */}
      <section className="relative flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-sky-200 via-sky-100 to-[#fef6e4] px-4 text-center">
        {/* 떠다니는 구름 (drift — transform 전용) */}
        <Cloud className="top-[12%] text-6xl" duration={46} delay={-8} />
        <Cloud className="top-[24%] text-4xl" duration={62} delay={-30} />
        <Cloud className="top-[8%] text-5xl" duration={54} delay={-46} />

        <div className="animate-float text-7xl" aria-hidden>
          🎈🐻
        </div>
        <div className="bubble bubble-center mt-6 max-w-xs text-sm text-stone-600">
          안녕! 취업 준비, 혼자 하면 외롭잖아. 우리랑 같이 갈래?
        </div>

        <h1 className="mt-8 text-4xl leading-snug text-stone-700 sm:text-5xl">
          취업 준비를 함께하는
          <br />
          <span className="text-amber-500">동물 친구들의 모험</span>
        </h1>
        <p className="mt-4 max-w-md text-sm leading-relaxed text-stone-500">
          공고 URL을 건네주면 친구들이 물어오고, 정리하고, 너와 비교해서
          <br className="hidden sm:block" />이 공고가 너에게 맞는지 알려줄게.
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/signup"
            className="rounded-full bg-amber-300 px-8 py-3.5 text-base text-amber-950 shadow-[0_4px_0_#f59e0b] transition-transform hover:-translate-y-0.5 active:translate-y-0.5 active:shadow-none"
          >
            여행 떠나기 🧳
          </Link>
          <Link
            href="/login"
            className="rounded-full border-2 border-amber-200 bg-white/70 px-6 py-3 text-sm text-stone-600 transition-transform hover:-translate-y-0.5"
          >
            이미 친구예요
          </Link>
        </div>

        {/* 비로그인 체험 진입 (M4-3, PRD 2.5 전환 퍼널) */}
        <Link
          href="/try"
          className="mt-4 text-sm text-stone-500 underline decoration-amber-300 decoration-2 underline-offset-4 transition-colors hover:text-stone-700"
        >
          가입 없이 공고 정리 체험해 보기 🦉
        </Link>

        <p className="absolute bottom-8 animate-float text-sm text-stone-400" aria-hidden>
          아래로 스크롤해서 같이 가보자 ⬇️
        </p>
      </section>

      {/* ── 장면 2 · 구름길 — 스크롤하면 토끼가 걸어간다 (sticky 스테이지) ── */}
      <section ref={walkSceneRef} className="relative h-[300vh] bg-[#fef6e4]" aria-hidden>
        <div className="sticky top-0 flex h-screen flex-col items-center justify-center overflow-hidden">
          <p className="reveal px-4 text-center text-2xl leading-relaxed text-stone-600 sm:text-3xl">
            공고 하나하나가 <span className="text-sky-500">긴 여행</span>처럼 느껴질 때,
          </p>

          {/* 걷는 토끼 — 바깥 div: 스크롤 이동(translateX), 안쪽 span: 걸음 흔들림(bob) */}
          <div className="mt-10 w-full">
            <div className="sky-walker inline-block pl-[4vw]">
              <span className="inline-block animate-bob text-6xl">🐰</span>
            </div>
            {/* 구름 발판 길 */}
            <div className="mt-2 flex justify-between px-[2vw] text-5xl text-white">
              {Array.from({ length: 8 }).map((_, i) => (
                <span key={i} className={i % 2 === 0 ? "translate-y-1" : "-translate-y-1"}>
                  ☁️
                </span>
              ))}
            </div>
          </div>

          <p className="reveal mt-10 px-4 text-center text-2xl leading-relaxed text-stone-600 sm:text-3xl">
            우리가 <span className="text-amber-500">같이 걸어줄게.</span>
          </p>
        </div>
      </section>

      {/* ── 장면 3 · 숲 — 친구들의 역할 소개 ────────────────────────────── */}
      <section className="bg-gradient-to-b from-[#fef6e4] via-lime-50 to-emerald-50 px-4 py-24">
        <h2 className="reveal text-center text-3xl text-stone-700">숲속 친구들을 소개할게 🌳</h2>
        <div className="mx-auto mt-12 grid max-w-4xl gap-6 sm:grid-cols-3">
          <FriendCard
            emoji="🐿️"
            name="다람이"
            role="공고 배달"
            description="URL만 주면 공고를 통째로 물어와. 못 가져오는 곳은 네가 붙여넣어 주면 돼!"
          />
          <FriendCard
            emoji="🦉"
            name="부엉 박사"
            role="꼼꼼 정리"
            description="자격요건·우대사항·마감일까지 공고를 착착 정리해서 보여줄게."
          />
          <FriendCard
            emoji="🐰"
            name="토돌이"
            role="나랑 비교"
            description="네 프로필과 공고를 하나하나 비교해서 적합도 점수를 계산해 줘."
          />
        </div>
      </section>

      {/* ── 장면 4 · 섬 도착 — CTA ─────────────────────────────────────── */}
      <section className="bg-gradient-to-b from-emerald-50 to-sky-100 px-4 py-28 text-center">
        <div className="reveal mx-auto max-w-md">
          <div className="animate-float text-7xl" aria-hidden>
            🏝️
          </div>
          <div className="bubble bubble-center mx-auto mt-6 max-w-xs text-sm text-stone-600">
            도착! 이제 네 차례야. 첫 공고를 분석해 볼까? — 🦉 부엉 박사
          </div>
          <Link
            href="/signup"
            className="mt-8 inline-block rounded-full bg-amber-300 px-10 py-4 text-lg text-amber-950 shadow-[0_4px_0_#f59e0b] transition-transform hover:-translate-y-0.5 active:translate-y-0.5 active:shadow-none"
          >
            모험 시작하기 ✨
          </Link>
        </div>
        <p className="mt-16 text-xs text-stone-400">
          잡프렌즈 — AI 분석은 참고용이에요. 최종 판단은 공고 원문을 확인한 뒤 해주세요.
        </p>
      </section>
    </div>
  );
}

/** 하늘을 흐르는 구름 — drift keyframe(transform 전용), 음수 delay로 중간부터 시작 */
function Cloud({
  className,
  duration,
  delay,
}: {
  className: string;
  duration: number;
  delay: number;
}) {
  return (
    <span
      aria-hidden
      className={`pointer-events-none absolute left-0 opacity-70 ${className}`}
      style={{ animation: `drift ${duration}s linear ${delay}s infinite` }}
    >
      ☁️
    </span>
  );
}

function FriendCard({
  emoji,
  name,
  role,
  description,
}: {
  emoji: string;
  name: string;
  role: string;
  description: string;
}) {
  return (
    <div className="reveal rounded-[2rem] border-2 border-amber-100 bg-white p-6 text-center shadow-[0_4px_0_#fde68a] transition-transform hover:-translate-y-1">
      <div className="animate-wiggle inline-block text-6xl" aria-hidden>
        {emoji}
      </div>
      <p className="mt-3 text-lg text-stone-700">{name}</p>
      <p className="text-xs text-amber-500">{role}</p>
      <p className="mt-3 text-sm leading-relaxed text-stone-500">{description}</p>
    </div>
  );
}
