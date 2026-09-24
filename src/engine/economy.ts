/**
 * Economy rules (REQ-033) and the numeric helpers derived from them.
 *
 * All amounts are integers. A map may override any subset of these rules; the
 * authoritative state stores the fully resolved rule set so a replay never
 * depends on map lookup order.
 */

import { z } from 'zod';

export interface ChaosTriggerChance {
  readonly LOW: number;
  readonly MEDIUM: number;
  readonly HIGH: number;
}

export interface EconomyRules {
  readonly startingMoney: number;
  readonly salary: number;
  readonly baseRentRatio: number;
  readonly rentMultipliers: number[];
  readonly maxLevel: number;
  readonly upgradeCostRatio: number;
  readonly mortgageRatio: number;
  readonly redeemInterestRatio: number;
  readonly taxRatio: number;
  readonly jailTurns: number;
  readonly bonusRatio: number;
  readonly chaosTriggerChance: ChaosTriggerChance;
}

export const DEFAULT_STARTING_MONEY = 20_000;

export const ECONOMY_DEFAULTS: EconomyRules = {
  startingMoney: DEFAULT_STARTING_MONEY,
  salary: 2_000,
  baseRentRatio: 0.1,
  rentMultipliers: [1, 2, 4, 8, 16],
  maxLevel: 4,
  upgradeCostRatio: 0.5,
  mortgageRatio: 0.5,
  redeemInterestRatio: 0.1,
  taxRatio: 0.1,
  jailTurns: 2,
  bonusRatio: 0.1,
  chaosTriggerChance: { LOW: 0.35, MEDIUM: 0.6, HIGH: 0.9 },
};

export const EconomyRulesSchema = z.object({
  startingMoney: z.number().int().positive(),
  salary: z.number().int().min(0),
  baseRentRatio: z.number().min(0).max(1),
  rentMultipliers: z.array(z.number().positive()).min(2).max(8),
  maxLevel: z.number().int().min(1).max(8),
  upgradeCostRatio: z.number().min(0).max(2),
  mortgageRatio: z.number().min(0).max(1),
  redeemInterestRatio: z.number().min(0).max(1),
  taxRatio: z.number().min(0).max(1),
  jailTurns: z.number().int().min(1).max(5),
  bonusRatio: z.number().min(0).max(1),
  chaosTriggerChance: z.object({
    LOW: z.number().min(0).max(1),
    MEDIUM: z.number().min(0).max(1),
    HIGH: z.number().min(0).max(1),
  }),
});

export const EconomyRulesOverrideSchema = EconomyRulesSchema.partial();
export type EconomyRulesOverride = z.infer<typeof EconomyRulesOverrideSchema>;

/** Merges a partial override onto the defaults, one nesting level deep. */
export function resolveEconomy(override: EconomyRulesOverride = {}): EconomyRules {
  return {
    ...ECONOMY_DEFAULTS,
    ...override,
    rentMultipliers: override.rentMultipliers ?? [...ECONOMY_DEFAULTS.rentMultipliers],
    chaosTriggerChance: {
      ...ECONOMY_DEFAULTS.chaosTriggerChance,
      ...(override.chaosTriggerChance ?? {}),
    },
  };
}

function clampLevel(economy: EconomyRules, level: number): number {
  if (level < 0) return 0;
  return level > economy.maxLevel ? economy.maxLevel : Math.trunc(level);
}

function multiplierAt(economy: EconomyRules, level: number): number {
  const clamped = clampLevel(economy, level);
  const direct = economy.rentMultipliers[clamped];
  if (direct !== undefined) return direct;
  const last = economy.rentMultipliers[economy.rentMultipliers.length - 1];
  return last ?? 1;
}

/** Base rent for a level-0 owned plot. */
export function baseRent(economy: EconomyRules, price: number): number {
  return Math.max(1, Math.round(price * economy.baseRentRatio));
}

/** Rent owed for a property at `level` (0 = bare plot, maxLevel = top tier). */
export function rentFor(economy: EconomyRules, price: number, level: number): number {
  return Math.max(1, Math.round(baseRent(economy, price) * multiplierAt(economy, level)));
}

/** Cost of the next upgrade, i.e. `level -> level + 1`. */
export function upgradeCost(economy: EconomyRules, price: number, level: number): number {
  return Math.max(
    1,
    Math.round(price * economy.upgradeCostRatio * (clampLevel(economy, level) + 1)),
  );
}

/** Total cash sunk into a property at `level` (purchase price + upgrades). */
export function propertyInvested(economy: EconomyRules, price: number, level: number): number {
  let total = price;
  for (let step = 0; step < clampLevel(economy, level); step += 1) {
    total += upgradeCost(economy, price, step);
  }
  return total;
}

/** Cash returned when mortgaging. */
export function mortgageValue(economy: EconomyRules, price: number, level: number): number {
  return Math.max(0, Math.round(propertyInvested(economy, price, level) * economy.mortgageRatio));
}

/** Cash required to lift a mortgage (principal plus interest). */
export function redeemCost(economy: EconomyRules, price: number, level: number): number {
  return Math.round(mortgageValue(economy, price, level) * (1 + economy.redeemInterestRatio));
}

export function taxFor(economy: EconomyRules, money: number): number {
  return Math.max(0, Math.round(Math.max(0, money) * economy.taxRatio));
}

export function bonusFor(economy: EconomyRules): number {
  return Math.max(1, Math.round(economy.startingMoney * economy.bonusRatio));
}
