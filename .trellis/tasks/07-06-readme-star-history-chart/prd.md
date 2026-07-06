# README Star History chart

## Goal

Add a live GitHub star history line chart to the project README files so readers can see repository star growth from the documentation.

## Changelog Target

V1.2.5

## Requirements

* Add a Star History chart section to `README.md`, `README.zh-CN.md`, and `README.en-US.md`.
* Use the official Star History embeddable chart pattern with light and dark theme support.
* Use repository `dark-hxx/CLI-Manager`.
* Record the documentation change in `CHANGELOG.md` under `V1.2.5`.

## Acceptance Criteria

* [x] All README language variants contain the Star History chart.
* [x] The chart link opens the Star History page for `dark-hxx/CLI-Manager`.
* [x] The image URL uses `api.star-history.com/chart`.
* [x] `CHANGELOG.md` records the README chart addition under `V1.2.5`.

## Definition of Done

* Relevant files inspected before editing.
* Diff verified after editing.
* No application code, dependency, or runtime config changed.

## Technical Approach

Insert a small `Star History` section near the existing bottom star/support block in each README. Use a `<picture>` block matching Star History's public README example:

* Dark theme: `https://api.star-history.com/chart?repos=dark-hxx/CLI-Manager&type=date&theme=dark&legend=top-left`
* Light theme/default: `https://api.star-history.com/chart?repos=dark-hxx/CLI-Manager&type=date&legend=top-left`

## Out of Scope

* Generating or storing a local chart image.
* Adding dependencies or build-time chart generation.
* Changing product behavior.

## Technical Notes

* Official implementation reference: `star-history/star-history` README uses `<picture>` with `api.star-history.com/chart`.
* A direct local request to the API returned `503` during research, so the README should depend on the normal remote embed and retain alt text.
