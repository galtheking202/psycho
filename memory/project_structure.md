---
name: Project file structure
description: PDF test list lives in practice_tests.json; app settings in config.json
type: project
---

PDF test list is in `practice_tests.json` (array of {name, name_he, url}).
App settings (e.g. answer_pages_from_end) are in `config.json`.

**Why:** User clarified the test list is not in config.json.

**How to apply:** Always read tests from practice_tests.json, not config.json.
