# ADR-0001: adopt V5 by in-place adaptation with a portable team pipeline

- **Decision:** Adapt the existing `dexter-hq` repo to V5 on a `v5` integration branch, one branch per story, executed by a lead agent that follows a tool-neutral port of OMC's team pipeline, with all build state committed under `.agent-work/`. Build the product exactly to Appendix A.
- **Drivers:** single-chat operation on Cursor, Codex, or Claude Code with lossless switching; owner-gated safety for credentials and irreversible actions; parallel speed without merge chaos.
- **Alternatives considered:** greenfield repo; one big autopilot run; OMC-only execution; separate native plans per tool. Rejected for discarding work, being unreviewable, requiring Claude Code, or splitting the source of truth respectively.
- **Why chosen:** it is reversible at every story, resumable from repo files alone, and keeps OMC's strongest ideas (consensus planning, contracts before lanes, verify/fix loop with a hard limit, handoffs) without depending on any one tool.
- **Consequences:** fourteen owner actions (four of them optional) pause progress at known points; at most 3 lanes run at once; `.agent-work/` adds files to history (squash when merging `v5` into `main` if you prefer a clean log).
- **Follow-ups:** after G3, review the CEO's plan quality from your overrides; after G4, review runtime matrix and Council diversity; if Supabase ever pauses the project, revisit D-1.

Source: DEXTER_V5_ACTION_PLAN.md §11. Adopted in G0.
