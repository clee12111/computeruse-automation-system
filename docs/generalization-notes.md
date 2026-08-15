# Domain-Tuning vs Site-Tuning — Generalization Notes

The system's generalization story has three layers, each with a different scope of
portability:

**Task-domain tuning** (financial reads): The system prompt's compaction hints
(`[MONEY]` tags, `col:"Balance"` annotations, money-first element ordering) are tuned
to financial data extraction. These help any financial site — they're domain knowledge
("look for dollar amounts in Balance columns"), not site knowledge. A non-financial
task (e.g., reading shipping statuses) would need different compaction hints but NO
code changes.

**UI-grammar strategies** (the Surface): The descriptor strategies (roleName,
labelProximity, tableCell, structural, geometric) encode knowledge about how web UIs
are built — forms have labels near inputs, tables have headers above columns, buttons
have accessible names. These are UI-grammar universals. ParaBank's clean HTML and our
hostile mock both conform to these patterns, despite radically different markup quality.
The strategies degrade gracefully: roleName works on well-labeled elements, structural
catches unlabeled ones, geometric is the last resort.

**Site-specific configuration** (zero code): A new site requires only configuration
entries: policy.json (origin + routes), credentials in .env, and a discovery run. The
ParaBank phase proved this — zero lines of `browser-surface.ts` were changed for the
third-party site. The geometric locator fix (drilling to deepest element) was a GENERAL
improvement that benefits all sites, not a ParaBank-specific patch.

**The transfer proof**: The same artifact schema, the same engine, the same recording
pipeline compiled a capability on ParaBank that replays 5/5. The artifact is structurally
identical to our mock console artifacts — same Zod validation, same descriptor types,
same predicate vocabulary. The only difference is the specific text content in anchors
and expects. This is the generalization evidence: the system learned ParaBank's flow
the same way it learned our console's flow, without knowing it was a different site.

**The Altoro data point**: Altoro Mutual (demo.testfire.net) is genuinely hostile legacy
markup — the same era as our mock. The model navigated login but struggled with
post-login navigation. This is a model capability issue (the LLM's ability to reason
about the page), not a Surface issue. The Surface observed and described Altoro's
elements correctly; the model chose wrong actions. This distinguishes between system
generality (proven) and model capability (varies per site complexity).
