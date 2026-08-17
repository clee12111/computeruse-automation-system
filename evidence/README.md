# Evidence Index

Each folder contains a journal, generated report, and README stating what it proves.

## Replay

| Claim | Folder | Result |
|-------|--------|--------|
| Successful replay with output | [replay-success](replay-success/) | SUCCESS, savingsBalance returned |
| Recovery from mid-flow error | [replay-success-with-recovery](replay-success-with-recovery/) | SESSION_EXPIRED detected, recovered, completed |
| Business outcome as data | [replay-business-outcome](replay-business-outcome/) | MEMBER_NOT_FOUND relayed as answer, not error |
| Pre-flight input rejection | [replay-invalid-input](replay-invalid-input/) | INVALID_INPUT, no browser launched |
| Ambiguous target refused | [replay-hard-failure-ambiguous](replay-hard-failure-ambiguous/) | Two candidates scored 6.25; margin gate refused |
| Broken target / site drift | [replay-hard-failure-broken](replay-hard-failure-broken/) | HARD_FAILURE, target not resolved |
| Risky step, unapproved | [replay-escalated-authority](replay-escalated-authority/) | ESCALATED, human required for authority |

## Discovery

| Claim | Folder | Result |
|-------|--------|--------|
| Compiled with self-replay gate | [discovery-compiled](discovery-compiled/) | Artifact compiled, self-replay passed |
| Rejected by self-replay gate | MISSING | _To capture: run discovery that compiles but fails self-replay_ |
| Dead-end with diagnosis | MISSING | _To capture: run discovery with underspecified contract_ |
| Human-assisted (escalated) | MISSING | _To capture: run with --attended_ |
| Pre-flight refused | MISSING | _To capture: run discovery with outputs but no inputs_ |

## System

| Claim | Folder | Result |
|-------|--------|--------|
| Multi-tenant overlay | [multi-tenant-overlay](multi-tenant-overlay/) | One artifact, two tenants, both SUCCESS |
| Trust gate | [trust-gate](trust-gate/) | Unapproved capability blocked |
| Trust blocked (MCP) | [trust-blocked-mcp](trust-blocked-mcp/) | MCP returns trust_blocked error |
| Schema validation | [schema-validation](schema-validation/) | Invalid schema rejected at load time |
| Raw MCP client (no SDK) | [client-agnostic-raw-mcp](client-agnostic-raw-mcp/) | Full protocol handshake + tool call, zero dependencies |
| Third-party surface | [third-party-parabank](third-party-parabank/) | ParaBank artifact (configured, unverified) |
| Clean-room portability | MISSING | _To capture: docker build + run with --network none_ |

## Curated artifact

- [artifact-example.json](artifact-example.json) — the canonical schema example
