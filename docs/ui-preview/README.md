# Liebs interface preview

A static preview of the included Chrome extension’s account connection and main popup screens.

**To view:** download or clone the repository, then open `docs/ui-preview/index.html` in a browser on your computer. GitHub displays HTML as source rather than running this preview.

The preview uses the actual `extension/popup/popup.html` and `popup.css`. Extension scripts and telemetry are omitted, animations are frozen, and the selected views are made visible. The email `demo@example.com` and balance of 12 charms are sample data. Buttons do not perform account, payment, or generation actions. The presentation around the two screens is for documentation.

To refresh it after changing the extension, copy the updated markup/styles and reapply these presentation-only changes. Do not use this folder as the installable extension; load `extension/` instead.
