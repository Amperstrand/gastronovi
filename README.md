# gastronovi

Read-only client for [GastroNova](https://services.gastronovi.com)
self-ordering. Venue and menu reads sit behind an ALTCHA PBKDF2
proof-of-work guest gate — the solver is a linear counter scan
(PBKDF2-HMAC-SHA256 over `nonce‖uint32_be(counter)`, hex-prefix match),
offline math, no browser.

Read-only by design: **no accounts, no orders, no payments**. There is no
order command in this package on purpose; this platform's payment boundary
is a hosted checkout a human opens. Worked examples: BRLO BRWHOUSE (unit
7960) and BRLO Charlottenburg (unit 96153), Berlin.

```sh
npm install github:Amperstrand/gastronovi
```

```ts
import { GastronoviClient } from "gastronovi";

const client = new GastronoviClient();
const unit = await client.unit("7960");          // code, URL, or id → health
const menu = await client.menu(unit!.id, "pickup"); // solves the PoW once
```

CLI (Node 22+):

```sh
npx gastronovi health 7960
npx gastronovi menu 7960                    # pickup is the default mode
npx gastronovi menu 96153 --mode inhouse
```

## Error semantics

A thrown `GastronoviError` (reason `"network"`) means the platform was
unreachable. A `null` return always means the platform answered and the
thing is absent — invalid code, or a deactivated unit behind the login
wall. An **empty** menu is data, not absence: `inhouse` without a table
code is mode-gated (unit 96153 serves an empty inhouse card and a full
pickup card at the same minute), and `menu.gated` flags exactly that.

## What the client encodes

- ALTCHA PBKDF2 variant: challenge → linear scan → jQuery-nested submit
  (`challenge[parameters][…]`, `solution[counter|derivedKey|time]`,
  `?solveduration=`), token via JSON or `__Host-csrf_token` cookie.
- One PoW per ~10-minute token window; exactly one mid-read rescue
  (401 / GuestSession envelope) before giving up.
- Challenge success ≠ liveness: `health` is the cookieless
  `POST /reservations/information` read and never solves anything.
- Mode gating, mixed 10/2-decimal price strings (parsed numerically),
  the uid/id/content-id triple, same-title-different-product cards,
  explicit-`recipe_count`-0 filtering, `RecipeStock` timestamp locks
  (not a menu census), the `/code/<x>?format=json` resolver with its
  HTML login-form re-render on invalid codes, one 429 backoff retry.
- The PoW solver (`src/pow.ts`) is pure with an injectable hash —
  tests run the real scan against synthetic cost-2 challenges.

## Verification (live, 2026-10-03)

- **unit 7960 (BRLO BRWHOUSE)** — `menu(7960, "inhouse")`: PoW solved
  (10.9 s end-to-end incl. reads), token granted, full house card set:
  32 cards / 225 items (Chicken & Beer Sunday FOOD, Fassbiere, …
  Ordermonkey Container Bar), 80 stock rows, EUR 2-decimal prices
  (BRLO Helles €5.80-class card), minOrderValue 25.
- **unit 96153 (BRLO Charlottenburg)** — `menu(96153, "pickup")`: PoW
  solved (14.7 s end-to-end), "Späti" tree: 15 cards / 160 items
  (Growler, Flaschenbier/Bottles, Merch → Hoodies/T-Shirts/Socks …),
  150 stock rows. Prices served uniformly 2-decimal at verify time; the
  mixed 10/2-decimal string quirk is capture-documented and test-covered.
- **bonus** — `menu(96153, "inhouse")` 1.4 s later reused the same guest
  token (no second PoW — one-time-PoW-per-window confirmed live) and
  returned a FULL card set (25 cards, incl. "Happy hour"): the inhouse
  gate is hours-dependent — empty during the recon read earlier the same
  day, full at verify time. An empty inhouse read stays a gating signal,
  never a death signal.
- **resolver + dead unit (2026-10-04)** — the documented dead sale-code
  for unit 248 resolves via `/code/<x>?format=json` to `unit 248,
  live:false`; its homoglyph variant returns null (invalid-code HTML
  re-render); `menu(248, "pickup")` solves the full PoW (13.4 s, token
  granted) and then login-walls to **null** — challenge-success-≠-
  liveness verified against reality. Consumer install from the npm
  tarball (`gastronovi health` / `menu` through the `.bin` symlink)
  live-checked the same day.

## Repo rules

Public repo — never commit card numbers, HAR/pcap/log files, cookies,
session dumps, or captured payloads; fakes are synthetic with provenance
comments. Commit via `sh scripts/git-commit.sh`; CI runs the leak scan
plus typecheck, build, and the offline test suite. Test-writing thinking
and the quirk→lesson log live in [prompts/write-tests.md](prompts/write-tests.md).

Platform spec: private platform-recon repo, `research/gastronova/PLATFORM.md`.
