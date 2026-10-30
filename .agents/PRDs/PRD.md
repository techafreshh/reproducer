# PRD: Reproducer

**Tagline:** Turns bug reports into proof.
**Track:** Coding and Agentic Engineering — Nebius x NVIDIA Global AI Hackathon (Devpost)
**Deadline:** Oct 30, 2026, 6:00pm WAT (10:00am PDT) · Demo must stay live & free until Dec 15, 2026
**Repo:** `techafreshh/reproducer` (public, MIT) · **Status:** PRD approved — build executed via pi-dark-factory (instabox lanes)

---

## 1. Executive Summary

Reproducer is an autonomous agent that takes a GitHub issue URL and returns **evidence**: it parses the report into a machine-checkable symptom spec, researches the error against the web, forms falsifiable root-cause hypotheses, builds clean Python environments, writes and shrinks a minimal reproduction script, verifies the reported symptom through a **deterministic gate** (never an LLM judgment), bisects the exact version where behavior changed, and publishes a report with a standalone repro script, citations, and a bisect table.

The system's load-bearing principle is inherited from the author's software-factory pattern: **the verifier is frozen before the implementer wakes up.** A fast model triages the issue into a symptom spec; the spec is then written to the ledger and latched — the investigation session (a slower reasoning model) has no tool that can modify it. The agent decides *what to try*; the frozen spec decides *what counts as reproduced*.

MVP goal: by Oct 30, ship a public repo where a single CLI command (`reproducer <issue-url>`) runs the full pipeline end-to-end on three pre-verified demo issues, a keyless replay mode lets judges run everything without API keys, a one-page dashboard renders every tool call and artifact, a GitHub Action reproduces issues on the author's own repo, and a persistent demo stays live until judging ends — with all LLM inference on Nebius Token Factory (Nemotron models).

## 2. Mission

**Mission:** eliminate the "can't reproduce / works on my machine" stall in open-source bug triage by turning well-written bug reports into verified, bisected, citation-backed reproductions — automatically.

**Core principles**

1. **Proof over prose** — reproduction claims always trace to a deterministic gate verdict plus a runnable artifact; no prose-only conclusions.
2. **Frozen verifier** — the symptom spec is frozen and latched before the investigation session starts; the agent that investigates can never tune the test it is graded against.
3. **Untrusted input never steers the agent** — issue text and every web result pass a sanitizer boundary before entering any LLM context.
4. **Honest failure** — budget exhaustion yields `inconclusive` with best evidence attached; fabricated success is a bug, not a feature.
5. **Self-contained by default** — bundled fixtures, replay mode, and no posting anywhere without explicit `--post` plus an allowlist.

## 3. Target Users

| Persona | Context | Technical comfort | Need / pain point |
|---|---|---|---|
| **OSS maintainer/triager** | Buries them in unreproducible reports | High (CLI, GitHub, CI) | Wants a verified minimal repro + version boundary without hours of manual setup |
| **Library user filing a bug** | Suspects a regression, unsure | Medium | Wants proof the bug is real and the version where it appeared, before filing |
| **Hackathon judge** | Evaluates the submission | May only watch video + dashboard | Demo must stand alone; replay mode must work with zero keys and zero setup |
| **Operator (author)** | Runs the deployed demo | High | Budget latches, no-post default, secrets hygiene, uptime until Dec 15 |

Judges may not test at all — the video must stand alone, and the dashboard must make the agent's reasoning inspectable without running anything.

## 4. MVP Scope

### In Scope

**Core pipeline**
- [ ] Ingest + triage (MODEL_FAST): issue → structured **symptom spec** JSON (library, versions, symptom class, verbatim error strings, stack-frame signatures, trigger description), then **frozen + latched** in the ledger
- [ ] Research phase (TinyFish in MODEL_REASON session): exact error strings, changelog mining for the version range, related issues/SO; verdict per branch: known-bug-fixed-later / likely-regression / likely-misconfiguration
- [ ] Hypothesize: 1–3 root-cause candidates, each with a falsifiable prediction
- [ ] Build & repro loop: sandbox env, minimal repro script, gate-graded runs, shrink toward minimal (≤8 sandbox runs/hypothesis, ≤3 hypotheses)
- [ ] Bisect: PyPI version list → run verified repro across ≤8 versions → last-good/first-bad
- [ ] Report: `repro.py` (runs standalone), `findings.md` (hypothesis, citations, bisect table, optional fix sketch), full session trace

**Surfaces**
- [ ] CLI: `reproducer run <issue-url>` (+ `--replay`, `--post`)
- [ ] Dashboard: ONE run-viewer page — runs list, per-run tool-call trace, artifacts
- [ ] GitHub Action: label-triggered (`needs-repro`), posts report comment, demoed on author's own repo
- [ ] `docker-compose.yml` bringing up service + dashboard
- [ ] CI workflow (`.github/workflows/ci.yml`): typecheck + unit tests on every PR — a PR merges only when all its checks pass

**Platform & safety**
- [ ] Symptom gate: deterministic matcher (exception class, ≥N stack frames, wrong-output rules, hang timeout)
- [ ] Sanitizer boundary before every LLM prompt (issue text + all TinyFish results)
- [ ] Sandbox dual-mode: local venv (dev) + docker (compose/VPS), no keys ever in sandbox env
- [ ] Replay mode: bundled fixtures, zero GitHub/TinyFish keys required
- [ ] Job queue + SQLite run ledger (runs, events, artifacts, symptom specs)
- [ ] Three pre-verified demo issue fixtures + one own-repo Action demo
- [ ] Deliverables: MIT LICENSE, README (≤10-step setup, architecture diagram, gate explanation, v1 scope, security), ≤3-min video, Nebius/NVIDIA feedback section, persistent demo deployment

### Out of Scope (v1 — stated loudly in README)

- [ ] Multi-ecosystem support (JS/Go/Rust) — Python/PyPI only
- [ ] Native/C-extension dependencies — pure-Python wheels/sdists only
- [ ] Auto-writing the actual library fix (a *sketch* in findings.md is fine)
- [ ] GUI apps, hardware, networked-service bugs
- [ ] Parallel issue batching, team features, SSO
- [ ] Posting to any repo outside the allowlist

### Operator checklist (never backlog issues — the build agent cannot do these)

- [ ] Provide API keys in `.env` (`NEBIUS_BASE_URL`, `NEBIUS_API_KEY`, `MODEL_FAST`, `MODEL_REASON`, `TINYFISH_API_KEY`, `GITHUB_TOKEN`) — product runtime only; CI and acceptance scenarios must never need them
- [ ] Demo-issue research: shortlist ≥5 candidates, verify repro + bisect boundary locally, user approves 3; bundle as fixtures
- [ ] Seed the own-repo demo issue for the GitHub Action path
- [ ] VPS demo deployment on techa.pro (free, live until Dec 15, 2026)
- [ ] ≤3-min YouTube demo video; Devpost draft saved early; submission before Oct 30, 6:00pm WAT
- [ ] VPS-side build snapshot: `foreman bake reproducer` before the first lap — the snapshot must contain Node 22, Python 3 with pip + venv, and git

## 5. User Stories

1. **As a maintainer**, I want to label an issue `needs-repro` on my repo, **so that** I get a comment with a verified minimal repro and the exact regression boundary without leaving GitHub.
   *Example:* label `needs-repro` on `techafreshh/reproducer#7` → Action runs the CLI → comment appears with findings.md rendered + link to the dashboard trace.
2. **As a developer**, I want to run `reproducer run <issue-url>` locally, **so that** I can confirm a bug is real before reporting it upstream.
   *Example:* `reproducer run https://github.com/x/lib/issues/123` → prints progress phases → writes `artifacts/run-42/repro.py` + `findings.md`; `python repro.py` exits nonzero with the reported traceback on the bad version.
3. **As a judge**, I want to run the demo with no API keys, **so that** I can verify the project works without signing up for anything.
   *Example:* `docker compose up` + `reproducer run --replay fixtures/demo-1` → full pipeline over cached fixtures → report and dashboard trace identical to the recorded run.
4. **As a reviewer**, I want to see the full tool-call trace for a run, **so that** I can audit how the agent reached its conclusion.
   *Example:* dashboard run detail shows every `env_run` command, stdout/stderr, gate verdict, and hypothesis revisions in order.
5. **As a security reviewer**, I want untrusted text sanitized before it reaches any LLM prompt, **so that** a malicious issue or web page cannot hijack the agent.
   *Example:* an issue containing zero-width-injected "ignore previous instructions" is stripped, flagged in the trace, and wrapped in a delimited data block.
6. **As the operator**, I want posting disabled by default with an allowlist, **so that** the agent can never comment on a stranger's repo.
   *Example:* a run without `--post` produces artifacts only; `--post` to a non-allowlisted repo is refused at the CLI.
7. **As the operator**, I want budget latches (≤8 sandbox runs/hypothesis, ≤3 hypotheses, wall-clock + token caps), **so that** a runaway investigation can't burn tokens or hosts.
   *Example:* budget exhaustion → status `inconclusive`, best evidence attached, run marked honestly in ledger and dashboard.

**Technical stories**
8. **As the system**, I grade every sandbox run against the frozen symptom spec deterministically, **so that** no LLM call ever decides whether a bug reproduced.
9. **As the system**, I distinguish `inconclusive` (trigger never reached, e.g. unrelated import failure) from `not-reproduced`, **so that** the agent repairs its environment rather than abandoning a correct hypothesis.

## 6. Core Architecture & Patterns

One TypeScript service (Node ≥22.19), three surfaces, one brain.

| Component | Responsibility |
|---|---|
| **orchestrator** | CLI entry, in-process job queue, SQLite run ledger, budget/latch enforcement, spawns agent sessions |
| **agent runtime** | Pi SDK in-process: triage session (MODEL_FAST, structured output) + investigation session (MODEL_REASON, 7-tool surface) |
| **symptom gate** | Deterministic matcher grading every `env_run`; frozen before investigation begins |
| **dashboard** | Single run-viewer page (Hono + zero-build vanilla JS) |
| **GitHub Action** | Composite action running the CLI with secrets on `needs-repro` label |

### Directory structure

```
reproducer/
  package.json tsconfig.json .env.example .gitignore LICENSE(MIT) README.md
  docker-compose.yml Dockerfile
  src/
    cli.ts                    # reproducer run <url> [--replay] [--post]
    orchestrator/             # queue.ts, ledger.ts, budgets.ts
    llm/                      # provider factory: live (Token Factory) | scripted driver
    agent/tools/              # github_get_issue, tinyfish_search, tinyfish_fetch,
                              # env_create, env_run, bisect, submit_report
    gate/                     # spec schema, freeze/latch, traceback parser, verdicts
    sandbox/                  # env handles: local.ts + docker.ts, pypi.ts
    sanitize/                 # patterns.ts (ported), sanitizer.ts
    report/                   # findings.ts, repro template
    replay/                   # fixture loading, tool shims
    dashboard/                # server.ts, public/
    action/                   # GitHub Action composite
  fixtures/demo-{1,2,3}/      # issue JSON, cached TinyFish per query, cached verdicts
  scripts/smoke/              # token-factory.mts, tinyfish.mts, sandbox.mts
```

### Key patterns & decisions

1. **Driver duality:** a run is driven by the live LLM *or* by a **scripted plan** (ordered tool calls with canned outputs per demo issue). Orchestrator, gate, ledger, report, and dashboard are identical code paths in both modes. This unblocks development before API keys exist and *is* the judges' keyless replay mode.
2. **Frozen verifier:** symptom spec persisted + latched at triage end; tool layer refuses writes to it after freeze (defense in depth: DB check too).
3. **Deterministic gate:** verdicts `reproduced` / `not-reproduced` / `inconclusive` computed by pure code; the agent sees only verdicts, never gate internals.
4. **Dual-mode sandbox:** local mode (fresh `python3 -m venv`, pinned installs, subprocess + hard timeout + `ulimit` rlimits, proxy-env best-effort network allowlist) since Docker is unavailable in this WSL distro; docker mode (`docker run --rm --network none --memory --cpus --pids-limit` for runs; networked step only for installs) in compose/VPS.
5. **Event-sourced ledger:** every tool call, gate verdict, and LLM turn lands in SQLite via `agent.subscribe()` events → dashboard timeline is a pure read.
6. **Sanitizer boundary:** ported pattern lists (see §9) applied to issue text and every TinyFish result before context entry; untrusted content wrapped in delimited data blocks; flags surfaced as system-side notes.
7. **Integration seams (build-order contract):** the dashboard starts via the package.json `start` script (`npm start`), listens on `process.env.PORT` (default 8080), and serves `GET /healthz` → `200 {"ok":true}`. The **first backlog issue is the walking skeleton**: CLI skeleton (`reproducer run` parses the issue URL and creates a ledger run) + SQLite ledger + dashboard serving `/healthz`. Every external boundary (LLM, GitHub REST, TinyFish) sits behind an interface with a scripted/replay driver — CI and acceptance scenarios never need API keys; live drivers activate only when the operator supplies keys.
8. **Toolchain contract:** any environment that builds/tests the product (compose `worker` image, CI runner, build snapshot) must include Node 22, Python 3 with pip + venv, and git — the sandbox creates Python venvs in-process.

## 7. Tools/Features

### Investigation-session tool surface (Pi SDK, TypeBox schemas)

| Tool | Purpose | Write scope |
|---|---|---|
| `github_get_issue` | Ingest issue body/comments via public REST | read-only |
| `tinyfish_search` / `tinyfish_fetch` | Research: error strings, changelogs, related reports | read-only |
| `env_create(spec)` | Fresh venv, pinned installs (`pip install lib==X.Y.Z`), returns env handle | sandbox only |
| `env_run(cmd)` | Execute with hard timeout; stdout/stderr/exit/traceback → symptom gate grades it | sandbox only |
| `bisect(versions[])` | Version-matrix runner over the verified repro | sandbox only |
| `submit_report(...)` | Ends the session at the gate; emits final artifacts | nothing itself |

The agent decides what to try; the frozen symptom spec decides what counts as reproduced. **No LLM call grades reproduction.**

### Feature specifications

- **Triage (MODEL_FAST):** one structured-output call → symptom spec JSON validated against a TypeBox schema; research query generation; then freeze. Structured output via `openai` SDK direct call with `response_format: json_schema` (Token Factory supports it); Pi SDK for the session loop.
- **Symptom gate:** per-`env_run` grading — (a) exception class: last traceback's exception type matches the spec; (b) frames: ≥N (default 2) module+function signatures match the issue's traceback; (c) wrong-output: expected-vs-actual rules derived from the issue; (d) hang: timeout-threshold detection. `inconclusive` = trigger never reached (e.g. unrelated import failure) → agent repairs the env, not the logic.
- **Repro loop:** iterate — write/run/shrink — with per-hypothesis budget; best minimal repro is promoted to the artifact.
- **Bisect:** PyPI `/pypi/<pkg>/json` `releases` enumerates versions (deprecated key — PEP 691 index-API fallback ready); pure-Python filter parses wheel tags (`py3-none-any`, `py2.py3-none-any`, sdist); ≤8 versions spanning reported→latest.
- **Report:** `repro.py` runs standalone (no Reproducer runtime); `findings.md` = hypothesis, per-branch research verdict with citation URLs, bisect table, optional workaround/fix sketch, honest env-difference statement (Linux container vs reported environment).
- **Dashboard:** runs list (status, verdict, budget burn) → run detail: tool-call timeline, gate verdicts per `env_run`, artifact viewer.
- **Replay mode:** fixtures per demo issue — cached issue JSON, cached TinyFish responses keyed by query hash, cached verdicts/traces; tool layer swaps to fixtures when `--replay`; LLM live only if keys present (trace regeneration).

## 8. Technology Stack

| Layer | Choice | Notes |
|---|---|---|
| Runtime | Node ≥22.19 (host: Node 24.18) | Dockerfile pins `node:22` |
| Language | TypeScript, ESM, strict `tsc` | |
| Package manager / dev runner | **bun 1.4.3** | production runs via tsx / compiled dist |
| Agent runtime | **`@earendil-works/pi-agent-core` 1.4** | `@mariozechner/pi-agent-core` is its deprecated alias; same code |
| LLM abstraction | **`@earendil-works/pi-ai` 1.4** | `createProvider({ baseUrl, api: openAICompletionsApi(), auth: envApiKeyAuth("NEBIUS_API_KEY") })`; TypeBox tool schemas; `agent.subscribe()` for trace |
| Structured output | `openai` SDK (base_url override) → Token Factory `response_format: json_schema` | tool calling also confirmed supported |
| Models (env) | `MODEL_FAST` (Nemotron Nano/Super, e.g. `nvidia/nemotron-3-super-120b-a12b`) · `MODEL_REASON` (Nemotron Ultra, e.g. `nvidia/Llama-3_1-Nemotron-Ultra-253B-v1`) | exact slugs verified against `/v1/models` when keys land |
| Ledger | better-sqlite3 | runs / events / artifacts / symptom_specs |
| Dashboard | Hono + zero-build vanilla JS | no frontend build step before a deadline |
| Research | TinyFish (`GET /search` + `X-API-Key`, `POST /fetch {urls, format: \"markdown\"}`) | free tier 12,000 search req/day + 1,000 fetch URLs/day — cache into fixtures |
| Versions | PyPI JSON API (`/pypi/<pkg>/json`) | free, no key |
| Tests | vitest | gate, sanitizer, traceback parser heavily unit-tested |
| Sandbox | Python 3.14 host venvs (local mode) · dockerized python:3.12 (docker mode) | fixture libs must be 3.14-compatible |

## 9. Security & Configuration

**Sanitizer boundary (before every LLM prompt).** Issue text and TinyFish results are untrusted. Port pattern lists from the author's prior art (no `sanitize.py`/`posting_guard.py` exists on this machine; sources verified):
- `~/projects/belt/url-extractor/inference.py` — `INVISIBLE_CHARS` (ZWSP, ZWNJ, ZWJ, LRM/RLM, word joiner, BOM, soft hyphen, Mongolian vowel separator, Arabic letter mark) and `_CONFUSABLES` homoglyph maps (Cyrillic, Greek, Roman numerals, dash/space lookalikes, digit lookalikes)
- `~/projects/belt/html-entity-codec/inference.py` — extended invisible codepoint set (0x00AD, 0x061C, 0x115F/0x1160, 0x180E, 0x200B–0x200F, 0x2028–0x202E, 0x2060–0x206F, 0x3164, 0xFEFF, 0xFFA0)
- Add per brief: **Unicode-tag block U+E0000–E007F** and variation selectors; instruction-shaped-line flags ("ignore previous", "system prompt", …).

Handling: strip invisibles, normalize confusables, flag homoglyph runs and instruction-shaped lines, wrap untrusted content in clearly-delimited data blocks, surface flags as system-side notes, record findings in the trace.

**Sandbox isolation.** Hard timeout + resource caps per `env_run`; network allowlist (PyPI + target library endpoints only — proxy-env best-effort in local mode, `--network none` during runs in docker mode); **the sandbox never sees API keys**; target libs restricted to pure-Python wheels/sdists.

**Secrets & posting.**
- `NEBIUS_API_KEY`, `TINYFISH_API_KEY`, `GITHUB_TOKEN` in `.env` only — never logged (redaction filter in logger), never committed (`.gitignore` from scaffold).
- Default: **nothing is posted anywhere**. Posting requires explicit `--post` **and** a repo allowlist in config.

**Configuration (`.env`)**

```
NEBIUS_BASE_URL=https://api.tokenfactory.nebius.com/v1
NEBIUS_API_KEY=...
MODEL_FAST=<nemotron nano-or-super slug>
MODEL_REASON=<nemotron ultra slug>
TINYFISH_API_KEY=...      # free tier, search 12k req/day + fetch 1k URLs/day
GITHUB_TOKEN=...          # optional; raises REST rate limits
REPLAY=0|1                # fixture mode toggle (also --replay)
```

**Security out of scope:** OS-level sandbox escape hardening beyond caps/timeout, secrets-in-logs forensics, multi-tenant isolation.

## 10. API Specification

**CLI**

```
reproducer run <issue-url> [--replay] [--post] [--config path]
reproducer serve [--port 8080]        # dashboard
```

**Dashboard HTTP (Hono)**

| Endpoint | Response |
|---|---|
| `GET /api/runs` | `[{id, issue_url, status, verdict, created_at, budget}]` |
| `GET /api/runs/:id` | run record + symptom spec (frozen) + summary |
| `GET /api/runs/:id/events` | ordered tool-call/LLM/gate events (trace) |
| `GET /api/runs/:id/artifacts/:name` | `repro.py`, `findings.md` |
| `GET /healthz` | `{ok:true}` |

Status-code contract (pinned, enforced by the acceptance gate): unknown routes → `404`; unknown run id under `/api/runs/:id` → `404`; malformed request bodies (bad JSON) → `400` — never `5xx`.

**GitHub Action** (composite, Node 22, on `issues.labeled` → `needs-repro`)

```yaml
inputs: issue-url, post-comment (default true)
secrets: NEBIUS_API_KEY, TINYFISH_API_KEY, GITHUB_TOKEN
behavior: install CLI → run against the labeled issue → post comment with findings.md + trace link
```

**LLM provider (pi-ai)**

```ts
createProvider({
  id: "nebius", baseUrl: env.NEBIUS_BASE_URL,
  api: openAICompletionsApi(),
  auth: envApiKeyAuth("Nebius", ["NEBIUS_API_KEY"]),
  models: [/* MODEL_FAST, MODEL_REASON entries */],
});
```

**Symptom spec (frozen JSON, abridged)**

```json
{ "library": "lib", "versions": ["2.2.0"], "symptomClass": "exception|wrong-output|hang",
  "errorStrings": ["...verbatim..."], "frames": [{"module":"...","function":"..."}],
  "trigger": "...", "expectedOutput": {...}|null, "minMatchingFrames": 2 }
```

## 11. Success Criteria

**MVP success = all of:**
- [ ] End-to-end on all three demo issues: issue URL in → verified minimal repro out → bisect table matches the known regression boundary → report generated and trace renders
- [ ] Replay mode runs the full demo with no live GitHub/TinyFish keys (LLM only for optional trace regeneration; fixtures include cached verdicts)
- [ ] `docker compose up` brings up service + dashboard
- [ ] CLI, GitHub Action (on owned repo), and dashboard all demonstrably work
- [ ] README: setup ≤10 steps, architecture diagram, symptom-gate explanation, v1 scope, security section
- [ ] MIT LICENSE at repo root, auto-detected in the About section; no secrets committed
- [ ] ≤3-min public YouTube demo video, no copyrighted music/trademarks, shows the project running
- [ ] Feedback section on Nebius/NVIDIA tools written (Most Valuable Feedback prize: completeness, viability, impact)
- [ ] Demo deployed and free until Dec 15, 2026

**Quality indicators:** gate has zero LLM calls in its path; every reproduction claim traces to a stored verdict + runnable artifact; `inconclusive` never reported as `reproduced`; sanitizer unit tests cover all ported pattern classes.

## 12. Implementation Phases

**Phase 1 — Foundation (Day 1, Oct 26)**
Goal: scaffold + unblocked-by-keys development path.
- [ ] git init, MIT LICENSE, `.env.example`, `.gitignore`, scaffold; create `techafreshh/reproducer` + first push
- [ ] Orchestrator skeleton: CLI, in-process queue, better-sqlite3 ledger
- [ ] LLM provider factory with scripted driver (live Token Factory driver behind the same interface)
- [ ] Triage session → validated symptom spec + freeze/latch; unit tests
- [ ] Sanitizer v1 with ported pattern lists; unit tests
- [ ] Demo-issue shortlist (≥5 candidates) begun; smoke scripts written (run when keys land)
Validation: `bun test` green; CLI skeleton runs a scripted demo run end-to-end in memory; repo pushed.

**Phase 2 — Reproduction engine (Day 2, Oct 27)**
Goal: the loop that turns hypotheses into gate-graded evidence.
- [ ] Sandbox local mode hardened (timeout, ulimits, no-keys env, proxy allowlist) + docker mode implementation
- [ ] Symptom gate + Python traceback parser (unit tests)
- [ ] Investigation session with full 7-tool surface; budget latches
- [ ] Repro loop end-to-end on demo issue #1
Validation: scripted-driver run produces a gate-graded `reproduced` verdict + minimal repro on issue #1 without any API key.

**Phase 3 — Delivery surfaces (Day 3, Oct 28)**
Goal: everything a user or judge touches.
- [ ] Bisect runner + pure-Python filter
- [ ] Report generator (`repro.py` standalone + `findings.md` with citations, bisect table, fix sketch)
- [ ] GitHub Action + `--post` path (own repo, seeded issue)
- [ ] Dashboard run-viewer with trace + artifacts
- [ ] Dockerfile + docker-compose.yml
Validation: labeled issue on own repo → comment posted; dashboard renders a full trace; compose config valid.

**Phase 4 — Demo & ship (Day 4, Oct 29)**
Goal: submission-grade polish.
- [ ] Demo issues #2 and #3 green; fixtures finalized (you approve the three)
- [ ] Replay mode + fixture loading
- [ ] README, video script + recording support, Nebius/NVIDIA feedback section
- [ ] Persistent deployment on techa.pro VPS (live until Dec 15)
Validation: keyless replay passes all three fixtures; README walkthrough followed fresh succeeds.

**Phase 5 — Buffer & submit (Day 5, Oct 30)**
- [ ] Fix fallout; Devpost draft saved early; acceptance-checklist QA; submit before 6:00pm WAT

## 13. Future Considerations

- Multi-ecosystem support (Node/Go/Rust sandboxes)
- Native-dependency debugging (C toolchains, per-version ABI handling)
- Auto-fix: PR a patch sketch to the library repo (opt-in)
- Batch triage of a repo's open issues; hosted multi-tenant service
- Deeper gate: property-based symptom checks, statistical flakiness detection
- Cross-issue pattern mining ("same signature appeared in #12, #45")

## 14. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Nemotron tool-calling reliability via pi-ai unverified (no keys yet) | Could force an agent-loop rework mid-week | Mock-first architecture keeps all other work unblocked; on key arrival, smoke test decides pi-agent-core loop vs direct-openai-SDK loop within the hour |
| No Docker in this WSL distro | Docker-mode sandbox & compose untestable locally | Local mode is the dev default; verify docker mode + compose on the VPS (or enable Docker Desktop WSL integration) |
| Python 3.14 host vs fixture libs | Some libs may lag 3.14 support | 3.14 compatibility is an explicit demo-issue selection criterion; symptom spec carries optional python version |
| Demo issues turn out nondeterministic | Bisect table contradicts reality | Shortlist ≥5, verify repro + boundary locally before user approval; swap freely before Day 4 |
| TinyFish free tier (12k search req/day, 1k fetch URLs/day) | Live runs during demo could exhaust the allowance | Fixture caching, capped client-side results, replay mode as the public-facing path |
| PyPI `releases` key deprecated | Version enumeration breaks someday | Working today; PEP 691 index-API fallback behind the same client |

## 15. Appendix

**Keys needed (`.env`)** — see §9. **Demo deployment:** techa.pro VPS, free & online until Dec 15, 2026.

**Key references**
- Pi SDK: https://github.com/earendil-works/pi (`packages/agent`, `packages/ai`)
- Nebius Token Factory: https://docs.tokenfactory.nebius.com (quickstart, JSON mode, function calling)
- TinyFish Search API: https://docs.tinyfish.ai/search-api/reference
- TinyFish Fetch API: https://docs.tinyfish.ai/fetch-api/reference
- PyPI JSON API: https://docs.pypi.org/api/json/
- Sanitizer pattern sources: `~/projects/belt/url-extractor/inference.py`, `~/projects/belt/html-entity-codec/inference.py`

**Compliance anchors (from official rules):** track = Coding and Agentic Engineering; demo live & free through the Judging Period (Dec 15, 2026); repo fully self-contained incl. fixtures + replay; video <3 min, public, no copyrighted music/trademarks; submission freezes at the deadline — save the Devpost draft early.
