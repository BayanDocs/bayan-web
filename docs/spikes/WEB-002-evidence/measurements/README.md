# WEB-002 measurements: the raw figures

The figures behind the tables of [the WEB-002 report](../../WEB-002-report.md), as `tests/e2e/measurements.spec.ts` wrote them: one JSON file per browser and measurement (`<browser>-scroll-frames.json`, `-zoom-frames.json`, `-keystroke-latency.json`, `-startup-roundtrips-memory.json`). Times are in milliseconds; they hold durations and counts only, never document content. Section 4 of the report says how they were measured and what each figure means.

| Folder or file | Where and when | Code |
|---|---|---|
| `linux-container-run-1/`, `linux-container-run-2/` | The Linux cloud container of section 4 (4 virtual cores, no graphics processor), 2026-10-12 at 01:42 and 01:43 UTC, `--workers 1` | This branch after commit `19c1909`, before the accessibility fixes of `e8959b1`, which do not touch drawing or input |
| `linux-container-webkit-ratio-1.txt` | The same container, WebKit at a device-pixel ratio of 1, with the temporary configuration of section 13. Its JSON files were not kept; the file holds the lines the run printed, recovered from the session's log, where the keystroke line was cut off | As above |
| `ci-38194327872-macos-15/`, `ci-38194327872-macos-26-intel/` | The `measurements-macos-15` and `measurements-macos-26-intel` artifacts of [CI run 38194327872](https://github.com/BayanDocs/bayan-web/actions/runs/38194327872), on GitHub's macOS virtual machines | Commit `c2c64dc` |
| `ci-38221275967-ubuntu-24.04/`, `ci-38221275967-macos-15/`, `ci-38221275967-macos-26-intel/` | The measurement artifacts of [CI run 38221275967](https://github.com/BayanDocs/bayan-web/actions/runs/38221275967), on GitHub's Ubuntu and macOS virtual machines | Commit `194e88e`, with the compositor fix that releases stand-in tiles before a frame is drawn |

CI keeps a run's artifacts for 30 days; these copies keep them for the review of ADR-0014's validation gate.
