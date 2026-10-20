#!/usr/bin/env bash
# A wide-suite-failure action logikája (IT-1808). Bemenet env-ben: TITLE, ASSIGNEE,
# RUN_URL, GITHUB_REPOSITORY, GITHUB_SHA, GITHUB_WORKFLOW (a runner adja), GH_TOKEN.
# Az issue-t pontos címegyezéssel keresi a nyitott issue-k közt (a keresőindex
# késhet, a lista nem), PR-eket kihagyva.
set -euo pipefail

body="A(z) \`${GITHUB_WORKFLOW}\` bő tesztsor nem futott le sikeresen.

[Futás és napló](${RUN_URL})

Commit: \`${GITHUB_SHA}\`."

existing="$(gh api --paginate "repos/${GITHUB_REPOSITORY}/issues?state=open&per_page=100" \
  --jq '.[] | select(.pull_request == null and .title == env.TITLE) | .number' | head -n 1)"

if [[ -n "$existing" ]]; then
  gh issue comment "$existing" -R "$GITHUB_REPOSITORY" --body "$body"
  gh issue edit "$existing" -R "$GITHUB_REPOSITORY" --add-assignee "$ASSIGNEE"
  echo "::warning::Bő sor bukás: komment a #${existing} issue-n"
else
  gh issue create -R "$GITHUB_REPOSITORY" --title "$TITLE" --body "$body" --assignee "$ASSIGNEE"
  echo "::warning::Bő sor bukás: új issue nyílt (${TITLE})"
fi
