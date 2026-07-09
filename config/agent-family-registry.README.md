# agent-family-registry.json — schema note

This file (`agent-family-registry.json`, sibling to this README) is the
**sole authoritative** agent -> `ModelFamily` registry consumed by
`resolveAgentDefaultFamily()`'s `registry` parameter
(`verification/cross-family-critique.ts`), loaded via
`loadAgentFamilyRegistry()` (`verification/agent-family-registry.ts`).

Per the T3 spec's EPIC-01 constraint, the schema is documented HERE, in this
sibling note, NEVER inside the JSON file itself — the JSON must stay pure
data (no comments).

## Shape

A flat JSON object:

```json
{
  "<agent-label>": "<ModelFamily>"
}
```

- Keys are agent labels (e.g. `boss`, `steve`, `sadie`, `kiera`, `snoopy` —
  matching `AGENT_SESSIONS` in `config.ts`).
- Values MUST be members of the `ModelFamily` union exported from
  `verification/cross-family-critique.ts` (`'anthropic' | 'openai' |
  'google' | 'meta' | 'xai' | 'deepseek' | 'mistral' | 'unknown'`).

## Maintenance

This file is **operator-maintained** — updated by hand (or by an operator's
tooling) when a new agent is onboarded or an agent's underlying model
changes. It is not written to by any runtime code path.

## Degradation contract

`loadAgentFamilyRegistry()` never throws. If this file is missing, is not
valid JSON, or contains a value for any key that is not a member of the
`ModelFamily` union, the loader drops only the offending entries (or, on
unparseable JSON / a missing file, the whole file) and returns a registry no
worse than the frozen empty default — see
`verification/agent-family-registry.ts`.
