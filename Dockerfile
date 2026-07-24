# Cloud runner image. The runner shells out to the Claude Code CLI, so the
# image carries node + the CLI + the company-preview plugin, all pinned at
# build time: a container has no interactive `claude` login and no plugin
# marketplace state, so nothing may be resolved at runtime.
FROM node:22-slim

# git clones the plugin at build time; ca-certificates for TLS out to Supabase
# and the Anthropic API.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --shell /usr/sbin/nologin runner

WORKDIR /app

COPY package.json package-lock.json ./
# --no-save keeps the CLI out of package.json: it is a dependency of this
# image, not of the npm package people install with `npx`.
RUN npm ci --omit=dev && npm install --no-save @anthropic-ai/claude-code

# Vendored plugin. Setting PLUGIN_DIR makes the runner pass --plugin-dir
# explicitly rather than relying on a marketplace install that cannot exist
# here, and it is where the runner reads references/output-schema.json from.
# Pin PLUGIN_REF to a tag to stop a plugin change from silently altering
# research behaviour on the next deploy.
ARG PLUGIN_REF=main
RUN git clone --depth 1 --branch "${PLUGIN_REF}" \
      https://github.com/ck22coding/king-research /opt/king-research \
  && chown -R runner:runner /opt/king-research
ENV PLUGIN_DIR=/opt/king-research/plugins/company-preview

COPY . .
RUN chown -R runner:runner /app
USER runner

# `command -v claude` cannot find a non-global install, and the runner exits
# loudly rather than guess — so point it straight at the binary.
ENV CLAUDE_BIN=/app/node_modules/.bin/claude
# One job at a time. Each job fans out to six concurrent topic nodes, so the
# package default of 2 would put ~12 Claude CLI processes in one container.
ENV RUNNER_CONCURRENCY=1
# Serve every user's jobs, not one owner's. Requires SUPABASE_SERVICE_ROLE_KEY
# at runtime (supplied as a secret, never baked into the image) — the runner
# exits at boot rather than start up half-configured.
ENV RUNNER_MODE=cloud
# Claude Code writes config/state under $HOME; without this it lands somewhere
# unwritable for a non-root user and the CLI fails on first run.
ENV HOME=/home/runner

CMD ["node", "index.mjs"]
