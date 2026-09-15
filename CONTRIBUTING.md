# Contributing

## Running it

    npm install
    npm start          # http://127.0.0.1:8123/

Node 22 or newer, and a Claude Code login on the machine (`claude` once,
logged in). The quick start in the [README](README.md) covers the rest.

## Before you open a pull request

    npm run check          # typecheck + 546 unit tests, no network, seconds
    npm run test:browser   # the real client in Chromium against a fixture server
    npm run test:chromium  # the server browser, driving a real Chromium

The browser suite needs Python with `pytest`, `pytest-xdist` and `playwright`
(`python -m playwright install chromium`). Both run in CI.

`npm run test:real` drives the actual Claude Code SDK and costs real money
(about $0.30 a run). It is opt-in and never runs in CI; use it when you touch
how the session talks to the SDK.

## What the code expects of you

- **Say why, not what.** The comments here explain decisions and the traps
  behind them, usually with the measurement that settled it. A comment that
  restates the code is noise; one that records what went wrong the first time
  is the reason this codebase is maintainable.
- **Measure before you claim.** "Faster", "safer" and "fixed" want a number or
  a test, in the pull request and, when it is a trap someone will hit again, in
  the file.
- **A bug fix comes with the test that fails without it.** Several tests here
  name the incident they come from.
- **Keep the three clients one client.** `extension/sidepanel.js` is the web
  UI, the side panel and the phone page; host differences live in the
  `PLATFORM` shim, never in a branch on the user agent.
- **Schema and protocol changes go in `src/protocol.ts`**, which both sides
  import, so the server and the clients cannot drift.

## Layout

[ARCHITECTURE.md](ARCHITECTURE.md) is the module map, and the README's
[table of contents](README.md#where-to-read-what) says which document covers
what. [docs/development.md](docs/development.md) is the one for this file's
readers: how the pieces fit, how it is tested, and the CSS traps this UI has
already fallen into. The design notes under `docs/` record why a feature is
shaped the way it is.
