# Gateway smoke — three rounds, same criterion

Criterion (unchanged): a GitHub Models row, with the HQ token, returns a completion, one tool call, and one schema-valid JSON reply.

GitHub's changelog says GitHub Models was fully retired on 2026-07-30. The inference API and catalog are no longer available. No other provider was called in their place.

| Round | What was called | Result | Saved body |
| --- | --- | --- | --- |
| 1 | Chat completions POST. The probe then tried a second host that did not resolve, and it exited before writing JSON. | HTTP 200, `text/plain`, body `OK` (4 bytes). Not a completion. | Not saved. Not re-run. |
| 2 | Same completions POST with the GitHub API version headers. | HTTP 200, `text/plain`, 4 bytes, `OK`. `looks_like_completion: false`. | `gateway-attempt-2.json` |
| 3 | Catalog GET with the same headers. | HTTP 200, `text/plain`, 4 bytes, not JSON, body `OK`. | `gateway-attempt-3.json` |

A fourth call would not change a retired product. The criterion was not weakened.
