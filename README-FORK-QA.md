# pi-telegram — xqicxx QA-hardened fork

This repository is a working fork of [`@llblab/pi-telegram`](https://pi.dev/packages/@llblab/pi-telegram)
(v0.42.2 upstream baseline) with the unreleased **0.42.3-pre** feature set plus a full
QA pass (review, reproduction, bug fixes, regression tests).

## What's here

| Path | Contents |
|------|----------|
| `./` | Fixed 0.42.3-pre source (package, extensions, skills, docs) |
| `tests/` | Full test suite, updated for 0.42.3-pre + new regression tests |
| `QA/LOG.md` | Iteration journal (all rounds, decisions, test results) |
| `QA/BUGS.md` | Bug tracker (severity, status, root cause, fix) |
| `QA/patches/` | Patch files: upstream 0.42.2 → this tree |
| `extensions/pi-telegram-working/` | Companion "working card" extension (whimsical-style activity projection) |

## 0.42.3-pre feature set (from upstream work-in-progress)

- Probe Resilience (follower-registration visibility probe deadline)
- Provision Self-Healing (pending-provision TTL + reconciler cleanup)
- New-Thread Instances (leader spawns a visible `pi --mode rpc` follower per fresh thread)
- Pinned Working Views (`pin: true` on delivery / activity send)
- Robust Reasoning HTML (balanced thinking HTML)
- Throttle-Safe Working Ticker

## QA hardening added in this pass

See `QA/BUGS.md` for full details. Highlights:

- **B4 (critical)** — ambiguous (lost-response) topic provisions are no longer treated as
  stale by the TTL/leader-epoch self-healing, so a successor can no longer re-create a
  forum topic whose creation outcome was unknown (duplicate-topic window closed).
- **B1/B2** — background-instance spawner no longer leaks exited children into the
  concurrency cap or the per-thread dedup; a respawn cooldown prevents crash loops.
- **B10** — the Telegram API transport hard-deadline and follower-provisioning timeout are
  no longer `unref`'d, so a stalled proxy/socket is actually bounded even when the process
  is idle (previously the deadline could silently never fire).
- **B7** — entrypoint stays a composition root (invariants test restored).
- **B9** — delivery `pinned` flag now reflects whether pinning actually occurred.

## Verify

```bash
npm install
npm run typecheck
npm test            # 1729 tests (one ~20s timeout test included)
```

## Install locally

```bash
pi install git:github.com/xqicxx/pi-telegram
# or copy lib/, api/, index.ts into ~/.pi/agent/npm/node_modules/@llblab/pi-telegram/
# and restart pi (the running process keeps its in-memory code until restart)
```
