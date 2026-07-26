#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
github_app="${GITHUB_APP:-$HOME/.local/bin/github-app}"
dry_run=false

if [[ "${1:-}" == "--dry-run" ]]; then
  dry_run=true
elif [[ -n "${1:-}" ]]; then
  echo "Usage: $0 [--dry-run]" >&2
  exit 2
fi

cd "$repo_root"

if [[ ! -x "$github_app" ]]; then
  echo "GitHub App helper not found at $github_app." >&2
  echo "Set GITHUB_APP to the samantha-clanker github-app executable." >&2
  exit 1
fi

"$github_app" inspect .

if [[ "$(git branch --show-current)" != "main" ]]; then
  echo "Release stopped: check out main before releasing all clients." >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Release stopped: commit or discard every working-tree change first." >&2
  git status --short >&2
  exit 1
fi

git fetch origin main

local_sha="$(git rev-parse HEAD)"
remote_sha="$(git rev-parse origin/main)"

if ! git merge-base --is-ancestor "$remote_sha" "$local_sha"; then
  echo "Release stopped: local main does not contain origin/main. Pull or rebase first." >&2
  exit 1
fi

if [[ "$dry_run" == "true" ]]; then
  echo "Release preflight passed for $local_sha. No changes were pushed or released."
  exit 0
fi

gh_app() {
  "$github_app" gh . -- "$@"
}

find_run() {
  local workflow="$1"
  local event="$2"
  local started_at="$3"
  local run_id=""

  for _ in {1..60}; do
    run_id="$(gh_app run list \
      --workflow "$workflow" \
      --event "$event" \
      --branch main \
      --commit "$local_sha" \
      --limit 20 \
      --json databaseId,createdAt \
      --jq "map(select(.createdAt >= \"$started_at\")) | sort_by(.createdAt) | last | .databaseId // empty")"
    if [[ -n "$run_id" ]]; then
      printf '%s\n' "$run_id"
      return 0
    fi
    sleep 5
  done

  echo "Timed out waiting for $workflow to start." >&2
  return 1
}

dispatch_and_watch() {
  local workflow="$1"
  shift
  local started_at
  local run_id

  started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  gh_app workflow run "$workflow" --ref main "$@"
  run_id="$(find_run "$workflow" workflow_dispatch "$started_at")"
  echo "Watching $workflow run $run_id..."
  gh_app run watch "$run_id" --exit-status
  last_run_id="$run_id"
}

verify_mobile_deployed() {
  local run_log
  run_log="$(gh_app run view "$last_run_id" --log)"
  if grep -q "EXPO_TOKEN is not available; skipping EAS production job" <<<"$run_log"; then
    echo "Mobile release stopped: EXPO_TOKEN is not configured for GitHub Actions." >&2
    return 1
  fi
}

if [[ "$local_sha" != "$remote_sha" ]]; then
  push_started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  git push origin HEAD:main
  relay_run_id="$(find_run deploy-relay.yml push "$push_started_at")"
  echo "Watching relay deployment run $relay_run_id..."
  gh_app run watch "$relay_run_id" --exit-status
else
  echo "origin/main already contains $local_sha; skipping push and relay wait."
fi

dispatch_and_watch release.yml -f channel=nightly
dispatch_and_watch mobile-eas-production.yml -f mode=update -f platform=all \
  -f "message=T3 Code $local_sha"
verify_mobile_deployed
dispatch_and_watch mobile-eas-production.yml -f mode=build -f platform=all
verify_mobile_deployed

echo "All release workflows completed for $local_sha."
echo "Hosted web and mobile OTA clients can refresh now."
echo "Desktop clients must use the nightly channel and approve the offered update."
echo "Mobile native builds were submitted; store availability depends on Apple and Google review."
