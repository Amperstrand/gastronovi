# gastronovi

Read-only client for GastroNova self-ordering (`services.gastronovi.com`).
Menu reads behind the ALTCHA proof-of-work gate — the solver is
PBKDF2-HMAC-SHA256 over a small server counter (linear scan).

Read-only by design: no orders, no payment. Worked examples: BRLO BRWHOUSE
and BRLO Charlottenburg (Berlin).

```sh
npm install github:Amperstrand/gastronovi
```

Status: scaffold — client under construction (see AGENTS.md for rules).
