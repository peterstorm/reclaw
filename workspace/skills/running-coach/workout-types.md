# Running Coach — Thursday Workout Types

Read this file on Thursday firings only — it is the catalog of available
quality-day workout formats. Tuesday/Sunday firings prescribe a default easy
run and don't need this catalog.

The 8 types below cover the spectrum of useful Thursday stimuli. Selection
logic (limiter bias, rotation, readiness tiebreakers) lives in the main
skill prompt — this file is purely the catalog.

---

## 1. Classic Intervals — VO2max development
- 2km warmup + 90s rest + N × (distance @ interval pace + rest) + 2km cooldown
- Formats: 5×800m, 6×600m, 8×400m, 4×1000m
- Rest: 90s for ≤600m, 120s for ≥800m
- Use RepeatGroupDTO for identical reps

## 2. Tempo Run — Lactate threshold
- 2km warmup + 90s rest + sustained tempo block (20-30min at tempo pace) + 2km cooldown
- Single long interval step at tempo pace
- Total distance: 8-10km

## 3. Rolling Tempo — Threshold with variety
- 1.5-2km warmup + N × (400m fast + 400m steady) + rest + cooldown
- Fast: interval pace, steady: steady pace
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
- 2km warmup + 90s rest + N × (longer reps @ tempo pace + short rest) + 2km cooldown
- Formats: 4×2km, 3×2.5km, 5×1.5km — all at tempo pace
- Rest: 60-90s (shorter than VO2max intervals — keeps lactate elevated)
- Use RepeatGroupDTO for identical reps
- More sustainable than a 25-min sustained tempo block, better for building threshold duration

## 8. Octopus Session — Multi-stimulus (every 2-3 weeks)
- 2km warmup + 90s rest
- Block A: 4×200m @ repetition pace + 60s rest (neuromuscular)
- 2min transition jog
- Block B: 2×1km @ tempo pace + 90s rest (threshold)
- 2min transition jog
- Block C: 4×400m @ interval pace + 90s rest (VO2max)
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
