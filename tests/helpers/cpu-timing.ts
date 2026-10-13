/**
 * @fileoverview Thread-CPU timing for the linearity tests over caller- and
 * upstream-sized input.
 * @module tests/helpers/cpu-timing
 */

/**
 * Per-call thread CPU time of `run`, in microseconds: each sample repeats `run`
 * until 20 ms of this thread's CPU accrue and divides by the calls made, and the
 * fastest of five samples is kept, so neither timer resolution nor a busy machine
 * decides the figure.
 */
function cpuMicrosPerCall(run: () => void): number {
  let best = Number.POSITIVE_INFINITY;
  for (let sample = 0; sample < 5; sample++) {
    const start = process.threadCpuUsage();
    let calls = 0;
    let used: NodeJS.CpuUsage;
    do {
      run();
      calls += 1;
      used = process.threadCpuUsage(start);
    } while (used.user + used.system < 20_000);
    best = Math.min(best, (used.user + used.system) / calls);
  }
  return best;
}

/**
 * The per-call times of `run` over a small and a large input, re-sampled once
 * when the first pair breaches either bound the tests assert (a ratio under 256,
 * the large input under 500 ms) so one descheduled sample cannot fail it,
 * keeping the faster figure of each.
 */
export function linearTiming<T>(run: (input: T) => unknown, small: T, large: T) {
  const measure = () => ({
    t5k: cpuMicrosPerCall(() => run(small)),
    t320k: cpuMicrosPerCall(() => run(large)),
  });
  const first = measure();
  if (first.t320k / first.t5k < 256 && first.t320k < 500_000) return first;
  const second = measure();
  return { t5k: Math.min(first.t5k, second.t5k), t320k: Math.min(first.t320k, second.t320k) };
}
