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

config_dir="$HOME/.config/opencode"
mkdir -p "$config_dir"
cat > "$config_dir/opencode.json" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "provider": {
    "jarvis": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "JARVIS model",
      "options": { "baseURL": "${JARVIS_JOB_LLM_BASE_URL}" },
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
# files it could read, or that nobody would answer a question.
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
- Make the change in the working tree and commit it with a clear message. If a commit is not possible, say so plainly.
- Nobody can answer questions while you work. If the task is ambiguous, choose the most reasonable interpretation, make the change, and state your assumption in your final message.

Task: ${JARVIS_JOB_PROMPT}"

# The prompt is one argument, quoted: the agent gets the sentence the user
# wrote, not a shell's reading of it. `--` keeps a prompt that begins with a
# dash from being parsed as a flag.
exec opencode run \
    --model "jarvis/${JARVIS_JOB_MODEL_ID}" \
    --auto \
    --format json \
    -- "$context"
