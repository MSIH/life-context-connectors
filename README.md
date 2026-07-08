# life-context-connectors

Official connectors for [**LifeContext**](https://github.com/msih/life-context) — the local, self-owned AI memory server. Each connector is an isolated process that gathers data from one corner of a digital life and submits it to LifeContext over the versioned `POST /api/v1/ingest` contract. Nothing here imports or depends on LifeContext's source; the HTTP contract is the only coupling point.

## Why one repo for all connectors

The contract (`docs/04-connector-contract.md` §10, mirrored here) calls for each connector to be independently forkable, but while there's a single maintainer building the first reference connectors, splitting into N repos is pure overhead — repo creation, permissions, and per-session scoping with no payoff yet. So: **one monorepo, one folder per connector**, sharing scaffolding (HTTP client + spool-file patterns) and one place to clone. Any connector splits out into its own standalone repo the moment it needs an independent release cadence or an external contributor wants to own just that one — that's the trigger, not a timeline.

## Structure

```
devsession-claude/  Claude Code SessionEnd/PreCompact hook → dev_session artifacts (Milestone 1)
imessage/            iMessage chat.db sync → message/photo artifacts (Milestone 3)
photo-exif/          Photo library EXIF scan + VLM captioning → photo artifacts (Milestone 4)
docs/                A copy of the connector contract (source of truth: msih/life-context)
```

More connectors land here the same way as later milestones come up (see the [roadmap](https://github.com/msih/life-context/blob/2.0/docs/05-roadmap.md)).

## Adding a connector

1. New top-level folder, named after the connector's `source` value (e.g. `imessage/`).
2. Own `package.json` (or equivalent for another language) — no shared dependencies assumed between connectors.
3. Own `README.md` with setup steps and, for push-style connectors, the trigger registration snippet.
4. Talk to LifeContext only via `POST {LIFECONTEXT_URL}/api/v1/ingest` (or `/ingest/batch`) per `docs/04-connector-contract.md`. Validate payloads against [`schemas/ingest.v1.json`](https://github.com/msih/life-context/blob/2.0/schemas/ingest.v1.json) in the source repo if you want CI-time checking without a live server.

## Tracking

Milestones are tracked in the core repo: [msih/life-context issue #28](https://github.com/msih/life-context/issues/28) (Milestone 1 — devsession-claude, in progress). File connector-specific issues here, referencing that epic with `msih/life-context#28`.

## License

MIT (see `LICENSE`) — matches LifeContext's own license, but each connector folder is free to declare its own.
