#!/usr/bin/env bash
set -euo pipefail

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "This script must be run from inside a git repository." >&2
  exit 1
fi

current_branch=$(git rev-parse --abbrev-ref HEAD)
if [[ "$current_branch" == "main" ]]; then
  echo "You are already on 'main'. Switch to your feature branch before running this script." >&2
  exit 1
fi

echo "Fetching latest commits from origin..."
git fetch origin

echo "Updating local 'main' from origin/main..."
if git show-ref --verify --quiet refs/heads/main; then
  git checkout main
  git merge --ff-only origin/main
else
  git checkout -b main origin/main
fi

echo "Switching back to '$current_branch'..."
git checkout "$current_branch"

read -p "Do you want to rebase '$current_branch' onto the updated 'main'? [y/N] " reply
if [[ "$reply" =~ ^[Yy]$ ]]; then
  git rebase main
  echo "Rebase complete. Resolve conflicts if prompted, then continue with 'git rebase --continue'."
else
  echo "Merging 'main' into '$current_branch' instead."
  git merge main
fi

echo "Branch '$current_branch' is now synchronized with the latest 'main'."
