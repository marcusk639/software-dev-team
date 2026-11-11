# syntax=docker/dockerfile:1
#
# The team as a worker image: an outer orchestrator (Hermes, hco) runs one
# container per job against a checkout mounted at /workspace and reads the
# JSON result from stdout. See docs/deployment.md for the run flags, the
# credentials it must and must not get, and the volume that keeps sessions
# resumable.
#
#   docker build -t software-dev-team .
#   docker run --rm software-dev-team --profiles

FROM node:22-trixie-slim

# Pinned so a rebuild is the same image. firebase-tools 15 needs Java 21.
ARG FIREBASE_TOOLS_VERSION=15.29.0
ARG PNPM_VERSION=12.6.0

# git: the team reads history and diffs, and the harness lists changed files.
# Java: the Firestore, Storage and Database emulators. tini: forwards signals
# so a stopped container ends the run (and its subprocesses) cleanly.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates git openjdk-21-jre-headless tini \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g "firebase-tools@${FIREBASE_TOOLS_VERSION}" "pnpm@${PNPM_VERSION}" \
 && npm cache clean --force \
 # A mounted checkout is usually owned by another uid; without this git
 # refuses to read it ("dubious ownership").
 && git config --system --add safe.directory /workspace

# The harness is installed as root, so the run (uid 1000) can read it but not
# change it: a test or a script the team writes cannot edit the code that
# enforces the team's own policy, in this run or a later one.
WORKDIR /opt/software-dev-team
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Development dependencies included: the harness runs from source with tsx.
RUN pnpm install --frozen-lockfile && pnpm store prune && rm -rf /root/.cache /root/.local
COPY tsconfig.json ./
COPY plugin ./plugin
COPY src ./src

# The node image's uid 1000. Never root: the run must not be able to change
# the image, and Claude Code refuses some modes as root.
USER node
ENV HOME=/home/node
# firebase-tools writes firebase-debug.log into the working directory.
WORKDIR /home/node

# Emulator binaries are downloaded at first use; fetch them now so test runs
# need no network for them and every job starts from the same versions.
RUN firebase setup:emulators:firestore \
 && firebase setup:emulators:storage \
 && firebase setup:emulators:database \
 && firebase setup:emulators:ui

# Session transcripts live here; mount a volume on it so --resume survives a
# container restart (docs/deployment.md).
ENV CLAUDE_CONFIG_DIR=/home/node/.claude
RUN mkdir -p "$CLAUDE_CONFIG_DIR"
VOLUME ["/home/node/.claude"]

WORKDIR /workspace
# The harness's own tsx, by path: `node --import tsx` would resolve tsx from
# /workspace, the target's checkout.
ENTRYPOINT ["tini", "--", "/opt/software-dev-team/node_modules/.bin/tsx", "/opt/software-dev-team/src/index.ts"]
CMD ["--help"]
