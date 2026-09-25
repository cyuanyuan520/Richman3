import { Clone, OrbitControls } from '@react-three/drei';
import { useLoader } from '@react-three/fiber';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import type { ThemeTokens } from '@/engine/contracts/config';
import type { MapDefinition, RingTile } from '@/engine/contracts/content';
import type { GameState } from '@/engine/contracts/state';

import { centreNodePosition, tileFacing, tileWorldPosition } from './geometry';

export interface BoardSceneProps {
  readonly map: MapDefinition;
  readonly state: GameState;
  readonly theme: ThemeTokens;
  /** Asset key to fetchable URL, from the committed manifest. */
  readonly modelUrls: Readonly<Record<string, string>>;
  readonly shadows: boolean;
  readonly shadowMapSize: number;
  /** Most recent die face, or null before the first roll. */
  readonly lastRoll: number | null;
}

function Model({
  url,
  position,
  rotation,
}: {
  url: string;
  position: [number, number, number];
  rotation?: number;
}) {
  const gltf = useLoader(GLTFLoader, url);
  return (
    <group position={position} rotation={[0, rotation ?? 0, 0]}>
      <Clone object={gltf.scene} />
    </group>
  );
}

function Tile({
  tile,
  url,
  owned,
  highlight,
}: {
  tile: RingTile;
  url: string;
  owned: boolean;
  highlight: string;
}) {
  const position = tileWorldPosition(tile);
  const rotation = tileFacing(tile);
  return (
    <group position={[position.x, 0, position.z]} rotation={[0, rotation, 0]}>
      <Model url={url} position={[0, 0, 0]} />
      {owned && (
        <mesh position={[0, 0.05, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[1.0, 1.16, 24]} />
          <meshBasicMaterial color={highlight} transparent opacity={0.8} />
        </mesh>
      )}
    </group>
  );
}

/**
 * The whole board: ring tiles, upgrade houses, centre pads, pieces and the die.
 * Consumer of `assets.manifest.json` — every model comes from the Blender kit.
 */
export function Board({
  map,
  state,
  theme,
  modelUrls,
  shadows,
  shadowMapSize,
  lastRoll,
}: BoardSceneProps) {
  const colours = theme.colors as Record<string, string | undefined>;
  const ground = colours['ground'] ?? '#7ec850';
  const centreColour = colours['accentCool'] ?? '#2ec4b6';
  const highlight = colours['uiHighlight'] ?? '#ff8a3d';
  const ring = map.board.ring;
  const diceUrl = modelUrls['city.dice'];

  return (
    <>
      <hemisphereLight
        args={[
          colours['skyTop'] ?? '#8fd3ff',
          colours['ground'] ?? '#7ec850',
          theme.lightIntensity * 0.5,
        ]}
      />
      <directionalLight
        position={[12, 20, 8]}
        intensity={theme.lightIntensity}
        castShadow={shadows}
        shadow-mapSize-width={shadowMapSize}
        shadow-mapSize-height={shadowMapSize}
        shadow-camera-left={-16}
        shadow-camera-right={16}
        shadow-camera-top={16}
        shadow-camera-bottom={-16}
      />

      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow={shadows}>
        <circleGeometry args={[18, 48]} />
        <meshStandardMaterial color={ground} roughness={0.95} />
      </mesh>

      {ring.map((tile) => {
        const url = tile.modelRef === undefined ? undefined : modelUrls[tile.modelRef];
        if (url === undefined) return null;
        const tileState = state.board.tiles[tile.id];
        return (
          <Tile
            key={tile.id}
            tile={tile}
            url={url}
            owned={tileState !== undefined && tileState.ownerId !== null}
            highlight={
              tileState?.mortgaged === true ? (colours['uiShadow'] ?? '#c9b79c') : highlight
            }
          />
        );
      })}

      {ring.map((tile) => {
        const level = state.board.tiles[tile.id]?.level ?? 0;
        const url = level > 0 ? modelUrls[`city.house_${Math.min(level, 4)}`] : undefined;
        if (url === undefined) return null;
        const position = tileWorldPosition(tile);
        return (
          <Model
            key={`house-${tile.id}`}
            url={url}
            position={[position.x + 0.6, 0.02, position.z + 0.6]}
          />
        );
      })}

      {map.board.center.map((node) => {
        const position = centreNodePosition(map, node.id);
        const occupied = state.players.some(
          (player) => player.position.zone === 'center' && player.position.nodeId === node.id,
        );
        return (
          <mesh
            key={node.id}
            position={[position.x, 0.06, position.z]}
            rotation={[-Math.PI / 2, 0, 0]}
            receiveShadow={shadows}
          >
            <circleGeometry args={[0.95, 6]} />
            <meshStandardMaterial
              color={occupied ? (colours['accentPrimary'] ?? '#ff5a5f') : centreColour}
              roughness={0.8}
            />
          </mesh>
        );
      })}

      {state.players.map((player, seat) => {
        const url = modelUrls[player.characterId];
        if (url === undefined) return null;
        const anchor =
          player.position.zone === 'ring'
            ? tileWorldPosition(ring[player.position.index] ?? ring[0]!)
            : centreNodePosition(map, player.position.nodeId);
        const offset = (seat - (state.players.length - 1) / 2) * 0.36;
        return (
          <group key={player.id} position={[anchor.x + offset, 0.06, anchor.z + offset]}>
            <Model url={url} position={[0, 0, 0]} rotation={Math.PI / 4} />
            {!player.connected && (
              <mesh position={[0, 1.6, 0]}>
                <sphereGeometry args={[0.09, 12, 12]} />
                <meshBasicMaterial color={colours['uiShadow'] ?? '#c9b79c'} />
              </mesh>
            )}
          </group>
        );
      })}

      {lastRoll !== null && diceUrl !== undefined && (
        <Model url={diceUrl} position={[0, 0.7, 0]} rotation={lastRoll * 0.4} />
      )}

      <OrbitControls
        enablePan={false}
        minDistance={7}
        maxDistance={30}
        maxPolarAngle={Math.PI / 2.3}
        target={[0, 0, 0]}
      />
    </>
  );
}
