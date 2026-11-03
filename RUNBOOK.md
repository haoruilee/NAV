# Current daily maintenance (2026-11-03)

- Public app stays in the existing `nav-monitor` Docker container on loopback port 4000. Do not restart the shared Cloudflare Tunnel for maintenance.
- Host `nav-valuation-audit.timer` runs once daily at 09:30 UTC (17:30 Beijing), with up to 20 minutes jitter. `flock` prevents overlap.
- Claude Code uses project-scoped private `.claude/settings.local.json`, model `GLM-5.3:provider=内部算力-HG-GLM-5.3-1`. Global user settings are unchanged; never commit credentials.
- The CLI starts with a short direct prompt in a unique tmux session, in print mode. Only Read/Write/WebSearch/WebFetch tools are exposed. It cannot use shell tools. Exit without an outbox fails promptly instead of waiting 30 minutes.
- Inputs contain four news candidates and two compact historical records per configured company; repeated queries are collected once. Successful unchanged evidence is cached for seven days; changed evidence is eligible immediately. The daily timer still checks sources on cache hits without another model request.
- All eligible company pairs must receive exactly one decision. The harness checks IDs, schema, finite confidence, no future date, risk and ready state before applying updates.
- New numerical records require confidence >=0.85, a direct primary domain URL, an exact source quote naming the company and matching the USD amount, and a successful independent harness re-fetch. Unsupported records are rejected or skipped; existing figures remain unchanged. No update is required on a day without verified news.
- Data files are written atomically with per-run backups, only for affected funds. `lastUpdated` changes only when new data is inserted. Failed review and dry runs never refresh data or verification timestamps.
- Public `/api/agent-runs` and company source pages retain the compatible green `ready` status only after validation/apply completes. Lifecycle events state the actual decision and insertion counts; `outcome` distinguishes an update from no change/cache hits. Agent-proposed `ready` alone is never success.
- Coverage: configured portfolio companies in RVI/USVC; other listed funds without company configuration are explicitly recorded as unconfigured, never fabricated.
- All code tests run on the designated builder `li@www.xzhtai.cn:2077` using synthetic fixtures, no production data or credentials. This host-script change needs no frontend or Docker build.

Rollback: disable only the NAV audit timer, restore previous host scripts and service unit from the private task backup, daemon-reload and re-enable the timer. Preserve JSON backups; data restoration is a separate explicit operation. Do not restore an entire data directory or restart shared infrastructure.

The historical commands below are retained for reference; the current provider launch, timestamp and apply rules above take precedence.

# NAV Monitor Operations

## Daily Valuation Search, Update, and Audit

The valuation audit follows an agent-operable harness pattern:

- Work plane: `data/<fund>/valuations.json` and `data/<fund>/company-config.json`
- Agent plane: Claude Code CLI searches the open web and writes structured recommendations
- Harness plane: `scripts/nav-valuation-audit.mjs` validates and applies accepted update records
- Observation plane: `var/agent-harness/context`, `var/agent-harness/outbox`, `var/agent-harness/runs`, and `var/agent-harness/state/latest-valuation-audit.json`

Run local deterministic checks only:

```bash
npm run audit:valuations:local
```

Run the full Claude Code web search/update/audit:

```bash
npm run audit:valuations
```

Run Claude Code search without applying its updates:

```bash
npm run audit:valuations:dry-run
```

Install the daily system timer:

```bash
sudo cp deploy/nav-valuation-audit.service deploy/nav-valuation-audit.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now nav-valuation-audit.timer
```

Inspect status:

```bash
systemctl status nav-valuation-audit.timer
systemctl list-timers nav-valuation-audit.timer
journalctl -u nav-valuation-audit.service -n 100
```

The harness requires Claude Code CLI login state on the host. Claude runs inside the `nav-valuation-claude` tmux session; tmux only provides a persistent TTY. Claude must write exactly one JSON object to the run-specific outbox path. The harness validates run id, intent, ready state, risk level, environment understanding, known fund/company ids, confidence, evidence URLs, and valuation schema before applying updates.

Restart the Claude Code valuation review manually:

```bash
cd /home/claudeuser/nav-monitor
tmux kill-session -t nav-valuation-claude 2>/dev/null || true
npm run audit:valuations -- --max-budget-usd=8 --timeout-ms=1800000
```

Inspect the live agent screen:

```bash
tmux attach -t nav-valuation-claude
```

Detach from tmux without stopping it: press `Ctrl-b`, then `d`.

Claude Code does not directly edit `valuations.json`. It can propose decisions:

- `update`: insert a new valuation/source record when confidence is at least `0.85`
- `reject`: do not insert the record
- `approve`: audit-only decision, no data write

Uncertain, in-talks, stale, combined-entity, and misattributed items must be resolved as `reject`, not deferred to a human. Applied records are re-audited immediately. If deterministic rules reject a record, it remains visible on the source detail page but will not drive estimated NAV.

## Valuation Rules

Estimated NAV uses only valuations whose audit says `useForNav: true`.

Blocked examples:

- Form D offering amount treated as company valuation
- Standalone company valuation inferred from a combined merger entity
- News headline that does not match the portfolio company
- Single non-official news item with no independent cross-check
- Stale valuation without corroboration

The xAI rule explicitly blocks SpaceX plus xAI combined-entity valuation headlines from being used as a standalone xAI valuation.
