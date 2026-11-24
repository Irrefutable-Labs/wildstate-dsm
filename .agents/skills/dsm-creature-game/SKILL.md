---
name: dsm-creature-game
description: Design and implement DSM integration for creature RPGs with branching DLV campaigns, repeatable encounters, persistent per-move combat resources, elemental moves with bounded statuses, and transferable ownership. Pair with the project's RPGJS skill for engine work.
---

# DSM Creature Game

Use this skill for game-state authority, resource consumption, campaign choices, encounter allocation, combat rules and continuity, and DSM adapter work. Use RPGJS guidance for maps, presentation, synchronization, and engine APIs.

## Sources and scope

Locate the DSM repository from project configuration or the user. Read its `specs/README.md`, then the applicable current architectural and settlement sections. Repository specifications govern over older skill summaries, cached conversations, and illustrative game designs. Implementation is evidence of capability, not protocol intent.

Read [the game contract](references/game-contract.md) when modeling state, moves, or transitions. It describes the current application design, not an existing DSM game API. Read [the move invariants checklist](references/move-invariants.md) before changing combat rules.

Keep game code in its independent application. Change DSM backend code only when the user authorizes that scope. Do not invent a browser SDK, DLV opcode, mint authority, proof format, or supported successor-vault operation.

## Authority boundary

Every persistent command identifies its holder, affected creature/battle/campaign instance, expected parent coordinate, and consumed resources. The reducer computes results from pinned rules (species tables, move tables, element chart, status definitions) and validated evidence. A client supplies ids and choices only; it never supplies damage, multipliers, charge counts, or status outcomes. A root or signature alone does not establish transition validity.

The game runs on DSM only: a player connects a wallet before play, and there is no local mode. What the player owns (coin, creatures) is a projection of what their DSM wallet proved it owns; the reducer never issues or spends it. A DSM task that has not completed is pending work, retried or surfaced, never replaced by a local result.

DSM wire and accepted state use the normative binary codec and domain-separated hashes. Do not implement a second cryptographic authority in TypeScript or call JSON snapshots DSM commitments. Keep game content configuration and local development saves outside protocol authority.

An adapter returns only results the real Core/SDK has established; it cannot manufacture accepted receipts, roots, signatures, entropy, or storage finality. Pending evidence is retryable acquisition work, not semantic rejection. Preserve mode-specific acceptance and distinguish registration, fulfillment, consumption, and realization.

## Paired workflow

1. Inspect the game's actual entrypoints and synchronized player props using its RPGJS skill.
2. Specify each operation's evidence, parent, consumption scope, atomic updates, and presentation projection.
3. Inspect the actual DSM API and normative types before implementing the integration. Document unsupported application policies as missing work.
4. Implement pure gameplay rules independently from transport. Every command goes through one commit path: the reducer, then what the command means on DSM.
5. Install accepted projections in RPGJS props; never allow a second independently writable inventory, HP ledger, charge ledger, or currency balance.
6. Test the move invariants checklist plus conflicting choices, duplicate rewards, stale battle actions, ownership changes, failed evidence acquisition, and recovery at the actual settlement boundary when available.

Report game-server behaviour separately from verified DSM behaviour. Complete ordinary game work while integration gaps remain visible.
