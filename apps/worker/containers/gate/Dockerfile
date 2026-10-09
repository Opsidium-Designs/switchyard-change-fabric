# The integration gate container: runs one integration job (integrate-cli)
# with the repo's own verification package, driven by the GateRunner Durable
# Object over exec (see apps/worker/src/gate-runner.ts).
#
# Built by wrangler from the REPO ROOT (image_build_context in
# wrangler.jsonc); the root .dockerignore admits only what is copied here.
# The packages run as TypeScript directly (Node's type stripping), the same
# way the CLI runs them, so there is no build step and no bundler.
FROM node:24.21.0-bookworm-slim

# git for the integrator, ca-certificates for the egress CA, util-linux for
# setpriv and prlimit (the install and the gate run as the unprivileged
# `scfgate` user, capped in processes), coreutils for timeout, tini as PID 1 (it reaps
# the orphans a killed sandbox leaves, so no zombie outlives its job).
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates coreutils util-linux tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/scf
COPY packages/verification/package.json packages/verification/package.json
COPY packages/verification/src packages/verification/src
COPY packages/artifact-workspace/package.json packages/artifact-workspace/package.json
COPY packages/artifact-workspace/src packages/artifact-workspace/src
COPY packages/change-core/package.json packages/change-core/package.json
COPY packages/change-core/src packages/change-core/src
# change-core's one runtime dependency, at the version the lockfile pins.
COPY node_modules/yaml node_modules/yaml
# The sandbox user: a dedicated, high uid that no host account uses. Local
# `wrangler dev` runs the container in the HOST's PID namespace, so a uid the
# host also uses (the image's `node`, 1000) would make the sandbox checks see,
# and its kill(-1) reach for, host processes of that uid.
RUN groupadd -g 64321 scfgate \
 && useradd -u 64321 -g 64321 -m -d /home/scfgate -s /usr/sbin/nologin scfgate
RUN mkdir -p node_modules/@switchyard-change \
 && ln -s ../../packages/verification node_modules/@switchyard-change/verification \
 && ln -s ../../packages/artifact-workspace node_modules/@switchyard-change/artifact-workspace \
 && ln -s ../../packages/change-core node_modules/@switchyard-change/change-core \
 && printf '{"type":"module","private":true}\n' > package.json \
 && mkdir -p /work && chmod 0755 /work

# SCF_SANDBOX_HOME is the image's home of the sandbox user: scrubbed before
# every job (each job gives the sandbox a fresh HOME inside its own root).
ENV SCF_WORK_ROOT=/work \
    SCF_SANDBOX_UID=64321 \
    SCF_SANDBOX_GID=64321 \
    SCF_SANDBOX_HOME=/home/scfgate \
    NODE_ENV=production

# The Durable Object drives everything through exec; the main process only
# keeps the container alive (and tini reaps orphans). Every job runs in a
# fresh container.
CMD ["/usr/bin/tini", "--", "sleep", "infinity"]
