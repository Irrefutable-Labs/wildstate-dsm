/** The game's economic terms on DSM: what it issues and offers. Shared by the server and its screens. */
export const COIN = { ticker: 'WILD', alias: 'Wildstate coin', supply: 1_000_000n };
/** What the game's account puts in the market: WILD and ERA (ERA has two decimals). */
export const MARKET = { wild: '50000', era: '1000', feeBps: 30 };
/**
 * How many vaults the market's liquidity is divided across, in equal slices (owner direction
 * 2026-10-07): trades through different vaults never race for one vault's key.
 */
export const MARKET_VAULTS = 5;
/** An amount counted in an object's smallest fraction (`decimals` places), in the object's own units, as a person enters it ("12.34"). */
export function entered(base: bigint, decimals: number): string {
  if (decimals === 0) return base.toString();
  const unit = 10n ** BigInt(decimals);
  return `${base / unit}.${(base % unit).toString().padStart(decimals, '0')}`;
}
/** Bramble's board (the design's Shop page): what each item costs, in WILD, which the wallet sends. */
export const ITEM_PRICES = { capsule: 3n, poultice: 4n, tonic: 5n, map: 12n } as const;
export type ShopItem = keyof typeof ITEM_PRICES;
/** What one Halloween skin costs, in WILD (game data, like every price on Bramble's board). */
export const SKIN_PRICE = 20n;
/** A trainer's bounty for beating them, in WILD. */
export const TRAINER_REWARD = 12n;
/** A victory's reward, in WILD. */
export const VICTORY_REWARD = 5n;
/** What a new player's wallet receives after its starter creature, in WILD. */
export const WELCOME_COINS = 10n;
