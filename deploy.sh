#!/bin/bash
# misen.space — one-shot deploy script.
#
# Run this from your Mac terminal once (not from Claude — it needs your GitHub
# and Cloudflare credentials):
#
#   bash ~/Documents/Projects/Sites/misen-space/deploy.sh
#
# What it does:
#   1. Pushes this repo to GitHub (creates samirsmith/misen-space if needed)
#   2. Logs in to Cloudflare via wrangler (interactive, one-time)
#   3. Creates the KV namespace for signups
#   4. Creates the Pages project and binds the KV namespace
#   5. Triggers the first production deploy
#
# After this finishes you'll get a URL like https://misen-space.pages.dev.
# Wire up the misen.space custom domain in the Cloudflare dashboard
# (Pages → misen-space → Custom domains → Set up a domain → misen.space).

set -euo pipefail
cd "$(dirname "$0")"

GH_USER="hello-sami"
GH_REPO="misen-space"
CF_PROJECT="misen-space"
KV_NAME="misen-signups"

echo "▸ Push to GitHub"
if ! git remote get-url origin >/dev/null 2>&1; then
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    gh repo create "${GH_USER}/${GH_REPO}" --public --source=. --remote=origin --push
  else
    echo "  ! 'gh' CLI not found or not logged in. Install with 'brew install gh && gh auth login'."
    echo "  ! Falling back to manual remote setup."
    git remote add origin "git@github.com:${GH_USER}/${GH_REPO}.git"
    git push -u origin main
  fi
else
  git push origin main
fi

echo
echo "▸ Cloudflare login (one-time, opens browser)"
npx --yes wrangler@latest login || true

echo
echo "▸ Create KV namespace ${KV_NAME}"
KV_OUT=$(npx --yes wrangler@latest kv namespace create "${KV_NAME}" 2>&1 || true)
echo "${KV_OUT}"
KV_ID=$(echo "${KV_OUT}" | grep -oE 'id = "[a-f0-9]+"' | head -1 | sed 's/id = "//;s/"//')
if [ -z "${KV_ID}" ]; then
  # If the namespace already existed, look it up.
  KV_ID=$(npx --yes wrangler@latest kv namespace list 2>/dev/null \
    | python3 -c "import sys, json; ns=json.load(sys.stdin); print(next((n['id'] for n in ns if n['title'].endswith('${KV_NAME}')), ''))")
fi

if [ -z "${KV_ID}" ]; then
  echo "  ! Couldn't determine KV namespace id. Create one manually in the dashboard"
  echo "    and bind it as 'SIGNUPS' to the Pages project."
else
  echo "  ✓ KV id: ${KV_ID}"
fi

echo
echo "▸ Create Pages project ${CF_PROJECT}"
npx --yes wrangler@latest pages project create "${CF_PROJECT}" \
  --production-branch=main 2>&1 | tail -3 || true

echo
echo "▸ First production deploy"
npx --yes wrangler@latest pages deploy . \
  --project-name="${CF_PROJECT}" \
  --branch=main

echo
echo "▸ Done."
echo
echo "Next, in the Cloudflare dashboard:"
echo "  1. Pages → ${CF_PROJECT} → Settings → Functions → KV namespace bindings"
echo "     Add: Variable = SIGNUPS, Namespace = ${KV_NAME} (id ${KV_ID:-<look up>})"
echo "  2. Pages → ${CF_PROJECT} → Custom domains → Set up a custom domain"
echo "     Add: misen.space"
echo
echo "Auto-deploys: connect the GitHub repo under Pages → Settings → Builds &"
echo "Deployments → Connect to Git → ${GH_USER}/${GH_REPO}. Every push to main"
echo "will deploy from then on."
