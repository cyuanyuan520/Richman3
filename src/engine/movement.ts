/**
 * Pure board-geometry and movement helpers shared by the reducer and the
 * effect executor. Immutable: every function returns a new `Player`.
 */

import type { MapDefinition, Warp } from './contracts/content';
import type { Player } from './contracts/state';

export interface BoardGeometry {
  readonly ringSize: number;
  /** Ring index -> tile id. */
  readonly ringTileIds: readonly string[];
  /** Tile id -> ring index. */
  readonly ringIndexById: Readonly<Record<string, number>>;
  /** Valid warp targets by source tile id, in declaration order. */
  readonly warpsBySource: Readonly<Record<string, readonly Warp[]>>;
}

export function buildGeometry(map: MapDefinition): BoardGeometry {
  const ring = [...map.board.ring].sort((a, b) => a.index - b.index);
  const ringTileIds = ring.map((tile) => tile.id);
  const ringIndexById: Record<string, number> = {};
  ring.forEach((tile, index) => {
    ringIndexById[tile.id] = index;
  });

  const warpsBySource: Record<string, Warp[]> = {};
  for (const warp of map.board.warps) {
    const bucket = warpsBySource[warp.fromTileId];
    if (bucket === undefined) {
      warpsBySource[warp.fromTileId] = [warp];
    } else {
      bucket.push(warp);
    }
  }

  return { ringSize: ringTileIds.length, ringTileIds, ringIndexById, warpsBySource };
}

/** Unconditional warp out of `tileId`, if any. */
export function outgoingWarp(geometry: BoardGeometry, tileId: string): Warp | undefined {
  const candidates = geometry.warpsBySource[tileId];
  if (candidates === undefined) return undefined;
  return candidates.find((warp) => warp.condition === undefined);
}

export interface RingMove {
  readonly index: number;
  /** Full loops completed in the forward direction (negative moves are 0). */
  readonly laps: number;
}

/** Resolves a circular move without mutating anything. */
export function resolveRingMove(current: number, steps: number, ringSize: number): RingMove {
  if (ringSize <= 0) throw new RangeError('ringSize must be positive');
  const raw = current + steps;
  const laps = raw >= 0 ? Math.floor(raw / ringSize) : 0;
  const index = ((raw % ringSize) + ringSize) % ringSize;
  return { index, laps };
}

export function withRingPosition(player: Player, index: number): Player {
  return { ...player, position: { zone: 'ring', index } };
}

export function withCenterPosition(player: Player, nodeId: string, entryTileId?: string): Player {
  return {
    ...player,
    position:
      entryTileId === undefined
        ? { zone: 'center', nodeId }
        : { zone: 'center', nodeId, entryTileId },
  };
}

export function isOnRing(player: Player): boolean {
  return player.position.zone === 'ring';
}

export function ringIndexOf(player: Player): number | null {
  return player.position.zone === 'ring' ? player.position.index : null;
}

export function tileIdOf(player: Player, geometry: BoardGeometry): string | null {
  if (player.position.zone !== 'ring') return null;
  return geometry.ringTileIds[player.position.index] ?? null;
}
