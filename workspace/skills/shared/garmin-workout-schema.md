# Garmin Workout JSON — canonical schema

Single source of truth for building workout JSON to schedule on Garmin Connect via
`scripts/garmin-schedule-workout.ts`. Both the **running-coach** (pace-targeted runs) and
**crossfit-coach** (strength/metcon) skills read this file — previously each kept its own copy
and they drifted. Keep sport-agnostic structure here; the two `## Sport deltas` sections at the
bottom hold the only per-sport differences.

---

## Required top-level fields

```json
{
  "workoutName": "[Day] [Type] — [Brief description]",
  "description": "[Detailed human-readable description]",
  "sportType": { "sportTypeId": 1, "sportTypeKey": "running", "displayOrder": 1 },
  "estimatedDistanceInMeters": TOTAL_DISTANCE_OR_NULL,
  "workoutSegments": [{ "segmentOrder": 1, "sportType": { ... }, "workoutSteps": [...] }]
}
```

`sportType` per sport: running → `{ "sportTypeId": 1, "sportTypeKey": "running", "displayOrder": 1 }`;
HIIT/CrossFit → `{ "sportTypeId": 9, "sportTypeKey": "hiit", "displayOrder": 7 }`.

---

## ExecutableStepDTO template (base — all fields)

```json
{
  "type": "ExecutableStepDTO",
  "stepId": null,
  "stepOrder": N,
  "stepType": { "stepTypeId": ID, "stepTypeKey": "KEY", "displayOrder": ID },
  "childStepId": null,
  "description": "Human-readable step description",
  "endCondition": { "conditionTypeId": ID, "conditionTypeKey": "KEY", "displayOrder": ID, "displayable": true },
  "endConditionValue": VALUE_OR_NULL,
  "preferredEndConditionUnit": null,
  "endConditionCompare": null,
  "targetType": { "workoutTargetTypeId": 1, "workoutTargetTypeKey": "no.target", "displayOrder": 1 },
  "targetValueOne": null,
  "targetValueTwo": null,
  "targetValueUnit": null,
  "zoneNumber": null,
  "secondaryTargetType": null,
  "secondaryTargetValueOne": null,
  "secondaryTargetValueTwo": null,
  "secondaryTargetValueUnit": null,
  "secondaryZoneNumber": null,
  "endConditionZone": null,
  "strokeType": { "strokeTypeId": 0, "strokeTypeKey": null, "displayOrder": 0 },
  "equipmentType": { "equipmentTypeId": 0, "equipmentTypeKey": null, "displayOrder": 0 },
  "category": null,
  "exerciseName": null,
  "workoutProvider": null,
  "providerExerciseSourceId": null,
  "weightValue": null,
  "weightUnit": null
}
```

## RepeatGroupDTO template

```json
{
  "type": "RepeatGroupDTO",
  "stepId": null,
  "stepOrder": N,
  "stepType": { "stepTypeId": 6, "stepTypeKey": "repeat", "displayOrder": 6 },
  "childStepId": CHILD_GROUP_ID,
  "numberOfIterations": COUNT,
  "endCondition": { "conditionTypeId": 7, "conditionTypeKey": "iterations", "displayOrder": 7, "displayable": false },
  "endConditionValue": COUNT,
  "preferredEndConditionUnit": null,
  "endConditionCompare": null,
  "skipLastRestStep": null,
  "smartRepeat": false,
  "workoutSteps": [ ... child ExecutableStepDTO steps ... ]
}
```

---

## Step type reference

| Step | stepTypeId | stepTypeKey |
|------|-----------|-------------|
| warmup | 1 | `warmup` |
| cooldown | 2 | `cooldown` |
| interval | 3 | `interval` |
| recovery | 4 | `recovery` |
| rest | 5 | `rest` |
| repeat | 6 | `repeat` |

## End condition reference

| Condition | conditionTypeId | conditionTypeKey | Use |
|-----------|----------------|------------------|-----|
| Lap button | 1 | `lap.button` | cooldowns / For-Time steps — athlete presses when done |
| Time | 2 | `time` | value in seconds (EMOM/AMRAP/Tabata) |
| Distance | 3 | `distance` | value in meters |
| Iterations | 7 | `iterations` | repeat groups — number of rounds |

---

## Rules & gotchas (apply to both sports)

- **stepOrder** must be sequential across ALL steps including children of repeat groups, starting at 1.
- **childStepId** for repeat children: all children of the same repeat group share the same
  `childStepId` (incrementing integer, 1 for the first repeat group, 2 for the second, …).
- **Rest steps:** set `targetType` to `null` (not `no.target`) and `preferredEndConditionUnit` to `null`.
- **Lap.button steps (cooldowns):** set `endConditionValue` to `null`.
- **endConditionCompare:** Garmin returns `""` (empty string) on read — safe to send as `null` on creation.

---

## Creating & scheduling

Write the JSON to a temp file and pipe it to the schedule script:

```bash
cat > /tmp/workout.json << 'WORKOUT_EOF'
{ ... the workout JSON ... }
WORKOUT_EOF
cat /tmp/workout.json | bun /home/peterstorm/dev/claude-plugins/reclaw/scripts/garmin-schedule-workout.ts YYYY-MM-DD
```

Replace `YYYY-MM-DD` with the target date. If it fails: auth error → report and stop; API error →
report the error and show the JSON so the user can debug.

---

## Sport deltas

### Running (pace targets)

For pace-targeted steps, replace the `targetType` block and set the pace values (m/s):

```json
"targetType": { "workoutTargetTypeId": 6, "workoutTargetTypeKey": "pace.zone", "displayOrder": 6 },
"targetValueOne": FAST_PACE_MS,
"targetValueTwo": SLOW_PACE_MS,
```

- Pace targets use m/s: `1000 / (minutes * 60 + seconds)`.
- Always set a ±10s/km range around the target pace.
- `targetValueOne` = faster end (higher m/s), `targetValueTwo` = slower end (lower m/s).
- Example: target 5:00/km → fast 4:50 (3.4483 m/s), slow 5:10 (3.2258 m/s).
- **Distance steps:** include `preferredEndConditionUnit: { "unitId": 2, "unitKey": "kilometer", "factor": 100000 }`.

### Strength / CrossFit (weight + exercise)

For loaded/exercise steps, set the exercise + weight fields on the ExecutableStepDTO:

```json
"category": "EXERCISE_CATEGORY_OR_NULL",
"exerciseName": "EXERCISE_NAME_OR_NULL",
"weightValue": WEIGHT_KG_OR_0,
"weightUnit": { "unitId": 8, "unitKey": "kilogram", "factor": 1000 }
```

- **Weight:** set `weightValue` in kg if specified, otherwise `0`. Always include the
  `weightUnit` object above whenever `weightValue` is set (including `0` for bodyweight).
- Metcon timing uses the Time end condition (seconds); For-Time steps use Lap button.
