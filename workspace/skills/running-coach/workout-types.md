# Running Coach — Monday Workout Types

Read this file on Monday firings only — it is the catalog of available
quality-day workout formats. Wednesday/Thursday firings prescribe a backup easy
run and don't need this catalog.

The 8 types below cover the spectrum of useful Monday stimuli. Selection
logic (limiter bias, rotation, readiness tiebreakers) lives in the main
skill prompt — this file is purely the catalog.

---

## 1. Classic Intervals — VO2max development
- 2km warmup + 90s rest + N × (distance @ prescribed pace + recovery) + 2km cooldown
- Formats: 5×800m, 6×600m, 8×400m, 4×1000m
- Pace: reps under 1000m may use the block's operational goal 5K pace; 1000m reps use current 5K pace. Never use the distant sub-20 pace as the target unless it is the current operational goal.
- Recovery: 90s easy jog for ≤600m, 120s easy jog for ≥800m. If rep quality degrades, slow the recovery jog or extend it rather than forcing bad reps.
- Fast-finish variant (green readiness, no heavy CrossFit within 48h): 4×1000m at current 5K pace with the final 200m of each rep at a controlled faster pace. This replaces the week's normal hard session; it is never extra work.
- Use RepeatGroupDTO for identical reps. The fast-finish variant needs sequential 800m + 200m steps inside each repeat group.

## 2. Tempo Run — Lactate threshold
- 2km warmup + 90s rest + sustained tempo block (20-30min at tempo pace) + 2km cooldown
- Single long interval step at tempo pace
- Total distance: 8-10km

## 3. Rolling Tempo — Threshold with variety
- 1.5-2km warmup + N × (400m fast + 400m steady) + cooldown
- Fast: interval pace; steady: controlled continuous running that acts as the active recovery. Do not stop between segments.
- Use RepeatGroupDTO for the rolling block

## 4. Pyramid Intervals — Progressive intensity
- Warmup + 200m-400m-600m-800m-1000m-800m-600m-400m-200m + cooldown
- Each rep at slightly different pace (faster for shorter, slower for longer)
- Flat sequence (no RepeatGroupDTO — each rep is different)
- Rest: 60s after 200m, 90s after 400m-800m, 120s after 1000m

## 5. Fartlek — Speed play
- Warmup + alternating fast/easy segments (varied durations)
- Less structured — use time-based end conditions
- E.g., 8 × (90s fast + 90s easy)
- Good for weeks with moderate readiness (gentler than structured intervals)

## 6. Short Repeats — Running economy + neuromuscular power
- 2km warmup + 90s rest + N × (150-200m @ repetition pace + full recovery) + 2km cooldown
- Pace: repetition zone (P - 30 to P - 10s/km) — fast but controlled, not sprinting
- Recovery: 60-90s walk/easy jog (full recovery between reps — this is neuromuscular, not aerobic)
- Formats: 10×200m, 12×150m, 8×200m
- Use RepeatGroupDTO for identical reps
- Builds speed, running economy, and leg turnover without high metabolic stress

## 7. Cruise Intervals — Broken threshold
- 2km warmup + 90s rest + N × (longer reps @ current threshold pace + short recovery jog) + 2km cooldown
- Formats: 3×2km, 3×2.5km, 5×1.5km — all at threshold pace, with warmup/cooldown trimmed as needed to keep recovery distance inside the 12km cap
- Recovery: 60-90s easy jog (shorter than VO2max recovery — keeps the aerobic demand continuous)
- Use RepeatGroupDTO for identical reps
- More sustainable than a 25-min sustained tempo block, better for building threshold duration

## 8. Octopus Session — Multi-stimulus (every 2-3 weeks)
- 2km warmup + 90s rest
- Block A: 4×200m @ repetition pace + 60-90s full walk/easy-jog recovery (neuromuscular quality)
- 2min transition jog
- Block B: 2×1km @ threshold pace + 90s easy-jog recovery (threshold)
- 2min transition jog
- Block C: 4×400m @ operational goal/interval pace + 90s easy-jog recovery (VO2max)
- 1.5km cooldown
- Total: ~9-11km
- Vary block contents — always hit at least 2 of: speed/economy, threshold, VO2max
- Use sequential ExecutableStepDTO steps (not RepeatGroupDTO — each block is different)

---

## General structure for hard sessions

- Always include warmup (1.5-2km at easy pace, no target)
- 90s walking rest after warmup
- Main set (intervals, tempo, etc.)
- 1.5-2km cooldown (lap.button end condition — let them jog until ready)
- Total distance: 7-12km depending on format (hard cap at 12km)

### Recovery policy

Active recovery is a race-specific tool, not a universal upgrade:

- Use an easy jog between threshold, cruise, rolling, and race-specific interval reps so the athlete practises recovering while moving.
- Keep full walk/easy-jog recovery for short repetitions, strides, hill sprints, and any quality-first speed work.
- Preserve the prescribed recovery duration when first switching from standing to jogging. Progress density only after all reps remain on pace.
- Encode moving recovery as a Garmin `recovery` step. Use a `rest` step only when stopping or walking is intentional.
