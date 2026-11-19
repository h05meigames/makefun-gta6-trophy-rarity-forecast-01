// Trophy Rarity Forecaster — entry for make.fun gta6-trophy-rarity-forecast-01.
//
// The task: for every GTA VI trophy, forecast five quantiles (5/25/50/75/95%)
// of its Exophase earn rate at the case's target time, from the history of
// reads before the case's checkpoint. The score is the mean pinball loss on
// the logit scale, so the entry must report the quantiles it really believes:
// a median that tracks where the rate is heading, and a spread honest about
// how far a rate can move over the horizon.
//
// What the practice cases teach (and what the house persistence baseline
// misses):
//   * A trophy's rate is a ratio, earned / tracked. Both counts move: players
//     keep earning trophies while new players keep joining and diluting the
//     rate. A rate that looks flat for hours can jump when the tracker
//     refreshes — the practice histories are perfectly flat for 7-8 reads
//     and the house baseline still loses ~1.51 there, because the answering
//     read sits far outside its narrow 90-minute band.
//   * So the forecast needs three parts: (1) a trend that extrapolates where
//     the rate is heading instead of assuming it stays put, (2) shrinkage,
//     because any single trophy's short history is noisy, and (3) a spread
//     that widens with the horizon and blows up when the history is flat —
//     flat history is evidence that a refresh jump may be coming, not that
//     the rate is nailed down.
//
// The model, per trophy:
//   1. Work in logit space, y = logit(rate), against x = ln(1 + hours since
//      2026-11-19T00:00:00Z). Log-time is the natural clock for launch-week
//      adoption: early progress is fast, then it bends.
//   2. Fit a recency-weighted straight line y ~ a + b*x over the last 48h of
//      reads (all reads when fewer than three fall in the window), weights
//      decaying with a 12-hour half-life. This is the trend.
//   3. Shrink the slope toward the mean slope of the trophy's tier
//      (bronze/silver/gold/platinum share a launch-week rhythm), then blend
//      the trend forecast with persistence, weighted by how strong the
//      trend signal is next to the fit's residual noise. A flat or noisy
//      history therefore falls back to "stays where it is", honestly.
//   4. Spread: a random-walk term (0.5 logit per sqrt-day, the house
//      baseline's own scale) plus the fit's prediction variance at the
//      target, plus 1.25 logits when the history is perfectly flat (the
//      refresh allowance), plus a small-count allowance when fewer than ten
//      tracked players hold the trophy (rates are then coarse steps).
//   5. Story-progression trophies obey dominance: finishing Chapter 2
//      implies Chapter 1, the final mission implies every chapter, 100%
//      implies the final mission, and the platinum implies 100%. The
//      medians along that chain are pooled (isotonic, non-increasing) so
//      the forecast never claims more players finished Chapter 2 than
//      Chapter 1. Quantiles are rebuilt around the pooled medians.
//
// Everything is deterministic: fixed file order, no wall clock, no random
// numbers, no network, no state between cases. Two runs on the same case
// write byte-identical output.
//
// Run locally with:
//   mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** Quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** Standard normal quantiles at those levels. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
/** Launch clock origin: hours are counted from here, so x = ln(1 + hours). */
const EPOCH_MS = Date.parse('2026-11-19T00:00:00Z');
/** Random-walk spread, logit units per square-root day (house scale). */
const WALK_SIGMA = 0.5;
/** Extra spread when the history is perfectly flat: a refresh may be due. */
const FLAT_ALLOWANCE = 1.25;
/** Recency half-life for the trend fit, in hours. */
const HALF_LIFE_H = 12;
/** Trend window: prefer reads from the last this-many hours. */
const WINDOW_H = 48;
/** Slope shrinkage strength, in effective reads, toward the tier mean. */
const SHRINK_READS = 3;

interface Trophy {
  id: number;
  name: string;
  description: string;
  tier: string;
}
interface Read {
  slot: string;
  at: string;
  players_tracked: number;
  rates: Array<number | null>;
}
interface Case {
  id: string;
  at: string;
  target: string;
  horizon_minutes: number;
  levels: number[];
  trophies: Trophy[];
  history: Read[];
}

const clampPct = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logit = (pct: number): number => {
  const p = clampPct(pct);
  return Math.log(p / (100 - p));
};
const logistic = (l: number): number => 100 / (1 + Math.exp(-l));
const round4 = (x: number): number => Math.round(x * 10000) / 10000;
/** Hours from the launch origin to an ISO timestamp. */
const hoursSinceEpoch = (iso: string): number =>
  (Date.parse(iso) - EPOCH_MS) / 3600000;
/** x-coordinate of a read: log-time, so early launch moves fast, later slow. */
const xOf = (iso: string): number => Math.log1p(Math.max(0, hoursSinceEpoch(iso)));

interface Fit {
  a: number;
  b: number;
  resid: number;
  xbar: number;
  sxx: number;
  nEff: number;
}

/** Recency-weighted least squares of y on x. Returns null when unfittable. */
function weightedFit(xs: number[], ys: number[], ws: number[]): Fit | null {
  const n = xs.length;
  if (n < 2) return null;
  let sw = 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sw += ws[i];
    sx += ws[i] * xs[i];
    sy += ws[i] * ys[i];
  }
  if (sw <= 0) return null;
  const xbar = sx / sw;
  const ybar = sy / sw;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - xbar;
    sxx += ws[i] * dx * dx;
    sxy += ws[i] * dx * (ys[i] - ybar);
  }
  if (sxx <= 1e-12) return null;
  const b = sxy / sxx;
  const a = ybar - b * xbar;
  let sse = 0;
  for (let i = 0; i < n; i++) {
    const r = ys[i] - (a + b * xs[i]);
    sse += ws[i] * r * r;
  }
  // Residual scale; with two points the fit is exact, so floor the noise.
  const resid = n > 2 ? Math.sqrt(sse / Math.max(1e-9, sw - 2)) : 0.05;
  return { a, b, resid, xbar, sxx, nEff: sw };
}

/** Pool-adjacent-violators: make values non-increasing, least-squares style. */
function isotonicDecreasing(values: number[]): number[] {
  // Blocks of pooled neighbours; each block stores its sum and size, and a
  // new value is merged leftwards while its block's mean breaks the order.
  const blocks: Array<{ sum: number; count: number }> = [];
  for (const v of values) {
    blocks.push({ sum: v, count: 1 });
    while (blocks.length >= 2) {
      const b = blocks[blocks.length - 1];
      const a = blocks[blocks.length - 2];
      if (a.sum / a.count >= b.sum / b.count) break;
      blocks.splice(blocks.length - 2, 2, {
        sum: a.sum + b.sum,
        count: a.count + b.count,
      });
    }
  }
  const out: number[] = [];
  for (const block of blocks) {
    for (let j = 0; j < block.count; j++) out.push(block.sum / block.count);
  }
  return out;
}

/** Find the dominance chain (chapter 1..4, final, 100%, platinum) by text. */
function chainIndices(trophies: Trophy[]): number[] {
  const find = (re: RegExp): number =>
    trophies.findIndex((t) => re.test(`${t.name} ${t.description}`));
  const order = [
    find(/chapter 1/i),
    find(/chapter 2/i),
    find(/chapter 3/i),
    find(/chapter 4/i),
    find(/final mission/i),
    find(/100%\s*completion/i),
    trophies.findIndex((t) => t.tier === 'platinum'),
  ];
  return order.filter((idx) => idx >= 0);
}

interface Forecast {
  medianLogit: number;
  sigma: number;
}

function forecastCase(c: Case): { trophies: Array<{ id: number; q: number[] }> } {
  // The contest scores exactly these five levels; any other list is ignored
  // and the five quantiles below are still written in this order.
  const horizonMin =
    typeof c.horizon_minutes === 'number' && c.horizon_minutes > 0
      ? c.horizon_minutes
      : Math.max(
          1,
          (Date.parse(c.target) - Date.parse(c.at)) / 60000 || 90,
        );
  const dDays = horizonMin / 1440;
  const xTarget = xOf(
    c.target ??
      new Date(Date.parse(c.at) + horizonMin * 60000).toISOString(),
  );
  const tLast = c.history.length
    ? hoursSinceEpoch(c.history[c.history.length - 1].at)
    : 0;

  // Last rate of every trophy, for fallbacks and the global median.
  const lastRates: Array<number | null> = c.trophies.map((_, i) => {
    for (let k = c.history.length - 1; k >= 0; k--) {
      const r = c.history[k].rates[i];
      if (r !== null && r !== undefined && Number.isFinite(r)) return r;
    }
    return null;
  });
  const knownLast = lastRates.filter(
    (r): r is number => r !== null,
  );
  const globalMedian =
    knownLast.length > 0
      ? knownLast.slice().sort((p, q) => p - q)[
          Math.floor(knownLast.length / 2)
        ]
      : 5;

  // First pass: raw trend fit per trophy, for the tier-mean slopes.
  const rawFits: Array<Fit | null> = [];
  const series: Array<{
    xs: number[];
    ys: number[];
    ws: number[];
    flat: boolean;
  }> = [];
  for (let i = 0; i < c.trophies.length; i++) {
    const pts: Array<{ x: number; y: number; t: number }> = [];
    for (const read of c.history) {
      const r = read.rates[i];
      if (r === null || r === undefined || !Number.isFinite(r)) continue;
      pts.push({ x: xOf(read.at), y: logit(r), t: hoursSinceEpoch(read.at) });
    }
    const recent = pts.filter((p) => tLast - p.t <= WINDOW_H);
    const use = recent.length >= 3 ? recent : pts;
    const xs = use.map((p) => p.x);
    const ys = use.map((p) => p.y);
    const ws = use.map(
      (p) => 0.2 + 0.8 * Math.pow(0.5, Math.max(0, tLast - p.t) / HALF_LIFE_H),
    );
    const flat =
      ys.length > 0 && Math.max(...ys) - Math.min(...ys) < 1e-9;
    series.push({ xs, ys, ws, flat });
    rawFits.push(weightedFit(xs, ys, ws));
  }
  const tierMeanSlope = new Map<string, number>();
  for (const tier of new Set(c.trophies.map((t) => t.tier))) {
    const slopes: number[] = [];
    c.trophies.forEach((t, i) => {
      if (t.tier === tier && rawFits[i] && Number.isFinite(rawFits[i].b)) {
        slopes.push(rawFits[i].b);
      }
    });
    if (slopes.length > 0) {
      slopes.sort((p, q) => p - q);
      tierMeanSlope.set(tier, slopes[Math.floor(slopes.length / 2)]);
    }
  }

  // Second pass: shrunk trend + persistence blend + spread, per trophy.
  // A flat tape is suspicious only in proportion to how many trophies share
  // it: when the whole page is frozen, a refresh is likely; when one trophy
  // alone is flat, it is usually just stable.
  const flatShare =
    series.length > 0
      ? series.filter((s) => s.flat).length / series.length
      : 0;
  const forecasts: Forecast[] = c.trophies.map((trophy, i) => {
    const last = lastRates[i] ?? globalMedian;
    const yLast = logit(last);
    const { xs, ys, ws, flat } = series[i];
    const fit = rawFits[i];
    const lastN =
      c.history.length > 0
        ? c.history[c.history.length - 1].players_tracked
        : 0;
    const earnedLast = (clampPct(last) / 100) * (lastN || 0);
    // A rate pinned to a boundary (0% or 100% of tracked players) has a
    // logit that is really "at least this extreme": widen its band.
    const boundaryVar = last >= 99 || last <= 0.1 ? 0.25 : 0;

    if (!fit || flat || xs.length < 2) {
      // No usable trend: persistence, with a wide band when the history is
      // flat — a flat tape is exactly when a refresh jump is most likely.
      const flatVar = flat
        ? Math.pow(FLAT_ALLOWANCE * (0.5 + 0.5 * flatShare), 2)
        : 0;
      const sigma = Math.min(
        2.5,
        Math.sqrt(
          Math.pow(WALK_SIGMA, 2) * dDays +
            flatVar +
            boundaryVar +
            (earnedLast > 0 && earnedLast < 10 ? 0.09 : 0) +
            0.01,
        ),
      );
      // A boundary rate is censored, not precise: cap its median logit too.
      return { medianLogit: Math.max(-6.9, Math.min(6.9, yLast)), sigma: Math.max(0.15, sigma) };
    }

    // Shrink the slope toward the tier's median slope.
    const tierMean = tierMeanSlope.get(trophy.tier) ?? 0;
    const b =
      (fit.nEff * fit.b + SHRINK_READS * tierMean) /
      (fit.nEff + SHRINK_READS);
    const a = fit.a + (fit.b - b) * fit.xbar;
    const trendLogit = a + b * xTarget;
    // Trust the trend only as far as it explains the history's own movement:
    // the slope's share of the in-sample variance, against the residual
    // noise. A slope that explains nothing falls back to persistence.
    const varExplained =
      b * b * (fit.sxx / Math.max(1, fit.nEff));
    const noise = fit.resid + 0.15;
    const wTrend =
      varExplained / (varExplained + noise * noise);
    let medianLogit = wTrend * trendLogit + (1 - wTrend) * yLast;
    // Never let one fit run away, and never claim a logit past 99.9% / 0.1%:
    // a boundary rate is a censored observation, not a precise one.
    medianLogit =
      yLast + Math.max(-6, Math.min(6, medianLogit - yLast));
    medianLogit = Math.max(-6.9, Math.min(6.9, medianLogit));

    // Spread: random walk + fit prediction variance at the target.
    const leverage =
      1 / Math.max(1, fit.nEff) +
      Math.pow(xTarget - fit.xbar, 2) / Math.max(1e-9, fit.sxx);
    const sigma = Math.min(
      2.5,
      Math.sqrt(
        Math.pow(WALK_SIGMA, 2) * dDays +
          Math.pow(fit.resid, 2) * leverage +
          boundaryVar +
          (earnedLast > 0 && earnedLast < 10 ? 0.09 : 0) +
          0.01,
      ),
    );
    return { medianLogit, sigma: Math.max(0.15, sigma) };
  });

  // Dominance: story-chain medians must not increase along the chain.
  const chain = chainIndices(c.trophies);
  if (chain.length >= 2) {
    const pooled = isotonicDecreasing(
      chain.map((idx) => forecasts[idx].medianLogit),
    );
    chain.forEach((idx, j) => {
      forecasts[idx].medianLogit = pooled[j];
    });
  }

  const trophies = c.trophies.map((trophy, i) => {
    const { medianLogit, sigma } = forecasts[i];
    const q = Z.map((z) =>
      round4(clampPct(logistic(medianLogit + z * sigma))),
    );
    // Rounding can only tie neighbours; enforce the non-decreasing order.
    for (let j = 1; j < q.length; j++) {
      if (q[j] < q[j - 1]) q[j] = q[j - 1];
    }
    return { id: trophy.id, q };
  });
  return { trophies };
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR)
  .filter((f) => f.endsWith('.in'))
  .sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  const out = forecastCase(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify(out)}\n`);
}
