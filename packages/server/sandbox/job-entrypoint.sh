#!/bin/sh
# The coding sandbox's entrypoint (#141).
#
# Runs inside a container the server started with:
#
#   - the job's branch checked out at /workspace (the only writable mount),
#   - a read-only root filesystem and a writable tmpfs HOME,
#   - no credentials, no docker socket, no host home directory,
#   - the task, model id and endpoint in the environment.
#
# The agent's provider block is generated *here*, from the environment, rather
# than baked into the image: a deployment changes its model or endpoint without
# rebuilding, and — the security half — no file from the job's repository can
# ever name a provider. The config lives under `$HOME`, which is tmpfs.
#
# `--auto` exists because there is no human in the container to approve a tool
# call. It is safe only because the sandbox has nothing worth approving access
# to: the workspace is the only mount, and the only network peer is the model.
set -eu

: "${JARVIS_JOB_PROMPT:?JARVIS_JOB_PROMPT is required}"
: "${JARVIS_JOB_REPO:?JARVIS_JOB_REPO is required}"
: "${JARVIS_JOB_BRANCH:?JARVIS_JOB_BRANCH is required}"
: "${JARVIS_JOB_MODEL_ID:?JARVIS_JOB_MODEL_ID is required}"
: "${JARVIS_JOB_LLM_BASE_URL:?JARVIS_JOB_LLM_BASE_URL is required}"

# A coding job is a development/test checkout (#94): the agent's own checks and
# the entrypoint's gate need the dev toolchain. `test` rather than `development`
# because the logger's sensitive-payload tests expect redaction by default. The
# cache lives beside the workspace because `/home/job` is a 256 MB tmpfs; a full
# monorepo install would fill it before the check could start. `.jarvis/` is
# excluded from the commit by the workspace manager.
export NODE_ENV=test
export NPM_CONFIG_CACHE=/workspace/.jarvis/npm-cache
export NPM_CONFIG_LOGS_DIR=/workspace/.jarvis/npm-logs
mkdir -p "$NPM_CONFIG_CACHE" "$NPM_CONFIG_LOGS_DIR"

# Seed the brief from the task so a context compaction always has the
# feedback and acceptance at hand. The agent may refine it, but it cannot
# start without the task in a file it can re-read.
mkdir -p .jarvis
printf '%s\n' "$JARVIS_JOB_PROMPT" > .jarvis/brief.md

config_dir="$HOME/.config/opencode"
mkdir -p "$config_dir"

# The key is embedded in a JSON document, and this script has no JSON escaper.
# API keys are a restricted alphabet in practice; refuse anything else rather
# than produce a config that fails in a confusing way deeper in the agent.
api_field=""
if [ -n "${JARVIS_JOB_API_KEY:-}" ]; then
    case "$JARVIS_JOB_API_KEY" in
        *[!A-Za-z0-9._-]*)
            echo "JARVIS_JOB_API_KEY contains characters this entrypoint cannot safely embed" >&2
            exit 1
            ;;
    esac
    api_field=", \"apiKey\": \"${JARVIS_JOB_API_KEY}\""
fi

cat > "$config_dir/opencode.json" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "provider": {
    "jarvis": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "JARVIS model",
      "options": { "baseURL": "${JARVIS_JOB_LLM_BASE_URL}"${api_field} },
      "models": {
        "${JARVIS_JOB_MODEL_ID}": { "name": "${JARVIS_JOB_MODEL_ID}" }
      }
    }
  }
}
EOF

cd /workspace

# A bounded map of the repository, built from git. The live run that motivated
# this guessed two file names, read one unrelated file, and concluded the color
# "is not directly defined in the codebase" — it had no idea what was in the
# tree. A map costs a few hundred bytes and replaces guessing with reading.
# `|| true` on the filters: an empty result is a valid map, not a failed job.
source_dirs="$(git ls-files | awk -F/ 'NF > 1 { print $1 "/" $2 }' | sort -u | head -30 || true)"
stylesheets="$(git ls-files | grep -Ei '\.(css|scss|sass|less)$' | head -20 || true)"

# Context before the instruction. The first live job showed why: asked to
# "change the primary color", a small model answered "I cannot … without
# specific context or files to edit" and exited without reading anything. It
# was not refusing the sandbox — it did not know it was *in* a clone, which
# files it could read, or that a question could be posted and answered.
context="You are JARVIS's coding agent, working in a git clone of ${JARVIS_JOB_REPO} on branch ${JARVIS_JOB_BRANCH} at /workspace.

Repository map (directories that contain tracked files; never guess a path, search for it):
${source_dirs}
${stylesheets:+
Stylesheets in this repository:
${stylesheets}
}
How to work:
- Search before you read. Use grep or glob with broad patterns and read what they return. Search the concept in several spellings (\`primary\`, \`--primary\`, \`accent\`, \`brand\`, \`color\`), not only the user's exact words.
- Never conclude that something is absent after one or two guessed filenames. If a search finds nothing, broaden it or list the directory; a failed guess is not evidence.
- Use the read, glob and grep tools to inspect files, and edit and write to change them. Do not use shell with cat, grep, sed or heredocs for file I/O; reserve shell for builds, tests and git.
- Write your plan to .jarvis/plan.md before editing.
- If the task is ambiguous, or the task or issue lists decisions or open questions, write .jarvis/questions.json and stop. The supervisor posts the questions and resumes you with the answers; do not pick a decision that changes the outcome. If the task asks for plan approval, ask for it in the same file.
- Wire every new component or module into every surface the task names. A new file that nothing imports is not a change.
- This container has no GitHub credentials. Do not run \`gh\`, and do not fetch issue or pull-request pages; the task and PR context are in this prompt.
- Prefer \`edit\` for an existing file; use \`write\` only for a new file or a complete replacement.
- Keep .jarvis/brief.md to the task, the feedback, the acceptance criteria and the surfaces; re-read it after a context compaction.
- Run \`npm run check\` from /workspace as soon as the edits are complete, before your final message. Fix every failure (lint, types, tests and formatting). The entrypoint re-runs it; a red check fails the job and no pull request opens.
- Make the change in the working tree and commit it with a clear message. Never merge a pull request. If a commit is not possible, say so plainly.

Task: ${JARVIS_JOB_PROMPT}"

# The prompt is one argument, quoted: the agent gets the sentence the user
# wrote, not a shell's reading of it. `--` keeps a prompt that begins with a
# dash from being parsed as a flag.
# `--standalone` is v2's "private server": without it the CLI discovers or
# starts a shared background service on the host, and a job container wants the
# process it was given to be the whole story — it dies with the container.
#
# The entrypoint does not `exec` any more: a completed run has to pass the
# repository's own gate before the supervisor may publish it (#94). A run that
# parked on questions is exempt; its check happens on the answer run, after the
# edits exist.
if opencode run \
    --standalone \
    --model "jarvis/${JARVIS_JOB_MODEL_ID}" \
    --auto \
    --format json \
    -- "$context"; then
    status=0
else
    status=$?
fi

if [ "$status" -eq 0 ] && [ ! -f .jarvis/questions.json ]; then
    # A partial `npm install` can leave a node_modules that cannot run the
    # check; look for the tools themselves. The old image defaulted to
    # production, so an install the agent ran may have no dev deps at all.
    rm -rf "$HOME/.npm"
    if [ ! -x node_modules/.bin/eslint ] ||
        [ ! -x node_modules/.bin/tsc ] ||
        [ ! -x node_modules/.bin/vitest ] ||
        [ ! -x node_modules/.bin/vite ] ||
        [ ! -x node_modules/.bin/prettier ]; then
        echo "JARVIS: installing development dependencies for the check" >&2
        if ! npm install --include=dev --no-audit --no-fund; then
            echo "JARVIS_CHECK_FAILED: npm install failed" >&2
            exit 1
        fi
    fi
    echo "JARVIS: running npm run check" >&2
    if ! npm run check; then
        echo "JARVIS_CHECK_FAILED: npm run check failed; the job will not publish" >&2
        exit 1
    fi
    # Scratch, not part of the change: a successful job keeps its workspace,
    # and a full install cache is hundreds of MB of it.
    rm -rf .jarvis/npm-cache .jarvis/npm-logs
fi

exit "$status"
