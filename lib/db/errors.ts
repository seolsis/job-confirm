/**
 * 저장 계층 공통 오류 — Supabase 쿼리 실패를 감싼다.
 * 상위 파이프라인에서 analysis_jobs.error_code 매핑·로깅의 대상이 된다.
 */
export class StorageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StorageError";
  }
}
