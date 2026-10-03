# AGENTS.md — contributing to gastronovi

Read-only client for GastroNova self-ordering (`services.gastronovi.com`):
venue + menu reads behind the ALTCHA proof-of-work gate (spec in the private
platform-recon repo's `research/gastronova/PLATFORM.md`). Worked examples:
BRLO BRWHOUSE (unit 7960) and BRLO Charlottenburg (unit 96153), Berlin.

Rules:
- READ-ONLY: no accounts, no orders, no payments. The payment boundary is a
  hosted checkout a human opens (see mcp-cashu-exchange docs/PAYMENT.md).
- This repository is public. Never commit card numbers, HAR/pcap/log files,
  cookies, session dumps, captured payloads, or personal data. Fakes are
  synthetic. Commit via `sh scripts/git-commit.sh`; CI runs the leak scan.
- Tests are offline against a synthetic fake that encodes the platform
  quirks (PoW challenge shape, mode gating, price precision, uid-vs-id).
  Every quirk becomes a test + a Lesson line in the test prompt.
