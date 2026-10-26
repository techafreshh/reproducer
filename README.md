# Reproducer

**Turns bug reports into proof.**

Reproducer is an agent that takes a GitHub issue URL and returns evidence: it triages the report into a machine-checkable symptom spec, researches the error, forms falsifiable root-cause hypotheses, builds clean Python environments, writes and shrinks a minimal reproduction script, verifies the reported symptom through a deterministic gate, bisects the exact version where behavior changed, and publishes a citation-backed report.

> Under active development for the Nebius x NVIDIA Global AI Hackathon (Devpost) — Coding and Agentic Engineering track. Full product spec: [`.agents/PRDs/PRD.md`](.agents/PRDs/PRD.md).

## Status

Pre-alpha. Setup instructions, architecture docs, and the demo guide land with the first milestones — see the PRD for the current plan.
