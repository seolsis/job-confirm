# AI 공고 분석 — 분석 방식 & 데이터 설계

> 이 문서는 [PRD](./PRD.md)의 핵심 기능인 "AI 공고 분석"을 실제로 어떻게 구현할지 정의한다.
> 대상 독자: 개발자. 코드 작성 전 설계 문서.

- 문서 버전: v1.0 (2026-07-08)
- 전제: LLM은 Anthropic Claude API 사용 (기본 모델: `claude-opus-4-8`)

---

## 목차

1. [설계 원칙](#1-설계-원칙)
2. [분석 파이프라인 전체 구조](#2-분석-파이프라인-전체-구조)
3. [1단계 — 공고 구조화 분석](#3-1단계--공고-구조화-분석)
4. [2단계 — 프로필 매칭 분석](#4-2단계--프로필-매칭-분석)
5. [적합도 점수 산출 방식](#5-적합도-점수-산출-방식)
6. [API 호출 설계 (비용·성능·품질)](#6-api-호출-설계-비용성능품질)
7. [데이터 저장 설계](#7-데이터-저장-설계)
8. [실패·엣지 케이스 처리](#8-실패엣지-케이스-처리)

---

## 1. 설계 원칙

1. **분석을 2단계로 분리한다** — "공고 구조화"와 "프로필 매칭"은 별도의 LLM 호출로 나눈다.
   - **재사용**: 같은 공고를 여러 사용자가 분석해도 구조화는 1회만 수행하고 결과를 캐시한다. 매칭만 사용자별로 실행한다.
   - **재분석 비용 절감**: 프로필이 바뀌면 매칭 단계만 다시 돌리면 된다.
   - **디버깅 용이**: 결과가 이상할 때 "추출이 틀렸는지, 매칭 판단이 틀렸는지"를 분리해서 볼 수 있다.
   - **진행 상태 UX**: 단계별 완료 시점이 명확해서 "공고 정리 중 → 프로필 비교 중" 표시가 자연스럽다.

2. **점수는 규칙으로, 설명은 LLM으로** — 종합 적합도(0~100)는 LLM이 직접 숫자를 뱉게 하지 않는다. LLM은 요건별 충족 판정(범주형)만 하고, 점수는 서버에서 가중 합산한다. LLM이 직접 매긴 점수는 실행마다 흔들리고 산식을 설명할 수 없다.

3. **모든 판정에 근거를 남긴다** — 추출·판정 결과마다 원문/프로필의 근거 문장(evidence)을 함께 출력시킨다. 환각 억제 + 사용자 신뢰 장치("근거 보기") + 오답 검수 재료.

4. **없는 정보는 없다고 한다** — 공고에 연봉이 없으면 `null`, 프로필에 정보가 없어 판단 불가면 `unknown`. 추측으로 채우지 않는다.

5. **모든 결과에 버전을 남긴다** — 모델 ID, 프롬프트 버전, 스키마 버전을 결과와 함께 저장한다. 프롬프트를 고쳤을 때 품질이 좋아졌는지 회귀 비교가 가능해야 한다.

---

## 2. 분석 파이프라인 전체 구조

```
사용자: URL 입력
   │
   ▼
[0] 전처리 (LLM 아님)
   ├─ URL 정규화 (트래킹 파라미터 제거) → url_hash 생성
   ├─ 캐시 조회: 같은 url_hash의 유효한 구조화 결과가 있으면 [1] 건너뜀
   ├─ 수집: 사이트별 어댑터 / 범용 추출기 / 실패 시 본문 붙여넣기 폴백
   └─ 정제: 본문 텍스트 추출, 원문 스냅샷 저장
   │
   ▼
[1] 공고 구조화 (LLM 호출 #1)  ──→ posting_extractions 저장 (사용자 무관, 공유 캐시)
   │   원문 텍스트 → 14개 필드 JSON (structured outputs)
   ▼
[2] 프로필 매칭 (LLM 호출 #2)  ──→ match_analyses 저장 (사용자별)
   │   구조화 JSON + 프로필 스냅샷 → 요건별 판정 + 8종 분석 JSON
   ▼
[3] 점수 산출 (LLM 아님, 서버 규칙)
   │   요건별 판정 → 가중 합산 → 0~100 + 등급
   ▼
결과 화면 렌더링 / 취준탭 저장
```

- [1], [2]는 비동기 잡으로 실행하고, 진행 상태를 클라이언트에 푸시한다(WebSocket/SSE).
- 총 소요 목표: 캐시 미스 기준 30초 이내, 캐시 히트(구조화 재사용) 시 15초 이내.

---

## 3. 1단계 — 공고 구조화 분석

### 3.1 입력

- 정제된 공고 본문 텍스트 (전처리 단계 산출물)
- 보조 메타데이터: 페이지 `<title>`, OG 태그, 수집 사이트명 (추출 힌트로 프롬프트에 포함)

### 3.2 출력 스키마 (structured outputs — `output_config.format`)

LLM이 자유 텍스트가 아니라 **스키마가 강제된 JSON**을 반환하도록 Claude API의 structured outputs를 사용한다. 파싱 실패가 원천적으로 없어진다.

```jsonc
{
  "company_name":      "string | null",   // 회사명
  "job_title":         "string | null",   // 직무 (예: 백엔드 개발자)
  "job_category":      "string | null",   // 모집 분야 (예: 서버 개발, 데이터 엔지니어링)
  "responsibilities":  ["string"],        // 주요 업무 (항목별 분리)
  "requirements": [                       // 자격 요건 — 매칭의 핵심 입력
    {
      "text": "string",                   // 요건 원문 (예: "Python 3년 이상 경험")
      "category": "skill | experience | education | certificate | language | soft_skill | other",
      "evidence": "string"                // 원문에서 발췌한 근거 문장
    }
  ],
  "preferences": [                        // 우대 사항 — requirements와 동일 구조
    { "text": "string", "category": "...", "evidence": "string" }
  ],
  "required_skills":   ["string"],        // 필요 기술 (요건에서 뽑은 기술 명사, 정규화: "리액트"→"React")
  "tech_stack":        ["string"],        // 사용 기술 스택 (회사가 쓰는 기술)
  "experience_level": {                   // 경력 요구사항
    "type": "entry | junior | mid | senior | any | null",
    "min_years": "number | null",
    "max_years": "number | null",
    "raw_text": "string | null"
  },
  "education": {                          // 학력
    "level": "none | high_school | associate | bachelor | master | phd | null",
    "raw_text": "string | null"
  },
  "location":          "string | null",   // 근무 지역
  "salary": {                             // 연봉
    "min": "number | null",              // 만원 단위
    "max": "number | null",
    "is_negotiable": "boolean | null",
    "raw_text": "string | null"          // "회사 내규에 따름" 등 원문 보존
  },
  "deadline": {                           // 모집 마감일
    "date": "YYYY-MM-DD | null",
    "is_rolling": "boolean",             // 상시 채용 여부
    "raw_text": "string | null"
  },
  "keywords":          ["string"],        // 핵심 키워드 (검색·추천·중복감지용, 5~10개)
  "extraction_notes":  "string | null"    // 추출 중 애매했던 점 (검수용)
}
```

**설계 포인트**

- `requirements`/`preferences`는 문자열 배열이 아니라 **항목 객체 배열**이다. 2단계 매칭이 요건 단위로 판정하므로, 여기서 항목을 잘 쪼개는 것이 전체 품질을 좌우한다.
- `raw_text` 필드를 곳곳에 두는 이유: 정규화 값(`min_years: 3`)이 틀렸을 때 원문("3년 이상 또는 그에 준하는 실력")으로 검증할 수 있어야 한다.
- 날짜·연봉은 LLM이 정규화하되, 서버에서 형식 검증을 한 번 더 한다(예: 마감일이 과거면 `closed` 처리 후보로 플래그).

### 3.3 프롬프트 구성

```
[system]  (고정 — 프롬프트 캐시 대상)
  - 역할: 채용공고 정보 추출 전문가
  - 규칙: 원문에 없는 정보는 null, 추측 금지, 요건은 의미 단위로 분리,
          기술명 정규화 규칙 (한/영 표기 통일), evidence는 원문 그대로 발췌
  - 좋은 추출 예시 1~2건 (few-shot)

[user]    (가변)
  - 수집 메타데이터 (사이트명, 페이지 제목)
  - 공고 본문 텍스트
```

- 시스템 프롬프트는 바이트 단위로 고정하고 `cache_control`을 걸어 프롬프트 캐시를 활용한다 (분석량이 늘수록 입력 비용 ~90% 절감).
- 타임스탬프·사용자 ID 등 가변 값은 절대 시스템 프롬프트에 넣지 않는다 (캐시 무효화 방지).

---

## 4. 2단계 — 프로필 매칭 분석

### 4.1 입력

- 1단계 산출물(구조화 JSON)
- **프로필 스냅샷**: 분석 시점의 프로필 전체를 JSON으로 직렬화한 것. (프로필 원본을 참조하면 나중에 프로필이 수정됐을 때 "이 점수가 어떤 프로필 기준이었는지" 알 수 없게 된다 — 7.3 참고)

### 4.2 출력 스키마

```jsonc
{
  "requirement_judgments": [              // 요건별 판정 — 점수 산출의 원천
    {
      "requirement_text": "string",       // 1단계의 requirements[].text 그대로
      "verdict": "met | partial | not_met | unknown",
      "profile_evidence": "string | null",// 판정 근거가 된 프로필 항목
      "reason": "string"                  // 한 문장 판정 이유
    }
  ],
  "preference_judgments": [               // 우대사항별 판정 — 동일 구조
    { "requirement_text": "...", "verdict": "...", "profile_evidence": "...", "reason": "..." }
  ],
  "fit_reasons": ["string"],              // 적합한 이유 (3~5개, 구체적 근거 포함)
  "gaps": [                               // 부족한 역량
    {
      "gap": "string",                    // 무엇이 부족한가
      "severity": "critical | moderate | minor",  // 필수요건 미충족=critical
      "related_requirement": "string | null"
    }
  ],
  "strengths": [                          // 강점 (자소서·면접 어필 포인트)
    { "strength": "string", "how_to_appeal": "string" }
  ],
  "skills_to_learn": [                    // 공부해야 할 기술
    {
      "skill": "string",
      "priority": "high | medium | low",
      "reason": "string",                 // 왜 필요한가 (어느 요건과 연결되는가)
      "suggestion": "string"              // 학습 방향 한 줄 제안
    }
  ],
  "certificates_to_prepare": [            // 준비해야 할 자격증
    { "certificate": "string", "reason": "string", "priority": "high | medium | low" }
  ],
  "expected_interview_questions": [       // 예상 면접 질문
    {
      "question": "string",
      "intent": "string",                 // 면접관의 의도
      "based_on": "posting | profile_gap | profile_strength"  // 질문의 출처
    }
  ],
  "action_items": [                       // 합격 가능성을 높이기 위한 행동
    {
      "action": "string",
      "timeframe": "before_apply | before_document | before_interview",
      "expected_impact": "string"
    }
  ],
  "overall_comment": "string"             // 종합 코멘트 2~3문장 (점수와 함께 상단 노출)
}
```

**설계 포인트**

- `verdict`에 `unknown`(판단 불가)을 반드시 둔다. 프로필에 정보가 없는 요건을 `not_met`으로 처리하면 점수가 부당하게 깎인다. `unknown`은 점수에서 별도 취급(5.2)하고, UI에서 "프로필에 이 정보를 추가하면 분석이 정확해져요"로 연결한다.
- 예상 면접 질문에 `based_on`을 두는 이유: "부족한 부분을 찌르는 질문"과 "강점을 확인하는 질문"을 UI에서 구분해 보여주면 준비 우선순위가 명확해진다.
- `action_items`의 `timeframe`은 취준탭의 상태(지원 예정 → 서류 → 면접)와 자연스럽게 연결된다 — 예: 카드가 "면접 예정"으로 이동하면 `before_interview` 항목을 다시 노출.

### 4.3 프롬프트 구성

```
[system]  (고정 — 프롬프트 캐시 대상)
  - 역할: 채용 매칭 분석가 (직무 이해도 높은 시니어 리크루터 페르소나)
  - 판정 규칙:
      met     = 프로필에 명시적 근거가 있고 요건 수준을 충족
      partial = 관련 경험은 있으나 수준·기간이 미달하거나 간접 경험
      not_met = 프로필에 관련 근거가 없고, 있어야 할 항목인데 없음
      unknown = 프로필에 해당 카테고리 정보 자체가 없어 판단 불가
  - 과장 금지: fit_reasons는 profile_evidence가 있는 것만
  - 어투: 냉정하지만 건설적으로. 막연한 격려 금지.

[user]    (가변)
  - 구조화된 공고 JSON (1단계 산출물)
  - 프로필 스냅샷 JSON
```

---

## 5. 적합도 점수 산출 방식

### 5.1 왜 LLM에게 점수를 직접 안 시키나

- 같은 입력에도 실행마다 ±10점씩 흔들린다 → 재분석 시 "점수가 왜 바뀌었죠?" 문의 폭탄.
- 산식을 설명할 수 없다 → "왜 72점이에요?"에 답을 못 한다.
- 규칙 기반이면 요건 판정만 같으면 점수가 항상 같고, 산식 공개("필수요건 5개 중 4개 충족")가 가능하다.

### 5.2 산식 (v1 — 운영하며 가중치 튜닝)

```
기본 배점: 필수요건 70점 + 우대사항 20점 + 경력/학력 정합 10점

① 필수요건 점수 = 70 × Σ(판정 가중치) / 판정 대상 요건 수
     met     = 1.0
     partial = 0.5
     not_met = 0.0
     unknown = 점수 분모에서 제외 (모수에서 뺌)
   단, unknown이 전체 요건의 50% 초과 시 → 점수 대신 "프로필 부족" 상태 반환
                                            (엉터리 점수를 주느니 점수를 안 준다)

② 우대사항 점수 = 20 × Σ(동일 가중치) / 우대 항목 수   (unknown 동일 취급)

③ 경력/학력 정합 = 10점 만점
     경력 범위 내 6점 / 학력 충족 4점, 각각 미충족 시 0, unknown 시 절반

종합 = ① + ② + ③  (0~100, 반올림)

등급:  80~100 적극 추천 │ 60~79 도전 가능 │ 40~59 준비 필요 │ 0~39 갭이 큼
```

- `severity: critical`인 gap(= 필수요건 `not_met`)이 하나라도 있으면 등급 옆에 경고 뱃지("필수요건 미충족 1건")를 병기한다. 점수가 높아도 필수요건 하나가 발목 잡는 경우를 숨기지 않는다.
- 산식 자체를 결과 화면에서 펼쳐볼 수 있게 한다 — 점수의 신뢰는 투명성에서 나온다.

---

## 6. API 호출 설계 (비용·성능·품질)

### 6.1 호출 파라미터

| 항목 | 1단계 (구조화) | 2단계 (매칭) |
|---|---|---|
| 모델 | `claude-opus-4-8` | `claude-opus-4-8` |
| thinking | `{"type": "adaptive"}` | `{"type": "adaptive"}` |
| effort | `medium` (추출은 정형 작업) | `high` (판단 품질이 제품 핵심) |
| 출력 | structured outputs (`output_config.format`, json_schema) | 동일 |
| max_tokens | 8,000 | 16,000 |
| 스트리밍 | 사용 (타임아웃 방지, 진행 표시) | 사용 |

- 점수 산식은 서버 코드이므로 LLM 호출이 아니다 (3번째 호출 없음).
- structured outputs는 스키마 강제이므로 "JSON 파싱 실패 → 재시도" 로직이 필요 없다.
- 모델 경량화(1단계를 하위 모델로)는 **품질 평가 데이터가 쌓인 뒤** A/B로 검토한다. 초기에는 품질이 곧 리텐션이므로 두 단계 모두 상위 모델로 시작한다.

### 6.2 비용 통제 장치

| 장치 | 내용 |
|---|---|
| 구조화 캐시 | `url_hash` 기준. 같은 공고는 [1]을 건너뜀 — 유효기간 7일 (공고 수정 대비), 스냅샷 해시 변경 시 무효화 |
| 프롬프트 캐시 | 고정 시스템 프롬프트에 `cache_control` — 입력 토큰 ~90% 절감 |
| 사용자 쿼터 | 무료 월 N회. 캐시 히트 재조회는 미차감 |
| 사용량 기록 | 호출마다 `usage`(input/output/cache_read 토큰)를 저장 — 사용자·기능별 비용 대시보드의 원천 |
| 재분석 일괄 처리 | 프로필 변경 후 "저장 공고 N건 재분석"은 급하지 않으므로 Message Batches API(50% 할인) 사용 검토 |

### 6.3 품질 관리 루프

1. 모든 분석 결과에 `model_id`, `prompt_version`, `schema_version` 저장.
2. 결과 화면의 👍/👎 피드백을 `match_analyses`에 연결 저장.
3. 어드민에서 👎 사례 조회 → 근거(evidence) 대조로 오류 유형 분류 (추출 오류 vs 판정 오류 vs 산식 문제).
4. 프롬프트 수정 시 버전 증가 → 골든셋(수동 검증한 공고 30~50건)으로 회귀 평가 후 배포.

---

## 7. 데이터 저장 설계

### 7.1 ERD 개요

```
users 1──1 profiles 1──* profile_snapshots
                              │
job_postings 1──1 posting_extractions
     │                        │
     │        match_analyses *┴─ (posting_extraction × profile_snapshot)
     │              │
     └──* applications ──* application_status_history
                │
users 1─────────┘         usage_logs (LLM 호출 기록)
```

### 7.2 테이블 정의

#### `users`
| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | uuid PK | |
| email | text unique | |
| auth_provider | text | email / google / kakao |
| created_at, deleted_at | timestamptz | 탈퇴 시 soft delete 후 배치 완전 삭제 (개인정보) |

#### `profiles` — 현재 프로필 (사용자당 1개, 수정 가능)
| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | uuid PK | |
| user_id | uuid FK unique | |
| desired_job | text | 희망 직무 |
| desired_conditions | jsonb | 희망 연봉/지역/고용형태 |
| educations | jsonb | `[{school, major, degree, status, period}]` |
| experiences | jsonb | `[{company, role, period_months, description}]` |
| skills | jsonb | `[{name, level, years}]` — name은 정규화된 기술명 |
| certificates | jsonb | `[{name, issuer, acquired_at}]` |
| languages | jsonb | `[{test, score, acquired_at}]` |
| projects | jsonb | `[{name, role, description, tech}]` |
| completeness | int | 프로필 완성도 % (서버 계산, UI 게이지용) |
| updated_at | timestamptz | |

> 섹션들을 jsonb로 두는 이유: 프로필 구조는 초기에 자주 바뀌고, 섹션 내부를 조인·검색할 일이 거의 없다(분석 시 통째로 직렬화). 정규화 테이블 분리는 검색·통계 요구가 생기면 그때 한다.

#### `profile_snapshots` — 분석 시점의 프로필 사본 (불변)
| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | uuid PK | |
| user_id | uuid FK | |
| snapshot | jsonb | 프로필 전체 직렬화 |
| content_hash | text | 스냅샷 해시 — 프로필이 안 바뀌었으면 기존 스냅샷 재사용 (행 폭증 방지) |
| created_at | timestamptz | |

**왜 필요한가**: 매칭 결과는 "그때의 프로필" 기준이다. 스냅샷이 없으면 프로필 수정 후 과거 분석의 근거가 사라지고, "점수 변화 추적(72→81)" 기능도 만들 수 없다.

#### `job_postings` — 공고 원본 (사용자 무관, 공유)
| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | uuid PK | |
| url | text | 원본 URL |
| normalized_url | text | 트래킹 파라미터 제거 후 |
| url_hash | text unique index | 캐시·중복감지 키 |
| source_site | text | wanted / saramin / generic / manual_paste |
| raw_snapshot | text | 정제된 본문 텍스트 (공고 삭제 대비 열람용) |
| snapshot_hash | text | 본문 해시 — 재수집 시 변경 감지 → 구조화 캐시 무효화 |
| status | text | active / closed / fetch_failed |
| fetched_at, created_at | timestamptz | |

#### `posting_extractions` — 1단계 구조화 결과 (공고당 버전별)
| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | uuid PK | |
| posting_id | uuid FK | |
| extracted | jsonb | 3.2 스키마 전체 (14개 필드 + evidence) |
| company_name, job_title, deadline_date | (생성 컬럼/복제) | 목록·정렬·D-day 쿼리용 발췌 컬럼 |
| model_id, prompt_version, schema_version | text | 회귀 비교용 |
| token_usage | jsonb | input/output/cache_read |
| created_at | timestamptz | |

> 공고 1건에 구조화 결과가 여러 버전 있을 수 있다(재수집·프롬프트 개선). 최신 유효 버전을 가리키는 `job_postings.latest_extraction_id`를 둔다.

#### `match_analyses` — 2단계 매칭 결과 (사용자별, 불변)
| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | uuid PK | |
| user_id | uuid FK | |
| extraction_id | uuid FK | 어떤 구조화 버전 기준인지 |
| profile_snapshot_id | uuid FK | 어떤 프로필 기준인지 |
| result | jsonb | 4.2 스키마 전체 |
| score | int | 서버 산출 종합 점수 (0~100), "프로필 부족" 시 null |
| grade | text | recommend / challenge / prepare / large_gap / insufficient_profile |
| score_breakdown | jsonb | 산식 항목별 점수 (①②③) — "왜 72점" 펼쳐보기용 |
| critical_gap_count | int | 필수요건 not_met 수 (경고 뱃지) |
| model_id, prompt_version, schema_version | text | |
| token_usage | jsonb | |
| feedback | text | up / down / null |
| feedback_reason | text | 👎 사유 (선택 입력) |
| created_at | timestamptz | |

> 불변으로 두고 재분석 시 새 행을 만든다. `(user_id, posting_id)` 기준 시계열이 곧 "점수 변화 추적" 데이터다.

#### `applications` — 취준탭 카드
| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | uuid PK | |
| user_id, posting_id | uuid FK, unique 조합 | 같은 공고 중복 카드 방지 |
| latest_analysis_id | uuid FK | 카드에 표시할 최신 매칭 결과 |
| status | text | interested / planned / applied / doc_passed / test_passed / interview / accepted / rejected |
| rejected_at_stage | text | 불합격 시 탈락 단계 (통계용) |
| memo | text | |
| schedule | jsonb | `[{type: interview/test/deadline, at, note}]` |
| created_at, updated_at | timestamptz | |

#### `application_status_history` — 상태 변경 이력
| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | uuid PK | |
| application_id | uuid FK | |
| from_status, to_status | text | |
| changed_at | timestamptz | 전환율 통계·회고 리포트의 원천 |

#### `usage_logs` — LLM 호출·쿼터 기록
| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | uuid PK | |
| user_id | uuid FK | |
| kind | text | extraction / match / batch_rematch |
| was_cache_hit | boolean | 쿼터 미차감 여부 |
| token_usage | jsonb | |
| created_at | timestamptz | 월별 집계로 쿼터 판정 |

### 7.3 저장 설계의 핵심 결정 요약

| 결정 | 이유 |
|---|---|
| 공고(postings)와 카드(applications) 분리 | 구조화 결과를 사용자 간 공유 → LLM 비용 절감, 중복 감지 |
| 구조화(extractions)와 매칭(match_analyses) 분리 | 프로필 변경 시 매칭만 재실행, 오류 원인 분리 |
| 프로필 스냅샷 불변 저장 | 과거 분석의 근거 보존, 점수 변화 추적 |
| 매칭 결과 불변(append-only) | 재분석 히스토리 = 성장 가시화 기능의 데이터 |
| jsonb 중심 + 발췌 컬럼 | 스키마 진화가 잦은 초기에 유연성, 쿼리 필요한 필드만 컬럼 승격 |
| 모델·프롬프트 버전 전 결과에 기록 | 품질 회귀 비교, 오답 원인 추적 |
| 원문 스냅샷 보관 | 공고 삭제·마감 후에도 본인 열람 (외부 공유는 원문 링크만 — 저작권) |

---

## 8. 실패·엣지 케이스 처리

| 케이스 | 처리 |
|---|---|
| 수집 실패 (봇 차단, 로그인 벽) | `fetch_failed` 저장 → "본문을 붙여넣어 주세요" 폴백 UI. 붙여넣기 입력은 `source_site: manual_paste`로 동일 파이프라인 진입 |
| 본문이 공고가 아님 (404, 목록 페이지) | 1단계 프롬프트에 "채용공고가 아니면 `company_name: null` + `extraction_notes`에 사유" 규칙 → 필수 필드 다수 null이면 사용자에게 확인 요청, 쿼터 미차감 |
| 이미지로만 된 공고 | MVP: "텍스트를 복사해 주세요" 안내. 확장: 이미지 입력(비전) 분석 |
| 마감일이 이미 지난 공고 | 분석은 수행하되 결과 상단에 "마감된 공고" 경고 |
| 프로필이 거의 빈 상태 | unknown 비율 50% 초과 → 점수 대신 `insufficient_profile` 등급 + 프로필 보완 유도 |
| LLM 응답이 refusal/max_tokens로 종료 | `stop_reason` 확인 후 1회 재시도, 실패 시 쿼터 미차감 + 오류 안내 + 어드민 로그 |
| API 429/5xx | SDK 자동 재시도(지수 백오프) + 잡 큐 재시도, 사용자에게는 "분석 대기 중" 표시 유지 |
| 같은 공고 다른 URL (중복) | `keywords` + 회사명/직무명 유사도로 중복 후보 감지 → "이미 분석한 공고 같아요" 병합 제안 |

---

*구현 착수 시 이 문서의 스키마를 기준으로 마이그레이션과 API 명세를 작성한다. 산식 가중치(5.2)와 캐시 유효기간(6.2)은 운영 데이터로 튜닝하는 값이며 상수로 하드코딩하지 않는다.*
