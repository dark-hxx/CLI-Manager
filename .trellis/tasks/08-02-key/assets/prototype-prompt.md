# CCS-Compatible Provider Domain Prototype

## Deliverables

- `ccs-provider-domain-prototype.svg` — editable, deterministic source.
- `ccs-provider-domain-prototype.png` — 1600 × 1000 review image rendered
  from the SVG.

The composition combines the supplied CCS list and Codex editor references into
one reviewable master/detail screen:

- supplier type tabs and a global-current/Home strip;
- provider cards with endpoint, selected model, active key/count and ordering;
- visible provider name, note, base URL, model/model provider;
- manual multi-key controls;
- type-level common-config inheritance;
- Codex `auth.json`, `config.toml`, effective config, live diff, advanced,
  test and billing surfaces.

## Image generation attempt

An optional `gpt-image-2` high-fidelity generation was attempted through the
approved image-generation CLI. This environment has no `OPENAI_API_KEY`
variable available to that CLI, so no image API request was made. The supplied
prototype is therefore an editable SVG rendered locally, which keeps text,
layout and product-specific controls accurate for implementation review.

## Rendering instruction

If a future image-model variation is wanted, use the two user-supplied CCS
screens as **layout references only** and preserve these product invariants:

```text
Use case: ui-mockup
Asset: Windows desktop provider management, 1600 x 1000, light theme.
Show CLI-Manager original branding, no CC Switch/OpenAI logo.
Include type tabs (Claude Code, Codex, Grok), a global selected provider/Home
strip, search/import/environment actions, reorderable provider cards, and a
selected Codex provider editor. The editor must visibly show base URL, active
API key and manual multi-key rows, model and model provider, type common config
inheritance, auth.json and config.toml editors, effective config/live diff,
model testing and billing panels. No automatic key rotation/failover/health UI,
no real key, no watermark, no mobile or marketing layout.
```
