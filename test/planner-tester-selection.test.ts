import { expect, test } from "bun:test";

import { rankTesterWorkersForSlice, scoreTesterWorkerForSlice } from "../src/core/planning/planner";
import type { RegisteredWorker } from "../src/core/workers/schema";
import { createSlice, createWorker } from "./helpers";

// Two tester-capable workers, identical testing skill + trust, differing only
// in resource cost. The "balanced" strategy prefers the higher-stat/lower-cost
// combo via `resourcePenalty` alone; the "prefer-cheapest" strategy applies a
// much stronger cheapest bias (cpu*8 + memory*6 + gpu*10) which should flip
// selection decisively toward the cheaper worker even when the pricier one has
// a mild stat edge elsewhere.
function buildTesterWorkers(): {
  cheap: RegisteredWorker;
  expensive: RegisteredWorker;
} {
  const cheap = createWorker({
    class: "tester",
    id: "cheap-tester",
    name: "Cheap Tester",
    resources: { cpuCost: 1, gpuCost: 0, maxParallel: 1, memoryCost: 1 },
    stats: {
      coding: 40,
      contextEndurance: 50,
      docs: 30,
      mergeSafety: 60,
      research: 30,
      speed: 55,
      testing: 70,
    },
    tags: [],
    trust: { calibratedAt: "2026-04-10T00:00:00Z", rating: 0.8 },
  });
  const expensive = createWorker({
    class: "tester",
    id: "expensive-tester",
    name: "Expensive Tester",
    // Small stat edge (+3 testing, +5 mergeSafety, +5 speed) but expensive in
    // every resource dimension. balanced → expensive still wins on raw stats.
    // prefer-cheapest → cheap wins because the bias eats the stat edge.
    resources: { cpuCost: 6, gpuCost: 4, maxParallel: 1, memoryCost: 8 },
    stats: {
      coding: 40,
      contextEndurance: 50,
      docs: 30,
      mergeSafety: 65,
      research: 30,
      speed: 60,
      testing: 73,
    },
    tags: [],
    trust: { calibratedAt: "2026-04-10T00:00:00Z", rating: 0.8 },
  });
  return { cheap, expensive };
}

test("scoreTesterWorkerForSlice: prefer-cheapest penalizes expensive workers more than balanced", () => {
  const { cheap, expensive } = buildTesterWorkers();

  const cheapBalanced = scoreTesterWorkerForSlice(cheap, false, undefined, "balanced");
  const expensiveBalanced = scoreTesterWorkerForSlice(expensive, false, undefined, "balanced");
  const cheapCheapest = scoreTesterWorkerForSlice(cheap, false, undefined, "prefer-cheapest");
  const expensiveCheapest = scoreTesterWorkerForSlice(
    expensive,
    false,
    undefined,
    "prefer-cheapest",
  );

  // Cheap worker's score barely changes: cpu=1, gpu=0, memory=1 → cpu*8 + memory*6 + gpu*10 = 14.
  expect(cheapBalanced - cheapCheapest).toBeCloseTo(14, 5);
  // Expensive worker takes the heavy hit: cpu=6, gpu=4, memory=8 → 48 + 48 + 40 = 136.
  expect(expensiveBalanced - expensiveCheapest).toBeCloseTo(136, 5);
});

test("rankTesterWorkersForSlice: prefer-cheapest widens the cheap-vs-expensive gap compared to balanced", () => {
  // Under both strategies the cheap worker wins here (resource penalties already
  // outweigh the expensive worker's mild stat edge under balanced). The point
  // of prefer-cheapest is to widen the gap enough that operators cannot
  // accidentally bump the expensive worker into first place via minor stat
  // tuning. Locks in that the bias is materially stronger, not just nominally on.
  const { cheap, expensive } = buildTesterWorkers();
  const slice = createSlice();

  const rankedBalanced = rankTesterWorkersForSlice(
    slice,
    [cheap, expensive],
    undefined,
    "balanced",
  );
  const rankedCheapest = rankTesterWorkersForSlice(
    slice,
    [cheap, expensive],
    undefined,
    "prefer-cheapest",
  );

  expect(rankedBalanced[0]?.worker.id).toBe("cheap-tester");
  expect(rankedCheapest[0]?.worker.id).toBe("cheap-tester");

  const balancedGap = (rankedBalanced[0]?.score ?? 0) - (rankedBalanced[1]?.score ?? 0);
  const cheapestGap = (rankedCheapest[0]?.score ?? 0) - (rankedCheapest[1]?.score ?? 0);
  // Balanced gap is modest (~27); prefer-cheapest gap should be at least 4x larger.
  expect(cheapestGap).toBeGreaterThan(balancedGap * 4);
});

test("rankTesterWorkersForSlice: prefer-cheapest strategy promotes the cheaper worker", () => {
  const { cheap, expensive } = buildTesterWorkers();
  const slice = createSlice();

  const ranked = rankTesterWorkersForSlice(slice, [cheap, expensive], undefined, "prefer-cheapest");
  expect(ranked.length).toBe(2);
  const firstWorker = ranked[0]?.worker;
  expect(firstWorker).toBeDefined();
  expect(firstWorker?.id).toBe("cheap-tester");
});

test("rankTesterWorkersForSlice: independence bonus still applies under prefer-cheapest", () => {
  // When a builder is named, testers that are NOT that builder receive +10 via
  // `independenceBonus`. If the builder IS the expensive worker, the cheap
  // worker gains both the independence bonus AND the cheapest bias — ranking
  // should remain cheap-first. Locks in that the two adjustments compose.
  const { cheap, expensive } = buildTesterWorkers();
  const slice = createSlice();

  const ranked = rankTesterWorkersForSlice(
    slice,
    [cheap, expensive],
    "expensive-tester",
    "prefer-cheapest",
  );
  expect(ranked.length).toBe(2);
  const firstWorker = ranked[0]?.worker;
  expect(firstWorker?.id).toBe("cheap-tester");
  const firstScore = ranked[0]?.score ?? 0;
  const secondScore = ranked[1]?.score ?? 0;
  // The gap should be substantial: independence (+10) + cheapest bias flip (~114 points).
  expect(firstScore - secondScore).toBeGreaterThan(100);
});
