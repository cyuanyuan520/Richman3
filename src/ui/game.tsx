import { Suspense, useMemo, useState } from 'react';
import { Canvas } from '@react-three/fiber';

import type { Character } from '@/engine/contracts/content';
import type { ClientIntent } from '@/engine/contracts/net';
import type { GameState, Player } from '@/engine/contracts/state';
import type { ThemeTokens } from '@/engine/contracts/config';
import type { MapDefinition } from '@/engine/contracts/content';
import type { TableSnapshot } from '@/app/session';
import { Board } from './board/Board';
import { cameraPose } from './board/geometry';

export interface GameScreenProps {
  map: MapDefinition;
  characters: readonly Character[];
  theme: ThemeTokens;
  snapshot: TableSnapshot;
  modelUrls: Record<string, string>;
  shadows: boolean;
  shadowMapSize: number;
  /** Seat controlled locally. `null` while spectating a networked table. */
  localPlayerId: string | null;
  dispatch: (intent: ClientIntent) => void;
  onPause: () => void;
}

const MINIGAME_ACTIONS: Record<string, readonly { action: string; label: string }[]> = {
  WHEEL: [{ action: 'SPIN', label: '转一把' }],
  RPS: [
    { action: 'ROCK', label: '石头' },
    { action: 'PAPER', label: '布' },
    { action: 'SCISSORS', label: '剪刀' },
  ],
  GACHA: [{ action: 'DRAW', label: '抽一张' }],
};

const PHASE_LABELS: Record<string, string> = {
  SETUP: '准备中',
  AWAIT_ROLL: '等待掷骰',
  AWAIT_CHOICE: '等待选择',
  AWAIT_END_TURN: '等待结束回合',
  MINIGAME: '小游戏中',
  GAME_OVER: '对局结束',
};

function money(value: number): string {
  return `$${value.toLocaleString('zh-CN')}`;
}

function propertiesOf(state: GameState, playerId: string): string[] {
  return Object.values(state.board.tiles)
    .filter((tile) => tile.ownerId === playerId)
    .map((tile) => {
      const ring = state.board.tiles[tile.tileId];
      void ring;
      return `${tile.tileId}${tile.level > 0 ? ` Lv${tile.level}` : ''}${tile.mortgaged ? '（抵押）' : ''}`;
    });
}

function PlayerCard({
  player,
  state,
  isActive,
  isLocal,
  characterName,
}: {
  player: Player;
  state: GameState;
  isActive: boolean;
  isLocal: boolean;
  characterName: string;
}) {
  const tiles = propertiesOf(state, player.id);
  return (
    <li className={`player-card${isActive ? ' is-active' : ''}${player.bankrupt ? ' is-out' : ''}`}>
      <div className="player-head">
        <strong>{player.nickname}</strong>
        {isLocal ? <em className="tag">你</em> : null}
        {player.isAI ? <em className="tag">AI</em> : null}
        {player.connected ? null : <em className="tag warn">离线</em>}
      </div>
      <div className="muted small">{characterName}</div>
      <div className="player-money">{money(player.money)}</div>
      {tiles.length === 0 ? (
        <div className="muted small">暂无地产</div>
      ) : (
        <div className="muted small">地产 {tiles.length} 处</div>
      )}
      {player.statuses.length === 0 ? null : (
        <div className="status-row">
          {player.statuses.map((status) => (
            <em key={status.status} className="tag">
              {status.status} · {status.remainingTurns}
            </em>
          ))}
        </div>
      )}
    </li>
  );
}

function ActionBar({
  state,
  localPlayerId,
  characters,
  dispatch,
}: {
  state: GameState;
  localPlayerId: string | null;
  characters: readonly Character[];
  dispatch: (intent: ClientIntent) => void;
}) {
  const active = state.players[state.activePlayerIndex];
  const isMyTurn = localPlayerId !== null && active?.id === localPlayerId;
  const me = state.players.find((player) => player.id === localPlayerId) ?? null;
  const pending = state.pendingChoice;
  const mine = pending !== null && pending.playerId === localPlayerId;
  // Captured as consts so the narrowing survives into the click handlers.
  const buyTileId = pending?.kind === 'BUY_PROPERTY' ? pending.tileId : undefined;
  const upgradeTileId = pending?.kind === 'UPGRADE_PROPERTY' ? pending.tileId : undefined;

  const character = characters.find((entry) => entry.id === me?.characterId);
  const activeSkill =
    character !== undefined && character.skill.type === 'ACTIVE' ? character.skill : null;
  const onCooldown = activeSkill !== null && (me?.skillCooldowns[activeSkill.id] ?? 0) > 0;

  const minigame = state.minigame;
  const mySubmission =
    minigame === null || localPlayerId === null ? undefined : minigame.submissions[localPlayerId];
  const inMinigame =
    minigame !== null && localPlayerId !== null && minigame.participantIds.includes(localPlayerId);

  return (
    <div className="action-bar">
      {state.phase === 'AWAIT_ROLL' && isMyTurn ? (
        <button
          type="button"
          className="button-primary"
          onClick={() => dispatch({ type: 'INTENT_ROLL' } as ClientIntent)}
        >
          掷骰子
        </button>
      ) : null}

      {mine && buyTileId !== undefined ? (
        <>
          <span className="muted">买下 {buyTileId}？</span>
          <button
            type="button"
            className="button-primary"
            onClick={() =>
              dispatch({ type: 'INTENT_BUY', payload: { tileId: buyTileId } } as ClientIntent)
            }
          >
            购买
          </button>
          <button
            type="button"
            onClick={() =>
              dispatch({
                type: 'INTENT_CHOICE',
                payload: { choice: 'BUY_PROPERTY', option: 'DECLINE' },
              } as ClientIntent)
            }
          >
            放弃
          </button>
        </>
      ) : null}

      {mine && upgradeTileId !== undefined ? (
        <>
          <span className="muted">升级 {upgradeTileId}？</span>
          <button
            type="button"
            className="button-primary"
            onClick={() =>
              dispatch({
                type: 'INTENT_UPGRADE',
                payload: { tileId: upgradeTileId },
              } as ClientIntent)
            }
          >
            升级
          </button>
          <button
            type="button"
            onClick={() =>
              dispatch({
                type: 'INTENT_CHOICE',
                payload: { choice: 'UPGRADE_PROPERTY', option: 'SKIP' },
              } as ClientIntent)
            }
          >
            跳过
          </button>
        </>
      ) : null}

      {mine && pending?.kind === 'CENTER_EXIT' && pending.nodeId !== undefined ? (
        <button
          type="button"
          className="button-primary"
          onClick={() =>
            dispatch({
              type: 'INTENT_ENTER_CENTER',
              payload: { nodeId: pending.nodeId ?? '' },
            } as ClientIntent)
          }
        >
          返回环线
        </button>
      ) : null}

      {inMinigame && minigame !== null && mySubmission === undefined
        ? (MINIGAME_ACTIONS[minigame.kind] ?? []).map((entry) => (
            <button
              key={entry.action}
              type="button"
              className="button-primary"
              onClick={() =>
                dispatch({
                  type: 'INTENT_MINIGAME_ACTION',
                  payload: { minigameId: minigame.minigameId, action: entry.action },
                } as ClientIntent)
              }
            >
              {entry.label}
            </button>
          ))
        : null}

      {inMinigame && mySubmission !== undefined ? (
        <span className="muted">已提交 {mySubmission}，等待其他玩家…</span>
      ) : null}

      {isMyTurn && state.phase === 'AWAIT_END_TURN' && activeSkill !== null ? (
        <button
          type="button"
          disabled={onCooldown}
          title={activeSkill.desc}
          onClick={() =>
            dispatch({
              type: 'INTENT_USE_SKILL',
              payload: { skillId: activeSkill.id },
            } as ClientIntent)
          }
        >
          {activeSkill.name}
          {onCooldown ? `（冷却 ${me?.skillCooldowns[activeSkill.id] ?? 0}）` : ''}
        </button>
      ) : null}

      {isMyTurn && state.phase === 'AWAIT_END_TURN' ? (
        <button type="button" onClick={() => dispatch({ type: 'INTENT_END_TURN' } as ClientIntent)}>
          结束回合
        </button>
      ) : null}

      {state.phase !== 'GAME_OVER' && !isMyTurn && !inMinigame ? (
        <span className="muted">
          {active?.nickname ?? '等待'} 正在行动（{PHASE_LABELS[state.phase] ?? state.phase}）
        </span>
      ) : null}
    </div>
  );
}

function MiniGamePanel({ state }: { state: GameState }) {
  const minigame = state.minigame;
  if (minigame === null) return null;
  return (
    <div className="overlay-card">
      <h2>中央小游戏</h2>
      <p className="muted">
        {minigame.kind} · 参与者 {minigame.participantIds.length} 人
      </p>
      <ul className="submit-list">
        {minigame.participantIds.map((id) => {
          const player = state.players.find((entry) => entry.id === id);
          const submitted = minigame.submissions[id];
          return (
            <li key={id}>
              <span>{player?.nickname ?? id}</span>
              <span className="muted">{submitted === undefined ? '思考中…' : `已提交`}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ResultOverlay({
  state,
  localPlayerId,
  onExit,
}: {
  state: GameState;
  localPlayerId: string | null;
  onExit: () => void;
}) {
  if (state.phase !== 'GAME_OVER') return null;
  const winner = state.players.find((player) => player.id === state.winnerId) ?? null;
  const standings = [...state.players].sort((a, b) => b.money - a.money);
  const won = winner !== null && winner.id === localPlayerId;
  return (
    <div className="overlay">
      <div className="overlay-card">
        <h2>{won ? '你赢了' : `${winner?.nickname ?? '无人'} 获胜`}</h2>
        <ol className="standings">
          {standings.map((player, index) => (
            <li key={player.id}>
              <span>
                {index + 1}. {player.nickname}
              </span>
              <span>{money(player.money)}</span>
            </li>
          ))}
        </ol>
        <button type="button" className="button-primary" onClick={onExit}>
          回到主菜单
        </button>
      </div>
    </div>
  );
}

export function GameScreen({
  map,
  characters,
  theme,
  snapshot,
  modelUrls,
  shadows,
  shadowMapSize,
  localPlayerId,
  dispatch,
  onPause,
}: GameScreenProps) {
  const { state, events, lastRoll } = snapshot;
  const [feedOpen, setFeedOpen] = useState(false);

  const characterNames = useMemo(() => {
    const table = new Map(characters.map((character) => [character.id, character.name]));
    return (id: string) => table.get(id) ?? id;
  }, [characters]);

  const recent = events.slice(-30).reverse();
  const active = state.players[state.activePlayerIndex];

  return (
    <div className="game-root">
      <Canvas
        shadows={shadows}
        dpr={[1, 2]}
        camera={cameraPose()}
        gl={{ antialias: true }}
        style={{ position: 'absolute', inset: 0 }}
      >
        <Suspense fallback={null}>
          <Board
            map={map}
            state={state}
            theme={theme}
            modelUrls={modelUrls}
            shadows={shadows}
            shadowMapSize={shadowMapSize}
            lastRoll={lastRoll}
          />
        </Suspense>
      </Canvas>

      <header className="game-top">
        <div className="turn-pill">
          <strong>第 {state.turn} 回合</strong>
          <span className="muted">
            {active === undefined ? '—' : `${active.nickname} 行动`} ·{' '}
            {PHASE_LABELS[state.phase] ?? state.phase}
          </span>
        </div>
        <div className="game-top-actions">
          <button type="button" onClick={() => setFeedOpen((open) => !open)}>
            战报
          </button>
          <button type="button" onClick={onPause}>
            菜单
          </button>
        </div>
      </header>

      <aside className="player-rail">
        <ul>
          {state.players.map((player) => (
            <PlayerCard
              key={player.id}
              player={player}
              state={state}
              isActive={player.id === active?.id}
              isLocal={player.id === localPlayerId}
              characterName={characterNames(player.characterId)}
            />
          ))}
        </ul>
      </aside>

      <footer className="game-bottom">
        <ActionBar
          state={state}
          localPlayerId={localPlayerId}
          characters={characters}
          dispatch={dispatch}
        />
      </footer>

      {feedOpen ? (
        <aside className="feed-panel">
          <header>
            <strong>战报</strong>
            <button type="button" onClick={() => setFeedOpen(false)}>
              收起
            </button>
          </header>
          <ol>
            {recent.map((event) => (
              <li key={event.seq}>
                <span className="muted">R{event.turn}</span> {event.type}
              </li>
            ))}
          </ol>
        </aside>
      ) : null}

      <MiniGamePanel state={state} />
      <ResultOverlay state={state} localPlayerId={localPlayerId} onExit={onPause} />
    </div>
  );
}
