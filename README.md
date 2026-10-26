# Reproducer

**Turns bug reports into proof.**

Reproducer is an agent that takes a GitHub issue URL and returns evidence: it triages the report into a machine-checkable symptom spec, researches the error, forms falsifiable root-cause hypotheses, builds clean Python environments, writes and shrinks a minimal reproduction script, verifies the reported symptom through a deterministic gate, bisects the exact version where behavior changed, and publishes a citation-backed report.

> Under active development for the Nebius x NVIDIA Global AI Hackathon (Devpost) — Coding and Agentic Engineering track. Full product spec: [`.agents/PRDs/PRD.md`](.agents/PRDs/PRD.md).

## Status

Pre-alpha. Setup instructions, architecture docs, and the demo guide land with the first milestones — see the PRD for the current plan.

## Quickstart

Requires Node ≥ 22 and [bun](https://bun.sh) 1.4.x.

```sh
bun install
npm start                 # dashboard on PORT (default 8080)
curl http://localhost:8080/healthz   # → 200 {"ok":true}
```

Create a ledger run (no API keys needed):

```sh
npm install -g . && reproducer run https://github.com/octocat/hello-world/issues/1
# or, without a global install:
npm run cli -- run https://github.com/octocat/hello-world/issues/1
npx tsx src/cli.ts run https://github.com/octocat/hello-world/issues/1
```

Each run is persisted to the SQLite ledger at `data/ledger.db` (override with `--db <path>`). Bad URLs exit with code 2 and print `invalid issue url`.

`npm test` runs the unit suite; `npm run typecheck` runs the strict `tsc --noEmit` gate; `npm run build` type-checks again and emits `dist/`. Copy `.env.example` to `.env` and fill in keys only when wiring live providers.
