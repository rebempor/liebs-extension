# Liebs interface preview

Static previews of the included Chrome extension’s account connection and main popup screens.

## Images embedded in the main README

- [Overview PNG](../assets/liebs-ui-overview.png) — both interface states in one graphic.
- [Connection PNG](../assets/liebs-ui-connect.png) and [main popup PNG](../assets/liebs-ui-create.png) — individual views.
- Editable source: `liebs-ui-overview.svg`, `liebs-ui-connect.svg`, and `liebs-ui-create.svg`.

These are **reconstructed UI illustrations**, exported at double resolution, not browser screenshots. They match the current extension’s 360px popup layout, colors, labels, and controls. The account, credit balance, and Alex history item are sample data. Typography, line wrapping, and spacing can differ from Chrome. The preview does not verify live sign-in or generation.

## HTML/CSS preview

**To view:** download or clone the repository, then open `docs/ui-preview/index.html` in a browser on your computer. GitHub displays HTML as source rather than running this preview.

The preview uses the actual `extension/popup/popup.html` and `popup.css`. Extension scripts and telemetry are omitted, animations are frozen, and the selected views are made visible. The email `demo@example.com` and balance of 12 charms are sample data. Buttons do not perform account, payment, or generation actions. The presentation around the two screens is for documentation.

To refresh it after changing the extension, copy the updated markup/styles and reapply these presentation-only changes. Do not use this folder as the installable extension; load `extension/` instead.
