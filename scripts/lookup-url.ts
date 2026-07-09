/**
 * 개발용 실행 진입점 (M1-9) — URL 하나로 구조화 캐시를 조회한다 (읽기 전용).
 *
 * 실행:
 *   npm run lookup:url -- --url "https://..."
 *
 * miss여도 수집·구조화를 실행하지 않는다 — LLM 호출 없음.
 * (miss 시 재분석 오케스트레이션은 M1-10 파이프라인에서 연결한다)
 */
import { parseArgs } from "node:util";

import { lookupExtractionByUrl } from "@/lib/ai/url-entry-service";
import { createServiceRoleSupabaseClient } from "@/lib/supabase/service-role";

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { url: { type: "string" } } });

  if (!values.url) {
    console.error('사용법: npm run lookup:url -- --url "https://..."');
    process.exitCode = 1;
    return;
  }

  const supabase = createServiceRoleSupabaseClient();
  const result = await lookupExtractionByUrl(supabase, values.url);

  console.log(`\nnormalized_url : ${result.normalizedUrl}`);
  console.log(`url_hash       : ${result.urlHash}`);

  if (result.cacheHit) {
    console.log(`cache          : hit — 기존 구조화 결과 반환 (LLM 호출 없음)`);
    console.log(`  posting_id    : ${result.posting.id}`);
    console.log(`  extraction_id : ${result.extraction.id}`);
    console.log(
      `  company/title : ${result.extraction.company_name} / ${result.extraction.job_title}`
    );
    console.log(
      `  prompt/schema : ${result.extraction.prompt_version} / ${result.extraction.schema_version}`
    );
    console.log(`\nextracted JSON:\n${JSON.stringify(result.extraction.extracted, null, 2)}`);
  } else {
    console.log(`cache          : miss (${result.cacheMissReason})`);
    console.log(
      `  posting       : ${result.posting ? result.posting.id : "없음 (최초 분석 대상)"}`
    );
    console.log(
      `  다음 단계     : M1-10 파이프라인이 수집→구조화를 실행할 지점 (자동 실행 금지 상태)`
    );
  }
}

main().catch((error: unknown) => {
  console.error("\n실패 —", error);
  process.exitCode = 1;
});
