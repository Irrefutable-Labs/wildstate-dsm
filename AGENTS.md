# Creature RPG

Use `.agents/skills/rpgjs/SKILL.md` for RPGJS work and `.agents/skills/dsm-creature-game/SKILL.md` for gameplay authority and DSM integration. Keep their responsibilities complementary: RPGJS projects state and owns presentation; DSM authority must come from the real protocol.

The game runs on DSM only: a player connects a wallet before play, and there is no local mode. The game plugs into DSM: what a player owns (WILD, creatures) is an object in their wallet; the game state's coins and roster are a projection of what the wallet proved it owns. Never describe game-server results as DSM secured. The game's own record (`creatureSave`, the profiles in `data/dsm-game.json`) is game data, not a DSM encoding.

DSM source reference: `/Users/cryptskii/Desktop/claude_workspace/d-s-m/dsm`. Read `specs/README.md` before using protocol concepts. Do not edit that repository for game-only tasks.

Run `npm test`, `npm run typecheck`, and `npm run build` for state changes. Test externally observable state invariants rather than implementation wording. Keep the starter's Tiled assets and production preview checks.
