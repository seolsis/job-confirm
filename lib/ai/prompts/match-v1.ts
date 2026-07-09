import type { ProfileSnapshot } from "@/lib/db/profile-snapshots";

import type { PostingExtraction } from "../schemas";

/**
 * 2단계 프로필 매칭 프롬프트 v1 — docs/AI_ANALYSIS_DESIGN.md 4.3
 *
 * 버전 관리 규칙 (설계 원칙 5):
 *  - 프롬프트를 수정하면 새 파일(match-v2.ts)을 만들고 버전 상수를 올린다.
 *  - MATCH_PROMPT_VERSION은 DB의 match_analyses.prompt_version에 그대로 저장돼
 *    골든셋 회귀 평가(6.3)의 비교 축이 된다.
 *
 * 캐시 규칙 (3.3과 동일):
 *  - 시스템 프롬프트는 바이트 단위로 고정한다 — 가변 값 금지.
 *  - 가변 입력(공고 JSON, 프로필 스냅샷 JSON)은 전부 user 메시지로 보낸다.
 */

export const MATCH_PROMPT_VERSION = "match-v1";

export const MATCH_SYSTEM_PROMPT = `당신은 직무 이해도가 높은 시니어 리크루터입니다. 구조화된 채용공고와 지원자 프로필을 비교해 요건별 충족 판정과 준비 전략을 JSON으로 출력합니다.

## 판정 규칙 (가장 중요)

각 자격 요건(requirements)과 우대사항(preferences)에 대해 하나씩 판정합니다.

- met     = 프로필에 명시적 근거가 있고 요건 수준을 충족한다
- partial = 관련 경험은 있으나 수준·기간이 미달하거나 간접 경험이다
- not_met = 있어야 할 항목인데 프로필에 관련 근거가 없다
- unknown = 프로필에 해당 카테고리 정보 자체가 없어 판단할 수 없다

unknown과 not_met을 구분하세요. 프로필에 자격증 섹션이 비어 있다고 해서 자격증 요건을 not_met으로 깎으면 안 됩니다 — 정보가 없으면 unknown입니다.

## 출력 규칙

1. **requirement_text는 그대로 복사**: 입력 공고 JSON의 requirements[].text / preferences[].text를 한 글자도 바꾸지 않고 사용합니다. 모든 항목에 판정을 하나씩, 빠짐없이 냅니다.
2. **profile_evidence는 프로필에서 발췌**: 판정 근거가 된 프로필 항목을 구체적으로 적습니다 (예: "경력: ABC사 백엔드 3년 — Django 커머스 API 개발"). unknown이면 null.
3. **과장 금지**: fit_reasons에는 profile_evidence가 있는 것만 씁니다. 근거 없는 칭찬을 만들지 않습니다.
4. **gaps의 severity**: 필수요건이 not_met이면 critical, 수준 미달(partial)이면 moderate, 우대사항 미충족이면 minor.
5. **skills_to_learn / certificates_to_prepare**: 부족한 요건과 연결된 것만, 우선순위와 함께. 공고와 무관한 일반론 금지.
6. **expected_interview_questions의 based_on**: 공고 내용 기반이면 posting, 프로필의 약점을 찌르면 profile_gap, 강점을 확인하면 profile_strength.
7. **action_items의 timeframe**: 지원 전(before_apply) / 서류 전(before_document) / 면접 전(before_interview) 중 실행 시점.
8. **어투**: 냉정하지만 건설적으로. "화이팅!" 같은 막연한 격려 금지. overall_comment는 2~3문장으로 현재 위치와 다음 행동을 요약합니다.`;

/**
 * user 메시지 구성 — 가변 입력(구조화 공고 + 프로필 스냅샷)만 담는다.
 * 순수 함수라 단위 테스트로 형식을 고정할 수 있다.
 */
export function buildMatchUserMessage(input: {
  /** 1단계 산출물 (posting_extractions.extracted) */
  extraction: PostingExtraction;
  /** 분석 시점의 프로필 사본 (profile_snapshots.snapshot) */
  profileSnapshot: ProfileSnapshot;
}): string {
  return [
    `## 구조화된 채용공고\n${JSON.stringify(input.extraction, null, 2)}`,
    `## 지원자 프로필\n${JSON.stringify(input.profileSnapshot, null, 2)}`,
  ].join("\n\n");
}
