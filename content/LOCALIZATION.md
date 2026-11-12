# Public Localization

The English interface and published research copy have local dictionaries for
Simplified Chinese, Hindi, Spanish and Arabic. The same language selector is
injected into every generated HTML page. `?lang=zh|en|hi|es|ar` overrides the
saved browser preference; Arabic uses RTL layout. Names, tickers, numeric values,
source dates and raw diagnostic identifiers are not rewritten as financial data.

`localization.js` translates text and accessible labels, including async dashboard
updates, calculator validation and Chart.js labels/tooltips. It retains original
text separately, so changing languages does not translate an already translated
string. Dictionaries are fingerprinted same-origin assets. No visitor portfolio
input is sent to a translation service. If a dictionary cannot load, the original
English remains available. Unknown future source headlines retain their original
wording until a new reviewed catalog is published. This is client-side localization,
not five separate server-rendered SEO editions.

## Updating Copy

1. Collect only public rendered copy with `ops/extract-localization.py`. Exclude
   scripts, private files, credentials and visitor input. Review the extraction.
2. `ops/translate-glm.py` uses the existing provider settings in process, without
   tools or agent execution. Run only with the owner's usage authorization.
   It limits batches, attempts and concurrency, validates IDs and placeholders,
   and writes a resumable catalog with a separate provider-usage receipt.
3. Inspect terminology, non-commercial notices, uncertainty and negations. Never
   promote an estimate to official NAV or a research diagnostic to executed PnL.
4. Run the Node unit tests, then `ops/prepare-build.mjs <isolated-build-directory>`.
   Build against a public or synthetic snapshot, and run `ops/qa-localization.mjs`
   against the isolated fixture before publication. Preserve the original
   publisher configuration and never load/click advertisements during QA.
5. Deploy static assets and generated pages with the existing verified static
   deployer. Back up changed editable sources and synchronize the designated
   daily builder's complete input hash manifest. Do not restart NAV, KiT or the
   shared tunnel, and do not modify valuation datasets for a localization release.

The KiT links describe seven research designs; they are not new executed
simulations or verified return claims. Candidate output is blocked when forecast
origin prices do not match anchor bars or model provenance is inconsistent.
