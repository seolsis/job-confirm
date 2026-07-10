import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import type { AnalysisJobRow } from "@/lib/db/analysis-jobs";

import { subscribeToAnalysisJob } from "./analysis-jobs";

/**
 * analysis_jobs Realtime 구독 단위 테스트 (M1-13) — 실제 Supabase는 호출하지 않는다.
 * 채널 구성(테이블·필터·이벤트)과 이벤트 → onChange 전달, 구독 해제를 fake로 검증한다.
 */

interface Registration {
  event: string;
  schema: string;
  table: string;
  filter: string;
  callback: (payload: { new: Record<string, unknown> }) => void;
}

interface FakeChannel {
  name: string;
  registrations: Registration[];
  subscribed: boolean;
  /** subscribe()에 전달된 상태 콜백 — 조인 완료(SUBSCRIBED) 시뮬레이션용 */
  statusCallback?: (status: string, err?: Error) => void;
}

function makeFakeSupabase(): {
  client: SupabaseClient;
  channels: FakeChannel[];
  removed: string[];
} {
  const channels: FakeChannel[] = [];
  const removed: string[] = [];

  const client = {
    channel(name: string) {
      const entry: FakeChannel = { name, registrations: [], subscribed: false };
      channels.push(entry);
      const channel = {
        on(
          _type: string,
          config: { event: string; schema: string; table: string; filter: string },
          callback: Registration["callback"]
        ) {
          entry.registrations.push({ ...config, callback });
          return channel;
        },
        subscribe(statusCallback?: (status: string, err?: Error) => void) {
          entry.subscribed = true;
          entry.statusCallback = statusCallback;
          return channel;
        },
      };
      return channel;
    },
    removeChannel(channel: unknown) {
      const entry = channels.find((c) => c.subscribed);
      if (entry) removed.push(entry.name);
      return Promise.resolve(channel ? "ok" : "error");
    },
  } as unknown as SupabaseClient;

  return { client, channels, removed };
}

const sampleJob: AnalysisJobRow = {
  id: "job-1",
  user_id: "user-1",
  posting_id: "posting-1",
  step: "extracting",
  error_code: null,
  created_at: "2026-07-09T00:00:00Z",
  updated_at: "2026-07-09T00:01:00Z",
};

describe("subscribeToAnalysisJob", () => {
  it("해당 잡 행만 필터해 INSERT/UPDATE 두 이벤트를 구독한다", () => {
    const { client, channels } = makeFakeSupabase();
    subscribeToAnalysisJob(client, "job-1", () => {});

    expect(channels).toHaveLength(1);
    expect(channels[0].name).toBe("jobConfirm-analysis-job-job-1");
    expect(channels[0].subscribed).toBe(true);

    const events = channels[0].registrations.map((r) => r.event).sort();
    expect(events).toEqual(["INSERT", "UPDATE"]);
    for (const registration of channels[0].registrations) {
      expect(registration.schema).toBe("public");
      expect(registration.table).toBe("jobConfirm_analysis_jobs");
      expect(registration.filter).toBe("id=eq.job-1");
    }
  });

  it("이벤트의 새 행(payload.new)을 그대로 onChange로 전달한다 — 클라이언트 상태에 바로 연결", () => {
    const { client, channels } = makeFakeSupabase();
    const received: AnalysisJobRow[] = [];
    subscribeToAnalysisJob(client, "job-1", (job) => received.push(job));

    const update = channels[0].registrations.find((r) => r.event === "UPDATE");
    update?.callback({ new: sampleJob as unknown as Record<string, unknown> });
    update?.callback({
      new: { ...sampleJob, step: "done" } as unknown as Record<string, unknown>,
    });

    expect(received).toHaveLength(2);
    expect(received[0].step).toBe("extracting");
    expect(received[1].step).toBe("done"); // step 변경이 순서대로 도착한다
  });

  it("INSERT 이벤트도 동일하게 전달한다 (잡 생성 직후 구독 케이스)", () => {
    const { client, channels } = makeFakeSupabase();
    const received: AnalysisJobRow[] = [];
    subscribeToAnalysisJob(client, "job-1", (job) => received.push(job));

    const insert = channels[0].registrations.find((r) => r.event === "INSERT");
    insert?.callback({
      new: { ...sampleJob, step: "queued" } as unknown as Record<string, unknown>,
    });

    expect(received[0].step).toBe("queued");
  });

  it("조인 완료(SUBSCRIBED) 시 onSubscribed를 호출한다 — 호출부 재조회로 조인 전 갭을 메운다", () => {
    const { client, channels } = makeFakeSupabase();
    let subscribedCount = 0;
    subscribeToAnalysisJob(client, "job-1", () => {}, () => (subscribedCount += 1));

    expect(subscribedCount).toBe(0); // 조인 완료 전에는 호출되지 않는다
    channels[0].statusCallback?.("SUBSCRIBED");
    expect(subscribedCount).toBe(1);

    // 실패 상태에서는 호출되지 않는다 (로그만 남긴다)
    channels[0].statusCallback?.("CHANNEL_ERROR", new Error("join failed"));
    expect(subscribedCount).toBe(1);
  });

  it("반환된 함수를 호출하면 채널을 제거한다 (cleanup)", () => {
    const { client, removed } = makeFakeSupabase();
    const unsubscribe = subscribeToAnalysisJob(client, "job-1", () => {});

    unsubscribe();

    expect(removed).toEqual(["jobConfirm-analysis-job-job-1"]);
  });
});
