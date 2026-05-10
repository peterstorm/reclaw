# Shared Git Activity Queries

Reusable procedure for the GitHub-API git-activity gathering pattern used by
`evening-journal`, `weekly-review`, `monthly-review`, and `insights-engine`.

These four skills used to embed near-identical query blocks (~25 lines each).
They now reference this file. To run the procedure, read the file with the
`Read` tool, then substitute the parameters listed below.

---

## Parameters (set per skill)

| Param        | Used in                                                     |
|--------------|-------------------------------------------------------------|
| `CUTOFF`     | ISO timestamp; lower bound for "active" repos and commits.  |
| `PER_PAGE`   | Commits per page for branch sweep (20 / 50 / 100).          |
| `OUTPUT_FMT` | `messages` (sha+title), `counts` (per-branch counts), or both. |

Skill-specific recipes:

- **evening-journal** → `CUTOFF="{{date}}T00:00:00"`, `PER_PAGE=20`, `OUTPUT_FMT=messages`
- **weekly-review** → `CUTOFF=$(date -d '7 days ago' --iso-8601=seconds)`, `PER_PAGE=50`, `OUTPUT_FMT=messages`
- **monthly-review** → `CUTOFF=$(date -d '1 month ago' --iso-8601=seconds)`, `PER_PAGE=100`, `OUTPUT_FMT=messages`
- **insights-engine** → `CUTOFF=$(date -d '14 days ago' --iso-8601=seconds)`, `PER_PAGE=100`, `OUTPUT_FMT=counts`

---

## Step A — Find active repos

Find repos pushed since the cutoff:

```bash
gh api "user/repos?sort=pushed&per_page=30&type=owner" \
  --jq --arg cutoff "$CUTOFF" '.[] | select(.pushed_at >= $cutoff) | .name'
```

For evening-journal specifically (date-only cutoff), use:
```bash
gh api "user/repos?sort=pushed&per_page=10&type=owner" \
  --jq '.[] | select(.pushed_at >= "{{date}}") | .name'
```

---

## Step B — Per-repo branch sweep (deduped by SHA)

For each active repo, enumerate **all branches** and collect commits per
branch since the cutoff, deduping by SHA. This captures feature branches
that have no open PR yet — default-branch-only queries miss them.

### `OUTPUT_FMT=messages` (sha + title per commit, grouped by branch)

```bash
for branch in $(gh api "repos/peterstorm/REPO/branches?per_page=100" --jq '.[].name'); do
  gh api "repos/peterstorm/REPO/commits?sha=$branch&since=$CUTOFF&per_page=$PER_PAGE" \
    --jq ".[] | \"$branch\\t\\(.sha[0:7])\\t\\(.commit.message | split(\"\\n\")[0])\""
done | sort -u -k2,2
```

### `OUTPUT_FMT=counts` (per-branch commit counts after cross-branch dedup)

```bash
for branch in $(gh api "repos/peterstorm/REPO/branches?per_page=100" --jq '.[].name'); do
  gh api "repos/peterstorm/REPO/commits?sha=$branch&since=$CUTOFF&per_page=$PER_PAGE" \
    --jq ".[] | \"$branch\\t\\(.sha)\""
done | sort -u -k2,2 | awk -F'\t' '{print $1}' | sort | uniq -c
```

Replace `REPO` with each repo name from Step A. The branch list is capped
at 100 per repo (paginate manually if a repo has more — none currently do).

---

## Step C — Open PRs (always fetched)

```bash
gh api "repos/peterstorm/REPO/pulls?state=open&per_page=10" \
  --jq '.[] | "#\(.number) [\(.head.ref)] \(.title)"'
```

Use this for context — branch names + titles. Useful to correlate the
branches found in Step B with what's already in review.

---

## Output expectations

- Group results by repo. Inside a repo, group by branch.
- Include feature-branch work even without an open PR — it represents real
  effort.
- For `OUTPUT_FMT=messages`, the digest line per commit should fit on one
  line: `<branch> <sha7> <message-first-line>`.
- For `OUTPUT_FMT=counts`, the digest line per repo should read:
  `REPO: N commits on main, M commits on feat/X, K commits on bugfix/Y`.

---

## Notes / gotchas

- The `peterstorm/REPO` org/owner is hardcoded — all reclaw skills run
  against this account.
- `--per_page` matters: too low and weekly/monthly sweeps drop commits
  silently.
- The branch list call (`repos/.../branches`) doesn't expose deleted
  branches. Recently deleted feature branches won't appear even if their
  commits are in the cutoff window.
- `gh api` uses the `gh` CLI's stored auth — the reclaw runtime relies on
  that being configured. No fallback if auth is missing.
