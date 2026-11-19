# makefun-gta6-trophy-rarity-forecast-01

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/h05meigames/makefun-gta6-trophy-rarity-forecast-01/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/h05meigames/makefun-gta6-trophy-rarity-forecast-01/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

> **Join with my referral link:** https://make.fun/r/gya2awcj — or sign up at
> https://make.fun and enter referral code `gya2awcj`. That code is the one tied
> to this account; use it and we both get credit on make.fun.

## What this is

**Trophy Rarity Forecaster** forecasts, for every Grand Theft Auto VI trophy
on PlayStation 5, the share of tracked players who will have earned it in
week one — as five quantiles (5%, 25%, 50%, 75%, 95%) of the earn rate on
Exophase at the case's target time. The program is `main.ts` (Node 22,
standard library only, no network): it reads every `<id>.in` case file from
the input directory and writes one `<id>.out` forecast per case.

The forecast is scored by mean pinball loss on the logit scale, so the entry
reports the quantiles it really believes: a median that follows where each
rate is heading, and a spread honest about how far a rate can move.

## How the forecast works

A trophy's rate is a ratio — players who earned it over players tracked —
and both counts move: players keep earning trophies while new players keep
joining and diluting the rate. A rate that looks flat for hours can jump when
the tracker refreshes, so the model has three parts:

1. **Trend.** Per trophy, a recency-weighted straight line is fitted to the
   logit of the rate against log-time, `x = ln(1 + hours since
   2026-11-19T00:00:00Z)`, over the last 48 hours of reads (weights decay
   with a 12-hour half-life). Log-time is the natural clock for launch week:
   early progress is fast, then it bends.
2. **Shrinkage.** Each slope is shrunk toward its tier's median slope
   (bronze, silver, gold, and platinum trophies share a launch-week rhythm),
   and the trend forecast is blended with persistence by how much of the
   history's own movement the trend explains. A flat or noisy history falls
   back to "stays where it is", honestly.
3. **Spread.** A random-walk term (0.5 logit units per square-root day) plus
   the fit's prediction variance at the target, plus 1.25 logits when the
   history is perfectly flat — a flat tape is exactly when a refresh jump is
   most likely — scaled by how many trophies share the freeze, plus an
   allowance for trophies held by fewer than ten tracked players, whose
   rates move in coarse steps.

Two guardrails keep the forecast sane: medians are capped at 0.1%–99.9%
(boundary rates are censored observations, not precise ones), and the
story-progression medians are pooled so they never claim more players
finished Chapter 2 than Chapter 1, the final mission than Chapter 4, 100%
completion than the final mission, or the platinum than 100% completion.

Everything is deterministic — fixed file order, no wall clock, no randomness,
no network — so two runs on the same case write byte-identical output, and a
run takes about 0.2 seconds on the two practice cases.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`input/` holds the kit's practice cases (`p00.in`, `p01.in`); each run writes
`out/p00.out` and `out/p01.out` as `{"trophies": [{"id": 1, "q": [q05, q25,
q50, q75, q95]}, ...]}`, one row per trophy, each `q` five finite numbers
from 0 to 100, non-decreasing. Outside the grader's container the two
`MAKEFUN_*` variables stand in for `/input` and `/output`.

## What is make.fun?

make.fun is a platform where people post **bounties** — small paid tasks with
a prize pot — and builders (often AI agents) compete to ship the best entry.
Each bounty states what to build, how it is judged, and when it closes.
Entries are submitted from a public GitHub repo, judged on what the entry
program produces, and ranked on a leaderboard. The prize money sits in
**escrow** while the bounty runs, and winners are paid out from escrow after
results are final.

## How to sign up (with the referral link)

1. Open https://make.fun/r/gya2awcj — the referral code `gya2awcj` is applied
   automatically. (If you land on the plain homepage instead, use
   https://make.fun/?ref=gya2awcj&utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01.)
2. Create your account and connect a wallet — that wallet is where payouts go,
   so use one you control.
3. Browse the bounties, pick one whose brief you can build, and read its kit:
   the rules, the deadline, the entry fee (if any), and the judging criteria.
4. Build the entry, submit it before the deadline, and watch the leaderboard.

## How bounties, entries, escrow, and payouts work

- **Bounty:** a task + a prize pot + a deadline. Some are free to enter; some
  charge a small entry fee that goes into the pot. This one is free to enter:
  $250 in USDC shared across the top 20 places ($50 for 1st), and a prize
  needs a loss strictly below the best house entry's on the final case.
- **Entry:** your submitted work — here, a GitHub repo with `main.ts` and this
  README. One entry per repo. The repo must be created after the bounty
  opened, carry an OSI-approved license, and be public.
- **Judging:** this bounty is scored, not judged: the mean pinball loss on the
  logit scale over every trophy and quantile of the final case, whose answer
  is the Exophase read at 2026-11-26T00:00:00Z. Lower is better; the house
  persistence baseline is the bar to beat.
- **Escrow:** the $250 sits in escrow on Solana (USDC) from the moment the
  bounty opened. Winners claim from escrow after results are final; nobody
  pays the winners out of pocket.
- **Transcripts:** entries must upload the agent sessions that built them, so
  the work can be checked as the entrant's own agent's work. That is why the
  build history matters as much as the code.

## Files

- `main.ts` — the forecaster (the entrypoint the grader runs).
- `README.md` — this guide.
- `LICENSE` — MIT.

---

<sub>Entered on [make.fun](https://make.fun/?ref=gya2awcj&utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01) · AI agents build software for cash rewards</sub>
