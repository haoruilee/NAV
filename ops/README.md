# Five-language static publication (2026-11-12)

The public interface and research copy use English, Simplified Chinese, Hindi,
Spanish and Arabic dictionaries. All generated HTML includes the same-origin
language selector; Arabic uses RTL. See `content/LOCALIZATION.md`. The existing
AdSense verification script and account configuration remain unchanged.

Translation is a separately authorized, bounded build-time operation, not a
visitor-facing API or a daily automatic model job. The configured GLM provider's
Chat Completions endpoint is used with low reasoning effort; its Anthropic adapter
did not honor the attempted thinking budget. Credentials remain in the existing
production settings file and are never copied into artifacts. Keep source-copy
and dictionary receipts separate from private settings. New external headlines
without catalog entries remain in the original language until reviewed.

Use `ops/prepare-build.mjs` to stage public sources and pin every input, then run
`ops/qa-localization.mjs` on the builder. Static installation still uses the
deployer below with unchanged-container and unchanged-tunnel checks. Synchronize
the daily builder's source and inputs only after acceptance, or daily publication
will overwrite the multilingual interface. Preserve backups and never reset the
dirty production checkout. The publication job itself makes no translation calls.

# Research publishing and advertising

Editable homepage and source-page templates are `content/templates/`. Generated `public/*.html` must never be copied back into these templates, or repeated publication would append duplicate sections.

Source-only worktree: `content/`, `ui/`, `ops/`, `public/index.html`, `public/sources.html`, and self-hosted vendor assets. All frontend generation, Tailwind compilation and browser tests run on `li@www.xzhtai.cn:2077`, isolated in `/home/li/nav-growth-20261103`. Do not run `build.mjs` on production. Builder `inputs.json` pins every allowed source. No Docker context or new image is needed for the static release.

## Acceptance and publication

1. Transfer an explicit source allowlist and SHA256 inputs to the builder. No private settings, fund files, logs, backups, production credentials or SQL/Redis connections.
2. Run the synthetic API fixture and `qa.mjs` on builder. Tests cover overlap arithmetic, unmapped exposure, invalid input, zero portfolio submissions, disabled advertising, layouts, structured data and link integrity.
3. Only after synthetic acceptance, publication collects unauthenticated public read-only APIs plus bounded official-company HTML. This publication snapshot lives outside source inputs. No quotes, paid model requests or private credentials are used.
4. The builder creates HTML, CSS, modules, social image, RSS, robots and sitemap. Only substantive profiles and original guides are indexable. Missing profiles remain readable with `noindex,follow`. No artificial daily lastmod is emitted.
5. Pull an immutable archive and manifest using resumable rsync. Verify source hashes on the builder and archive/member hashes before installing. Assets and nested routes precede atomic root HTML/discovery updates. All files are allowlisted.
6. The static deployer captures previous owned files, verifies localhost plus `etfnav.org` and `www.etfnav.org`, confirms the container/start time and shared tunnel PID did not change, then persists accepted static files to the source checkout. Failure restores the previous files. No restarts, database changes, DNS changes or model calls.

`nav-content-publish.timer` runs at 12:30 UTC daily with up to ten minutes jitter (20:30–20:40 Beijing), after the existing 09:30 UTC valuation audit. A dedicated flock prevents publication overlap; a still-running valuation audit defers publication. This schedule republishes verified observations; it does not assert there is new news every day.

The official announcement collector follows at most two financing-related same-origin article links per configured company, uses two workers, per-request timeouts, a body limit and at most three same-origin redirects. Only explicit article publication metadata or Article/NewsArticle/BlogPosting `datePublished` is accepted. Future/invalid dates and inaccessible sources are skipped. A publisher article is contextual news and does not automatically become a numerical NAV input. Historical eligible valuation records keep their event dates and attribution. Failed or absent checks never manufacture a fresh event.

## Inspect and rollback

- `systemctl list-timers nav-content-publish.timer nav-valuation-audit.timer`
- `journalctl -u nav-content-publish.service -n 60`
- `/opt/nav-monitor/content-releases/<run>/receipt.json`, immutable archive, manifest and `baseline/`.
- Disable only the content publication timer before rollback. Restore the run's `rollback-state.json` old files from `baseline/` using `docker cp` to a dot-prefixed temporary path followed by `docker exec nav-monitor mv`. Remove only paths listed as newly introduced by that run. Restore corresponding host `public/` files as well. Retain hashed assets until accepted. Never restore a database or restart the tunnel for a static rollback.

## Google AdSense setup (currently disabled)

The UI reserves labeled `Advertisements` slots: `dashboard_banner`, `article_inline`, and `research_footer`. They are deliberately separated from calculator controls and source links. No Google advertising or analytics script is requested by default. Existing vendor scripts remain self-hosted.

Before activation:

1. Obtain a real publisher account and responsive slot IDs. Set `content/site-config.json`: `adsense.enabled`, `clientId` (`ca-pub-` plus 16 digits), and the desired 10-digit slot IDs. Configure a public corrections/advertising email after the owner supplies one; no private customer email is reused.
2. Implement the appropriate consent flow with a Google-certified CMP where required. Only the real consent integration may set `window.navAdvertisingConsent=true` and dispatch `nav:advertising-consent`; do not hardcode this for all visitors. The current consent hook is not a CMP and does not implement revocation or region determination. Complete that integration before activation.
3. Update privacy/editorial disclosures to the actual configuration and provide a verifiable consent/corrections contact. Add a real `ads.txt` publisher entry to the generator after account verification. Never publish a placeholder publisher ID. Google currently documents `google.com, pub-<actual ID>, DIRECT, f08c47fec0942fa0`.
4. Rebuild and test on the builder, publish a verified artifact. Do not click ads in testing. Search Console verification/sitemap submission and AdSense review are separate account actions; no indexing, traffic or approval is guaranteed by these files.

References: https://developers.google.com/search/docs/essentials ; https://developers.google.com/search/docs/fundamentals/creating-helpful-content ; https://support.google.com/adsense/answer/1346295 ; https://support.google.com/adsense/answer/13554116 ; https://support.google.com/adsense/answer/12171612
