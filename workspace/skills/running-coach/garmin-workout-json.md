# Running Coach — Garmin Workout JSON Reference

Read this file on Thursday firings (when constructing a workout to schedule
on Garmin). Tuesday/Sunday firings prescribe a simple easy-run fallback —
the inline shape is small enough to keep in the main prompt.

---

## Required top-level fields for all workouts

```json
{
  "workoutName": "[Day] [Type] — [Brief description] ([total distance])",
  "description": "[Detailed human-readable description with paces in min/km]",
  "sportType": { "sportTypeId": 1, "sportTypeKey": "running", "displayOrder": 1 },
  "estimatedDistanceInMeters": TOTAL_DISTANCE_OR_NULL,
  "workoutSegments": [{ "segmentOrder": 1, "sportType": { ... }, "workoutSteps": [...] }]
}
```

---

## ExecutableStepDTO template

```json
{
  "type": "ExecutableStepDTO",
  "stepId": null,
  "stepOrder": N,
  "stepType": { "stepTypeId": ID, "stepTypeKey": "KEY", "displayOrder": ID },
  "childStepId": null,
  "description": "Human-readable step description",
  "endCondition": { "conditionTypeId": ID, "conditionTypeKey": "KEY", "displayOrder": ID, "displayable": true },
  "endConditionValue": VALUE,
  "preferredEndConditionUnit": { "unitId": 2, "unitKey": "kilometer", "factor": 100000 },
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

### For pace-targeted steps, replace targetType block with:

```json
"targetType": { "workoutTargetTypeId": 6, "workoutTargetTypeKey": "pace.zone", "displayOrder": 6 },
"targetValueOne": FAST_PACE_MS,
"targetValueTwo": SLOW_PACE_MS,
```

---

## RepeatGroupDTO template

```json
{
  "type": "RepeatGroupDTO",
  "stepId": null,
  "stepOrder": N,
  "stepType": { "stepTypeId": 6, "stepTypeKey": "repeat", "displayOrder": 6 },
  "childStepId": CHILD_GROUP_ID,
  "numberOfIterations": COUNT,
  "workoutSteps": [ ... child ExecutableStepDTO steps ... ],
  "endConditionValue": COUNT,
  "preferredEndConditionUnit": null,
  "endConditionCompare": null,
  "endCondition": { "conditionTypeId": 7, "conditionTypeKey": "iterations", "displayOrder": 7, "displayable": false },
  "skipLastRestStep": null,
  "smartRepeat": false
}
```

---

## Step type reference

- warmup: stepTypeId=1, stepTypeKey="warmup"
- cooldown: stepTypeId=2, stepTypeKey="cooldown"
- interval: stepTypeId=3, stepTypeKey="interval"
- recovery: stepTypeId=4, stepTypeKey="recovery"
- rest: stepTypeId=5, stepTypeKey="rest"
- repeat: stepTypeId=6, stepTypeKey="repeat"

## End condition reference

- lap.button: conditionTypeId=1 (for cooldowns — run until you press lap)
- time: conditionTypeId=2 (value in seconds)
- distance: conditionTypeId=3 (value in meters)
- iterations: conditionTypeId=7 (for repeat groups)

---

## Per-step gotchas

- **For rest steps:** set `targetType` to null (not no.target), and `preferredEndConditionUnit` to null.
- **For cooldown with lap.button:** set `endConditionValue` to null.
- **For distance steps:** include `preferredEndConditionUnit: { "unitId": 2, "unitKey": "kilometer", "factor": 100000 }`.
- **stepOrder:** must be sequential across ALL steps including children of repeat groups. Start at 1.
- **childStepId for repeat children:** all children of the same repeat group share the same `childStepId` (incrementing integer, starting at 1 for first repeat group, 2 for second, etc.).

## Pace target encoding

- Pace targets use m/s: `1000 / (minutes * 60 + seconds)`
- Always set a range of ±10s/km around the target pace
- targetValueOne = faster end (higher m/s), targetValueTwo = slower end (lower m/s)
- Example: target 5:00/km → fast=4:50 (3.4483 m/s), slow=5:10 (3.2258 m/s)
