# NAV Monitor light frontend (2026-11-03)

Apple-inspired white/gray surfaces, system typography, blue charts and links,
accessible fund navigation and dialogs. Numerical API contracts and backend
maintenance are unchanged. Source templates live in public/index.html and
public/sources.html; design tokens and Tailwind input live in ui/.

Compile only on li@www.xzhtai.cn:2077 in an isolated allowlisted directory.
Inputs: public/index.html, public/sources.html, ui/nav-theme.css,
ui/tailwind.config.cjs. Use Tailwind3.4.17. Vendor packages in this release:
Lightweight Charts4.1.1 and the existing live Chart.js4.6.1; third-party license
notices are distributed in public/assets/THIRD-PARTY-LICENSES.txt.
Generated CSS and vendor filenames carry content hashes. Never use backups,
credentials, databases, var/, or live financial data as build/test inputs.

This release deploys a hash-verified static artifact without replacing the
nav-monitor container, changing /api, DNS, tunnels, or the daily maintenance
service. Copy additive assets first, verify their hashes, stage dot-prefixed
HTML files in /app/public, and atomically rename the two HTML entry points.
Keep existing asset versions for open browser tabs. Container restart preserves
the writable layer; a future image recreation must include these current public
files. Never recreate the old image and assume it contains the new frontend.

Immutable artifact SHA256:
9868b35debe6992354fa5b2be2c71b66d0f3fd9f1375491f32470f982d03fe5a

Evidence, original HTML and rollback helper:
/root/ops-private/nav-apple-ui-20261103/
Runtime release: /opt/nav-monitor/ui/releases/apple-20261103-r3/
Rollback only HTML through the helper; do not restore financial JSON or restart
shared infrastructure. All synthetic browser QA runs on the builder. Public
acceptance reads pages/APIs only and never submits a paid model request.
