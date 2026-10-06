---
description: Write the client test suite for a venue API. Fake the transport, encode the quirks, feed the lessons back.
---

Write tests for CLIENT against PLATFORM. The suite must pass offline, prove
the wire contract, and stay leak-gate clean.

## Principles

1. **Test through the public methods.** Inject the transport (`fetchImpl`).
   Never mock client internals. If the client cannot accept an injected
   transport, that is the first finding — fix the client first.
2. **The fake is a router, not a per-test mock.** One `fake<Platform>()`
   factory that routes URLs and records every request (method, url,
   headers, body). Assertions read the request log: the wire contract is
   the thing under test. Share generic helpers (`test/transport-fake.ts`)
   across platforms.
3. **One describe per endpoint, one test per documented quirk.** The
   platform playbook's traps section IS the test list. Every trap becomes
   an `it(...)`.
4. **Encode session semantics in the fake, not the test.** If the API
   serves a card set only to a valid PoW token, the fake verifies the
   solution itself (re-deriving the key from the POSTED parameters) and
   401s everything else — the ordering bug then fails the test naturally.
5. **Synthetic fixtures only.** Invented ids, prices, codes; RFC 2606
   `example` hosts; a provenance comment saying so. No captured payloads.
   The synthetic PBKDF2 cost is 2 (live: 5000) so the REAL solver runs in
   milliseconds inside the suite.
6. **Assert the read-only boundary.** This client has no order path at
   all; the test surface is that `menu`/`health` never POST anything the
   widget would not send for a read.

## Steps

1. Read the platform notes (GastroNova: the private platform-recon repo's
   `research/gastronova/PLATFORM.md` — PoW spec, deltas, venue reports).
2. Build `test/gastronovi-fake.ts` with the quirks pre-installed.
3. Write `test/client.test.ts` wiring tests: challenge→solve→submit
   params, token + cookie propagation, mode gating, price precision, id
   spaces, stock locks, failure paths.
4. `npm test && npm run typecheck && npm run build && npm run gate` — all
   green.
5. **Learn:** every quirk you had to encode that is NOT in the platform
   notes gets added there AND to Lessons below. The tests and the playbook
   converge; that loop is the point.

## Scale to a new platform

- Copy the fake's shape, not its routes. Endpoints come from the platform
  notes of the new platform.
- Reuse `test/transport-fake.ts` helpers (headerRecord, bodyOf,
  jsonResponse, sent) — do not rewrite them per platform.
- Keep one fake per platform; a fake that grows conditionals for two
  platforms is two fakes.

## Lessons (append-only)

- Challenge success is NOT liveness: a deactivated unit still issues and
  accepts the full PoW and only login-walls downstream reads. The fake
  must happily hand dead units a token — that asymmetry is the test.
- The liveness check is the cheap cookieless `POST /reservations/
  information`; encode "health makes no /guestsession request at all".
- The submit body is jQuery-nested form params (`challenge[parameters]
  [field]`, `solution[counter]`, …) plus a `solveduration` query — a
  JSON body would be accepted by no server here; assert the literal
  urlencoded shape off the request log.
- The ALTCHA variant has no `maxNumber`: the server pre-picks a SMALL
  counter, so the solver is a linear scan from 0 and the keyPrefix is
  not a brute-force target. Synthetic challenges keep that property
  (counter 7) with a tiny cost.
- Guest-token lifetime is 10–15 min: the fake's token registry and the
  client's token window are separate clocks — test both the quiet reuse
  (one challenge across reads) and the mid-read 401 rescue (two).
- A valid-but-EMPTY inhouse read is mode gating, not death (empty
  inhouse vs full pickup on the same unit, same minute) — null and an
  empty Menu are different contracts and both need tests.
- Price precision is unit-dependent: 10-decimal and 2-decimal strings
  ride in ONE response; parse numerically, never slice.
- Three id spaces per item — Recipe-map key `uid`, global `id`,
  `MenusectionContent.id` — and ids are JSON strings everywhere; the
  fixture must make all three differ or joins silently lie.
- Same title ≠ same product (glass vs bottle): dedupe-by-title is a
  data-loss trap; the fixture carries a same-title pair.
- Sections nest recursively and subsections may omit `recipe_count` —
  only an EXPLICIT zero filters. Treating missing as 0 drops whole
  card subtrees (found against the capture shape, not the docs).
- `RecipeStock` is a locked_until timestamp map (null = available, past
  = released), and its rows cover recipes the card never shows — stock
  rows are not a menu census; unmatched rows must gate nothing.
- Invalid /code inputs re-render the login form as HTML with a 200 —
  a non-JSON 2xx body is a "platform answered: invalid" outcome, not a
  transport failure; the http layer needs a third `parse` failure kind.
- 429s carry a server-tracked retry budget (the widget backs off 5–10 s
  ×3); the client does one polite retry and the fake counts the calls.
- `parseFloat` is not a price parser: it reads `"6,90"` as 6 and returns
  6 for garbage with a numeric prefix — silently wrong is worse than
  NaN. The boundary must strict-match the documented wire format
  (digits, optional dot, digits) and throw naming the record on drift;
  a NaN-check alone passes the comma test and ships the bug.
- Solver exhaustion and refused submits are typed failures ("pow"), not
  bare Errors — callers discriminate protocol drift from transport
  death. The fake needs an unsolvable-keyPrefix mode and a
  reject-first-N-submits mode, and the client needs a pluggable
  scanBound or the exhaustion lane takes minutes to test.
- Parity work: strict decimal-string parsing isn't enough for
  cross-platform identity — product+size+container keys are (the
  parity engine in platform-recon scripts/parity.ts encodes this
  package's unitless amounts like "0,33 Bottle"); same-title items
  differ across POS/aggregator by size and container, never match by
  title alone.
- Reuse survey before any sibling package: grep.app the exact
  hostnames (zero hits = greenfield, hits = existing integrations to
  verify and build on — see the wolt client's OSS-derived endpoints).
