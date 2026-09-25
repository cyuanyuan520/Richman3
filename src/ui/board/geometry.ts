import type { MapDefinition, RingTile } from '@/engine/contracts/content';

/**
 * Pure board geometry: turns the map's 0..8 grid coordinates into world space.
 * Kept free of three.js so it stays unit-testable and so the camera framing
 * logic can share the same numbers as the tile placement.
 */

export const TILE_PITCH = 2.12;
export const BOARD_EXTENT = 8;

export interface Vec2 {
  readonly x: number;
  readonly z: number;
}

/** Ring tiles are laid out on a square; `pos` is authored in grid units. */
export function tileWorldPosition(tile: RingTile): Vec2 {
  const [gridX = 0, , gridZ = 0] = tile.pos;
  return {
    x: (gridX - BOARD_EXTENT / 2) * TILE_PITCH,
    z: (gridZ - BOARD_EXTENT / 2) * TILE_PITCH,
  };
}

export function boardExtent(): number {
  return BOARD_EXTENT;
}

/** Yaw so a tile faces the board centre. */
export function tileFacing(tile: RingTile): number {
  const [gridX = 0, , gridZ = 0] = tile.pos;
  const centre = BOARD_EXTENT / 2;
  const dx = gridX - centre;
  const dz = gridZ - centre;
  if (Math.abs(dx) >= Math.abs(dz)) {
    return dx > 0 ? -Math.PI / 2 : Math.PI / 2;
  }
  return dz > 0 ? Math.PI : 0;
}

/**
 * Camera position framing the whole ring from a three-quarter view. Distance
 * scales with the board so a larger future map still fits.
 */
export function cameraPose(): { position: [number, number, number]; fov: number } {
  const half = (BOARD_EXTENT / 2) * TILE_PITCH;
  return {
    position: [0, half * 1.55, half * 1.85],
    fov: 42,
  };
}

export function ringTileById(map: MapDefinition, tileId: string): RingTile | undefined {
  return map.board.ring.find((tile) => tile.id === tileId);
}

export function centreNodePosition(map: MapDefinition, nodeId: string): Vec2 {
  const index = map.board.center.findIndex((node) => node.id === nodeId);
  const count = Math.max(map.board.center.length, 1);
  const angle = (index / count) * Math.PI * 2;
  const radius = TILE_PITCH * 1.6;
  return { x: Math.cos(angle) * radius, z: Math.sin(angle) * radius };
}
