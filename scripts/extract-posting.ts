/**
 * 개발용 실행 진입점 (M1-7) — 공고 1건을 구조화 파이프라인에 수동으로 넣는다.
 *
 * 실행 (npm script가 --conditions=react-server와 .env.local 로드를 처리한다):
 *
 *   # 본문 텍스트 파일로 새 공고를 만들어 구조화 (붙여넣기 폴백과 동일 경로)
 *   npm run extract:posting -- --file path/to/posting.txt [--title "페이지 제목"] [--site "원티드"]
 *
 *   # 이미 저장된 공고를 다시 구조화 (새 extraction 버전이 쌓인다)
 *   npm run extract:posting -- --posting-id <uuid>
 *
 * M1-7 제약: collector(scraper) 자동 연동 없음, 배치 처리 없음 — 1회 1건.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { createAnthropicClient } from "@/lib/ai/client";
import { extractAndStorePosting, ExtractPostingError } from "@/lib/ai/extraction-service";
import { insertJobPosting } from "@/lib/db/postings";
import { manualPastePosting } from "@/lib/scraper";
import { createServiceRoleSupabaseClient } from "@/lib/supabase/service-role";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      file: { type: "string" },
      "posting-id": { type: "string" },
      title: { type: "string" },
      site: { type: "string" },
    },
  });

  if (!values.file === !values["posting-id"]) {
    console.error(
      "사용법: --file <본문 텍스트 파일> 또는 --posting-id <uuid> 중 하나를 지정하세요."
    );
    process.exitCode = 1;
    return;
  }

  const supabase = createServiceRoleSupabaseClient();
  const anthropic = createAnthropicClient();

  // --file: 붙여넣기 폴백과 동일 경로(manual_paste)로 공고 행을 먼저 만든다
  let postingId = values["posting-id"];
  if (values.file) {
    const bodyText = readFileSync(values.file, "utf8");
    const posting = await insertJobPosting(supabase, manualPastePosting(bodyText));
    postingId = posting.id;
    console.log(`공고 저장 완료: posting_id=${postingId} (source: manual_paste)`);
  }

  const started = Date.now();
  const { extraction } = await extractAndStorePosting(
    { anthropic, supabase },
    postingId as string,
    { title: values.title ?? null, siteName: values.site ?? null }
  );
  const elapsedSec = ((Date.now() - started) / 1000).toFixed(1);

  console.log(`\n구조화 완료 (${elapsedSec}s)`);
  console.log(`  extraction_id : ${extraction.id}`);
  console.log(`  posting_id    : ${extraction.posting_id}`);
  console.log(`  company/title : ${extraction.company_name} / ${extraction.job_title}`);
  console.log(`  deadline_date : ${extraction.deadline_date}`);
  console.log(`  model_id      : ${extraction.model_id}`);
  console.log(`  prompt/schema : ${extraction.prompt_version} / ${extraction.schema_version}`);
  console.log(`  token_usage   : ${JSON.stringify(extraction.token_usage)}`);
  console.log(`\nextracted JSON:\n${JSON.stringify(extraction.extracted, null, 2)}`);
}

main().catch((error: unknown) => {
  if (error instanceof ExtractPostingError) {
    console.error(`\n실패 (code: ${error.code}) — ${error.message}`);
  } else {
    console.error("\n실패 —", error);
  }
  process.exitCode = 1;
});
