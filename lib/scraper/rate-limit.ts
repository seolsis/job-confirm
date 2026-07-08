/**
 * 호스트별 요청 간격 제한 — ARCHITECTURE.md 3.2 (요청 속도 제한 내장).
 *
 * 같은 호스트로의 연속 요청 사이에 최소 간격을 강제한다.
 * 동시 호출은 호스트별 프로미스 체인으로 직렬화된다.
 * (프로세스 내 메모리 기준 — 서버리스 다중 인스턴스 환경의 전역 제한은
 *  트래픽이 늘어나면 별도 잡 큐 도입 시 함께 해결한다. ARCHITECTURE.md 3.1)
 */

const DEFAULT_MIN_INTERVAL_MS = 1_000;

/** 호스트별 "직전 요청이 끝나는 시각"의 프로미스 체인 */
const hostQueues = new Map<string, Promise<void>>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 해당 호스트의 요청 차례를 기다린다.
 * 반환이 완료되면 바로 요청을 보내도 된다.
 */
export function waitForHostSlot(
  host: string,
  minIntervalMs: number = DEFAULT_MIN_INTERVAL_MS
): Promise<void> {
  const previous = hostQueues.get(host) ?? Promise.resolve();
  // 이전 차례가 끝난 뒤 minIntervalMs만큼 띄운 시점이 내 차례
  const mySlot = previous.then(() => sleep(minIntervalMs));
  hostQueues.set(host, mySlot);
  return previous;
}

/** 테스트용: 대기열 초기화 */
export function clearRateLimitQueues(): void {
  hostQueues.clear();
}
