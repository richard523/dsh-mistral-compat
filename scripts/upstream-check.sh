#!/bin/sh
# upstream-check.sh — drift report for the fork line vs upstream
# deepseek-ai/deepseek-harness.
#
# The fork (richard523/dsh-mistral-compat) carries upstream master up to a
# known merge point (the "divergence base" in README.md) and commits strictly
# on top. This script is the deterministic half of the weekly sync routine:
# it fetches both remotes and prints a compact report of how far the line has
# drifted — behind/ahead counts, the base, unpushed local commits, and the
# upstream release tags the fork has not taken yet.
#
# It never merges, rebases, or pushes: the agent reading the report decides
# whether a worktree-sync is worth proposing (see the README's divergence
# section for the merge-in procedure).
#
# Exit codes an agent can branch on:
#   0  no upstream releases beyond the fork base — nothing to sync
#   3  upstream carries release tags the fork has not taken — sync candidate
#   2  operational failure (not a repo, fetch error)
#
# Usage:
#   scripts/upstream-check.sh           (run from anywhere; resolves the repo)
set -u

# Resolve through symlinks so the checkout that owns this script is checked.
script="$0"
if resolved=$(readlink -f -- "$0" 2>/dev/null) && [ -n "$resolved" ]; then
  script="$resolved"
fi
here=$(CDPATH= cd -- "$(dirname -- "$script")" && pwd) || exit 2
REPO_ROOT=$(CDPATH= cd -- "$here/.." && pwd) || exit 2
cd "$REPO_ROOT" || exit 2

# Quiet unless something changes; a fetch failure is fatal for the report.
if ! git fetch origin --tags --prune >/dev/null 2>&1; then
  echo "upstream-check: fetch from origin (deepseek-ai/deepseek-harness) failed" >&2
  exit 2
fi
if ! git fetch template-origin --prune >/dev/null 2>&1; then
  echo "upstream-check: fetch from template-origin (richard523/dsh-mistral-compat) failed" >&2
  exit 2
fi

base=$(git merge-base origin/master master) || exit 2
counts=$(git rev-list --left-right --count origin/master...master)
behind=$(printf '%s' "$counts" | cut -f1)
ahead=$(printf '%s' "$counts" | cut -f2)
unpushed=$(git rev-list --count template-origin/main..master 2>/dev/null \
  || echo "?")
base_subject=$(git show -s --format='%h %cs %s' "$base")
upstream_head_tag=$(git describe --tags --match 'dsh-v*' origin/master 2>/dev/null \
  || echo "(no tag)")

# Upstream releases the fork has not folded in: version tags NEWER than the
# release the fork base synced. The base is a worktree-sync MERGE into master,
# and release tags sit on release branches, so neither --no-merged master nor
# a describe of the base is the right anchor — the base's own subject carries
# the synced release name ("...worktree-sync-release-dsh-<ver>-to-master").
base_subject_text=$(git show -s --format='%s' "$base")
base_tag=$(printf '%s\n' "$base_subject_text" \
  | sed -n 's/.*worktree-sync-release-dsh-\([0-9][^ ]*\)-to-master.*/dsh-v\1/p')
all_tags=$(git tag --list 'dsh-v*' --sort=v:refname)
if [ -n "$base_tag" ] && printf '%s\n' "$all_tags" | grep -qx "$base_tag"; then
  new_tags=$(printf '%s\n' "$all_tags" | awk -v b="$base_tag" '$0==b{found=1;next} found{print}')
else
  new_tags=$(git tag --list 'dsh-v*' --no-merged master --sort=v:refname)
fi
new_count=$(printf '%s\n' "$new_tags" | grep -c . || true)
next_release=$(printf '%s\n' "$new_tags" | tail -1)
[ -z "$next_release" ] && next_release='-'

echo "upstream-check $(date '+%Y-%m-%d %H:%M %Z')"
echo "  fork base:        $base_subject"
echo "  upstream head:    $(git show -s --format='%h %cs' origin/master) (nearest tag: $upstream_head_tag)"
echo "  drift:            behind upstream $behind commit(s), fork-only $ahead commit(s)"
echo "  unpushed:         $unpushed commit(s) ahead of template-origin/main"
if [ "$new_count" -gt 0 ]; then
  echo "  unsynced releases: $new_count (next: $next_release)"
  printf '%s\n' "$new_tags" | sed 's/^/    /'
else
  echo "  unsynced releases: none — upstream carries no dsh-v* tag newer than the base"
fi

[ "$new_count" -gt 0 ] && exit 3
exit 0
