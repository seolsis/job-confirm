import type { Metadata } from "next";
import Link from "next/link";

/**
 * 개인정보처리방침 (M4-5, PRD 7.2 #10) — 정적 페이지.
 * ⚠️ 초안 — 런칭 전 법무 검토 필수 (LLM 외부 전송 고지·보관 기간 확정).
 */

export const metadata: Metadata = { title: "개인정보처리방침 — 잡프렌즈" };

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-[#fef6e4] px-4 py-16">
      <div className="mx-auto max-w-2xl rounded-[2rem] border-2 border-amber-100 bg-white p-8 shadow-[0_4px_0_#fde68a]">
        <h1 className="text-2xl text-stone-700">개인정보처리방침</h1>
        <p className="mt-1 text-xs text-stone-400">시행일: 2026년 7월 11일</p>

        <div className="mt-6 space-y-5 text-sm leading-relaxed text-stone-600">
          <section>
            <h2 className="text-base text-stone-700">1. 수집하는 개인정보</h2>
            <ul className="mt-1 list-inside list-disc space-y-1">
              <li>계정: 이메일 주소 (이메일 가입 또는 Google 로그인)</li>
              <li>
                프로필(이용자 직접 입력): 희망 직무·조건, 학력, 경력, 스킬, 자격증, 어학, 프로젝트
              </li>
              <li>서비스 이용 기록: 분석 요청·결과, 보드 카드, 피드백, 사용량</li>
            </ul>
          </section>

          <section>
            <h2 className="text-base text-stone-700">2. 이용 목적</h2>
            <p>
              공고-프로필 적합도 분석 제공, 지원 현황 관리, 무료 이용 한도 산정, 분석 품질
              개선(피드백 검토)에만 이용합니다.
            </p>
          </section>

          <section>
            <h2 className="text-base text-stone-700">3. AI 처리 위탁 (외부 전송 고지)</h2>
            <p>
              분석 시 공고 본문과 이용자의 프로필이 AI 모델 제공사(Google 또는 Anthropic)의 API로
              전송되어 처리됩니다. 전송된 데이터는 분석 응답 생성에만 사용되며, 각 제공사의 API
              데이터 정책이 적용됩니다.
            </p>
          </section>

          <section>
            <h2 className="text-base text-stone-700">4. 보관과 파기</h2>
            <p>
              개인정보는 회원 탈퇴 시 <strong>즉시 삭제</strong>됩니다 (프로필, 분석 결과, 보드,
              사용 기록 포함). 이용자와 무관한 공고 원문 캐시는 서비스 품질을 위해 별도 보관될 수
              있습니다.
            </p>
          </section>

          <section>
            <h2 className="text-base text-stone-700">5. 처리 위탁·보관 위치</h2>
            <p>데이터는 Supabase(데이터베이스·인증) 인프라에 암호화 연결로 저장됩니다.</p>
          </section>

          <section>
            <h2 className="text-base text-stone-700">6. 이용자의 권리</h2>
            <p>
              이용자는 프로필 화면에서 언제든 자신의 정보를 조회·수정할 수 있고, 설정 화면에서
              계정과 모든 데이터를 삭제(탈퇴)할 수 있습니다.
            </p>
          </section>

          <section>
            <h2 className="text-base text-stone-700">7. 문의</h2>
            <p>개인정보 관련 문의는 운영자 이메일로 접수합니다.</p>
          </section>
        </div>

        <div className="mt-8 flex gap-4 text-sm">
          <Link href="/terms" className="text-amber-600 underline">
            이용약관
          </Link>
          <Link href="/" className="text-stone-400 underline">
            홈으로
          </Link>
        </div>
      </div>
    </main>
  );
}
