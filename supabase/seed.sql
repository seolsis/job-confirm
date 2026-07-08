-- ============================================================================
-- job-confirm — 시드 데이터 (필요 최소한)
--
-- 사용자·프로필 데이터는 auth.users 가입을 전제로 하므로 시드하지 않는다
-- (프로필 행은 가입 트리거로 자동 생성 — M2에서 Auth 구현 후 확인).
-- 여기서는 사용자와 무관한 공유 캐시 테이블에만 내부 테스트용 샘플 1건을 넣는다.
-- ============================================================================

-- 샘플 공고 (manual_paste — 수집기 없이도 파이프라인 결과 화면을 테스트할 수 있는 형태)
insert into "jobConfirm_job_postings"
  (id, url, normalized_url, url_hash, source_site, raw_snapshot, snapshot_hash, status, fetched_at)
values
  (
    '00000000-0000-4000-8000-000000000001',
    null,
    null,
    'seed-sample-posting-0001',
    'manual_paste',
    E'[샘플 공고] 백엔드 개발자 (신입)\n\n주요 업무\n- REST API 설계 및 개발\n- 데이터베이스 모델링\n\n자격 요건\n- Python 또는 Node.js 사용 경험\n- RDBMS 기본 지식\n\n우대 사항\n- AWS 등 클라우드 사용 경험\n\n마감일: 상시 채용',
    'seed-sample-snapshot-0001',
    'active',
    now()
  )
on conflict (id) do nothing;

-- 샘플 구조화 결과 (AI_ANALYSIS_DESIGN.md 3.2 스키마 형태의 예시 — LLM 호출 없이 수기 작성)
insert into "jobConfirm_posting_extractions"
  (id, posting_id, extracted, company_name, job_title, deadline_date,
   model_id, prompt_version, schema_version)
values
  (
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000001',
    '{
      "company_name": "샘플컴퍼니",
      "job_title": "백엔드 개발자",
      "job_category": "서버 개발",
      "responsibilities": ["REST API 설계 및 개발", "데이터베이스 모델링"],
      "requirements": [
        {"text": "Python 또는 Node.js 사용 경험", "category": "skill", "evidence": "Python 또는 Node.js 사용 경험"},
        {"text": "RDBMS 기본 지식", "category": "skill", "evidence": "RDBMS 기본 지식"}
      ],
      "preferences": [
        {"text": "AWS 등 클라우드 사용 경험", "category": "skill", "evidence": "AWS 등 클라우드 사용 경험"}
      ],
      "required_skills": ["Python", "Node.js", "RDBMS"],
      "tech_stack": [],
      "experience_level": {"type": "entry", "min_years": null, "max_years": null, "raw_text": "신입"},
      "education": {"level": null, "raw_text": null},
      "location": null,
      "salary": {"min": null, "max": null, "is_negotiable": null, "raw_text": null},
      "deadline": {"date": null, "is_rolling": true, "raw_text": "상시 채용"},
      "keywords": ["백엔드", "REST API", "Python", "Node.js", "신입"],
      "extraction_notes": "시드 데이터 — LLM 산출물이 아님"
    }'::jsonb,
    '샘플컴퍼니',
    '백엔드 개발자',
    null,
    'seed',        -- 시드 데이터임을 버전 필드로 명시 (실제 LLM 결과와 구분)
    'seed',
    'seed'
  )
on conflict (id) do nothing;

-- 샘플 공고의 최신 구조화 버전 연결
update "jobConfirm_job_postings"
set latest_extraction_id = '00000000-0000-4000-8000-000000000002'
where id = '00000000-0000-4000-8000-000000000001'
  and latest_extraction_id is null;
