import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { CONTENT_PACK, CITY_METRO, THEME_TOKENS } from '@/content';
import type { RoomConfig, Settings } from '@/engine/contracts/config';
import { DEFAULT_ROOM_CONFIG } from '@/engine/contracts/config';
import { ClientSession } from '@/net/client';
import { isValidRoomId } from '@/lib/room-code';
import { HostSession, MAX_PLAYERS } from '@/net/host';
import { makeRoomCredentials } from '@/net/credentials';
import { createAudioDirector, type AudioDirector, type SfxKind } from '@/audio';
import { createSettingsStore, qualityPreset, QUALITY_LABELS } from '@/settings';

import { createGameTable, type GameTable } from '@/app/session';
import {
  createClientTable,
  createHostTable,
  type ClientTable,
  type HostTable,
} from '@/app/netTable';
import { useTable } from '@/app/useTable';
import { assetUrl, isMeshAsset, loadManifest } from '@/ui/assets/manifest';
import {
  DURATION_NOTE,
  MenuScreen,
  OnlineScreen,
  RulesScreen,
  Screen,
  SettingsScreen,
  SoloSetupScreen,
} from '@/ui/screens';

/**
 * The board pulls in three.js and drei, which dwarf the rest of the app. Loading
 * it only when a table exists keeps the menu path inside the first-screen budget
 * (CON-005) instead of shipping a megabyte of renderer to the title screen.
 */
const GameScreen = lazy(async () => {
  const module = await import('@/ui/game');
  return { default: module.GameScreen };
});

type Route = 'menu' | 'solo' | 'online' | 'lobby' | 'game' | 'settings' | 'rules';

const settingsStore = createSettingsStore();

const SFX_FOR_EVENT: Record<string, SfxKind> = {
  DICE_ROLLED: 'DICE',
  PLAYER_MOVED: 'MOVE',
  PLAYER_WARPED: 'MOVE',
  PLAYER_TELEPORTED: 'MOVE',
  POSITIONS_SWAPPED: 'MOVE',
  PROPERTY_BOUGHT: 'BUY',
  PROPERTY_UPGRADED: 'BUY',
  PROPERTY_MORTGAGED: 'CLICK',
  PROPERTY_REDEEMED: 'CLICK',
  RENT_DUE: 'PAY',
  TAX_DUE: 'PAY',
  MONEY_PAID: 'PAY',
  SALARY_PAID: 'WIN',
  BONUS_GRANTED: 'WIN',
  CHAOS: 'CHAOS',
  CHAOS_DRAWN: 'CHAOS',
  PLAYER_JAILED: 'LOSE',
  SKILL_USED: 'CHAOS',
  SKILL_TRIGGERED: 'CHAOS',
  MINIGAME_STARTED: 'MINIGAME',
  MINIGAME_FORCED: 'MINIGAME',
  MINIGAME_FINISHED: 'MINIGAME',
  PLAYER_BANKRUPT: 'LOSE',
  GAME_OVER: 'WIN',
};

let director: AudioDirector | null = null;
function audio(): AudioDirector {
  director ??= createAudioDirector();
  return director;
}

function useSettings() {
  const [settings, setSettings] = useState<Settings>(() => settingsStore.get());
  useEffect(() => settingsStore.subscribe(() => setSettings(settingsStore.get())), []);
  useEffect(() => {
    audio().applySettings({
      bgmVolume: settings.bgmVolume,
      sfxVolume: settings.sfxVolume,
      muted: settings.muted,
    });
  }, [settings.bgmVolume, settings.sfxVolume, settings.muted]);
  const update = useCallback((patch: Partial<Omit<Settings, 'v'>>) => {
    settingsStore.update(patch);
  }, []);
  return { settings, update };
}

export default function App() {
  const { settings, update } = useSettings();
  const sharedRoomId = useMemo(() => new URLSearchParams(window.location.search).get('room'), []);
  const [route, setRoute] = useState<Route>(sharedRoomId === null ? 'menu' : 'online');
  const [manifestUrls, setManifestUrls] = useState<Record<string, string> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [nickname, setNickname] = useState(settings.nickname);
  const [characterId, setCharacterId] = useState(CONTENT_PACK.characters[0]?.id ?? '');
  const [config, setConfig] = useState<RoomConfig>(DEFAULT_ROOM_CONFIG);
  const [roomCodeInput, setRoomCodeInput] = useState(sharedRoomId ?? '');
  const [busy, setBusy] = useState(false);

  const [solo, setSolo] = useState<GameTable | null>(null);
  const [hostTable, setHostTable] = useState<HostTable | null>(null);
  const [clientTable, setClientTable] = useState<ClientTable | null>(null);
  const [onlineError, setOnlineError] = useState<string | null>(null);

  const modelUrls = useMemo(() => {
    const map: Record<string, string> = {};
    for (const character of CONTENT_PACK.characters) {
      map[character.modelRef] = `/models/${character.modelRef}.glb`;
    }
    for (const key of new Set(CITY_METRO.assets)) {
      map[key] = `/models/${key}.glb`;
    }
    return map;
  }, []);

  useEffect(() => {
    if (manifestUrls !== null) return;
    let cancelled = false;
    loadManifest()
      .then((manifest) => {
        if (cancelled) return;
        const urls: Record<string, string> = {};
        for (const asset of manifest.assets) {
          if (!isMeshAsset(asset)) continue;
          urls[asset.key] = assetUrl(asset);
        }
        setManifestUrls(urls);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        // Leave the manifest unset rather than empty: `urls` then falls back to
        // the direct /models/... paths, so a manifest problem degrades the
        // board instead of blanking it.
        setError(`模型清单加载失败，已改用默认路径：${String(cause)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [manifestUrls]);

  /* Unlock audio on the first gesture, per browser autoplay policy. */
  useEffect(() => {
    const unlock = (): void => {
      void audio().unlock();
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    return () => window.removeEventListener('pointerdown', unlock);
  }, []);

  /* Dispose whatever table is active when it is replaced or unmounted. */
  useEffect(() => () => solo?.dispose(), [solo]);
  useEffect(() => () => hostTable?.stop(), [hostTable]);
  useEffect(() => () => clientTable?.close(), [clientTable]);

  const preset = qualityPreset(settings.quality);
  const urls = manifestUrls ?? modelUrls;

  const startSolo = useCallback(() => {
    const characters = CONTENT_PACK.characters;
    const human = characters.find((entry) => entry.id === characterId) ?? characters[0];
    if (human === undefined) return;
    const others = characters.filter((entry) => entry.id !== human.id);
    const seats = [
      {
        id: 'p1',
        nickname: nickname.trim() === '' ? '玩家' : nickname.trim(),
        characterId: human.id,
        isAI: false,
      },
      ...others.map((entry, index) => ({
        id: `p${index + 2}`,
        nickname: `电脑${index + 1}`,
        characterId: entry.id,
        isAI: true,
      })),
    ];
    try {
      const table = createGameTable({
        content: {
          map: CITY_METRO,
          characters: CONTENT_PACK.characters,
          chaosEvents: CONTENT_PACK.chaosEvents,
          miniGames: CONTENT_PACK.miniGames,
        },
        roomConfig: config,
        seats,
        seed: `solo-${Date.now()}`,
      });
      setSolo(table);
      setError(null);
      setRoute('game');
    } catch (cause: unknown) {
      setError(`无法开局：${String(cause)}`);
    }
  }, [characterId, config, nickname]);

  const soloSnapshot = useTable(solo);
  const hostSnapshot = useTable(hostTable);
  const clientSnapshot = useTable(clientTable);

  const createRoom = useCallback(() => {
    setBusy(true);
    setOnlineError(null);
    const credentials = makeRoomCredentials();
    if (credentials === null) {
      setBusy(false);
      setOnlineError('浏览器不支持安全随机数，无法创建房间。');
      return;
    }
    const characters = CONTENT_PACK.characters;
    const human = characters.find((entry) => entry.id === characterId) ?? characters[0];
    const table = createHostTable({
      createHost: (hooks) => {
        const session = new HostSession({
          credentials,
          pack: CONTENT_PACK,
          map: CITY_METRO,
          roomConfig: config,
          hostNickname: nickname.trim() === '' ? '房主' : nickname.trim(),
          hostCharacterId: human?.id,
          onEvent: (event) => hooks.onEvent(event),
          onStateChanged: () => hooks.onStateChanged(),
          onJoinRequest: (request) => hooks.onJoinRequest(request),
          onError: (code, detail) => setOnlineError(`${code}: ${detail}`),
        });
        session.start();
        return session;
      },
    });
    setHostTable(table);
    setBusy(false);
    setRoute('lobby');
  }, [characterId, config, nickname]);

  const joinRoom = useCallback(() => {
    setBusy(true);
    setOnlineError(null);
    const table = createClientTable({
      createClient: (hooks) =>
        new ClientSession({
          nickname: nickname.trim() === '' ? '玩家' : nickname.trim(),
          characterId,
          onStatus: (status) => hooks.onStatus(status),
          onState: (state) => hooks.onState(state),
          onEvent: (event) => hooks.onEvent(event),
          onRoomInfo: (info) => hooks.onRoomInfo(info),
          onRejected: (reason) => hooks.onRejected(reason),
          onError: (code, detail) => {
            setOnlineError(
              code === 'ice-failed' || code === 'peer-unavailable' || code === 'timeout'
                ? '网络不支持点对点联机，请换一个网络后重试。'
                : `${code}: ${detail}`,
            );
          },
        }),
    });
    setClientTable(table);
    // A share link carries the full invite token, which doubles as an
    // automatic admission credential; a typed code only locates the host and
    // must be approved. Sending a 21 character invite as a room code would be
    // rejected outright.
    const target = isValidRoomId(roomCodeInput)
      ? { roomId: roomCodeInput }
      : { roomCode: roomCodeInput };
    table.client
      .connect(target)
      .then((result) => {
        setBusy(false);
        if (result.ok) setRoute('lobby');
        else setOnlineError(`加入失败：${result.reason ?? '未知原因'}`);
      })
      .catch((cause: unknown) => {
        setBusy(false);
        setOnlineError(`加入失败：${String(cause)}`);
      });
  }, [characterId, nickname, roomCodeInput]);

  const activeTable = solo ?? hostTable ?? clientTable;
  const localPlayerId =
    solo !== null
      ? 'p1'
      : hostTable !== null
        ? (hostTable.host.state.players[0]?.id ?? null)
        : (clientTable?.playerId() ?? null);

  const snapshot = soloSnapshot ?? hostSnapshot ?? clientSnapshot;

  // A joiner has no start button of its own, so the room leaving SETUP is the
  // host's signal that the game began. Deriving this rather than syncing it in
  // an effect keeps the route a pure function of what the host has published.
  const effectiveRoute: Route =
    route === 'lobby' &&
    clientTable !== null &&
    clientSnapshot !== null &&
    clientSnapshot.state.phase !== 'SETUP'
      ? 'game'
      : route;

  /* The score follows the route: it plays only while a game is on screen. */
  useEffect(() => {
    if (effectiveRoute === 'game' || effectiveRoute === 'solo') audio().startBgm();
    else audio().stopBgm();
  }, [effectiveRoute]);

  /* Sound the events that have arrived since the last render. The event list is
     cumulative, so a cursor rather than a diff keeps a re-render silent. */
  const sounded = useRef(0);
  const table = solo ?? hostTable ?? clientTable;
  useEffect(() => {
    sounded.current = 0;
  }, [table]);
  useEffect(() => {
    const events = snapshot?.events ?? [];
    if (events.length < sounded.current) sounded.current = 0;
    const fresh = events.slice(sounded.current);
    sounded.current = events.length;
    for (const event of fresh) {
      const kind = SFX_FOR_EVENT[event.type];
      if (kind !== undefined) audio().playSfx(kind);
    }
  }, [snapshot]);

  const exitToMenu = useCallback(() => {
    setSolo(null);
    setHostTable(null);
    setClientTable(null);
    setRoute('menu');
  }, []);

  if ((effectiveRoute === 'game' || effectiveRoute === 'lobby') && snapshot !== null) {
    if (effectiveRoute === 'game') {
      return (
        <Suspense fallback={<div className="screen">正在准备棋盘…</div>}>
          <GameScreen
            map={CITY_METRO}
            characters={CONTENT_PACK.characters}
            theme={THEME_TOKENS}
            snapshot={snapshot}
            modelUrls={urls}
            shadows={preset.shadows}
            shadowMapSize={preset.shadowMapSize}
            localPlayerId={localPlayerId}
            dispatch={(intent) => activeTable?.dispatch(intent)}
            onPause={exitToMenu}
          />
        </Suspense>
      );
    }
  }

  if (effectiveRoute === 'lobby' && (hostTable !== null || clientTable !== null)) {
    const room = hostTable?.info() ?? null;
    const info = clientTable?.info() ?? null;
    const shareUrl = room === null ? null : `${window.location.origin}/?room=${room.roomId}`;
    const players = room?.players ?? [];

    return (
      <Screen
        title="房间大厅"
        subtitle={
          hostTable === null ? '等待房主开始游戏…' : '把邀请链接发给朋友，或让他们输入房间码。'
        }
        wide
        actions={
          <>
            <button type="button" onClick={exitToMenu}>
              离开房间
            </button>
            {hostTable === null ? null : (
              <button
                type="button"
                className="button-primary"
                onClick={() => {
                  const result = hostTable.begin();
                  if (!result.ok) setOnlineError(`无法开始：${result.reason}`);
                  else setRoute('game');
                }}
              >
                开始游戏
              </button>
            )}
          </>
        }
      >
        {room === null ? null : (
          <div className="lobby-share">
            <div className="field">
              <span>房间码</span>
              <strong className="room-code">{room.roomCode}</strong>
            </div>
            <div className="field">
              <span>邀请链接</span>
              <div className="inline-row">
                <input type="text" readOnly value={shareUrl ?? ''} />
                <button
                  type="button"
                  onClick={() => {
                    if (shareUrl !== null) void navigator.clipboard?.writeText(shareUrl);
                  }}
                >
                  复制
                </button>
              </div>
            </div>
          </div>
        )}

        {info === null ? null : (
          <p className="muted small">
            已连接到房间 {info.roomCode}，地图 {info.mapId}。
          </p>
        )}

        <h2>
          桌上的玩家（{players.length}/{MAX_PLAYERS}）
        </h2>
        <ul className="lobby-players">
          {players.map((player) => (
            <li key={player.id}>
              <span>{player.nickname}</span>
              {player.isAI ? <em className="tag">AI</em> : null}
              {player.connected ? null : <em className="tag warn">离线</em>}
            </li>
          ))}
          {clientTable === null
            ? null
            : clientSnapshot?.state.players.map((player) => (
                <li key={player.id}>
                  <span>{player.nickname}</span>
                </li>
              ))}
        </ul>

        {hostTable !== null && hostTable.requests().length > 0 ? (
          <>
            <h2>加入请求</h2>
            <ul className="lobby-players">
              {hostTable.requests().map((request) => (
                <li key={request.connectionPeerId}>
                  <span>{request.nickname}</span>
                  <button
                    type="button"
                    onClick={() => hostTable.decideRequest(request.connectionPeerId, true)}
                  >
                    同意
                  </button>
                  <button
                    type="button"
                    onClick={() => hostTable.decideRequest(request.connectionPeerId, false)}
                  >
                    拒绝
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : null}

        {hostTable === null ? null : (
          <>
            <h2>开局设置</h2>
            <div className="preset-row">
              <div className="field">
                <span>事件频率</span>
                <select
                  value={room?.config.eventRate ?? 'MEDIUM'}
                  onChange={(event) =>
                    hostTable.setConfig({
                      ...(room?.config ?? config),
                      eventRate: event.target.value as RoomConfig['eventRate'],
                    })
                  }
                >
                  <option value="LOW">低</option>
                  <option value="MEDIUM">中</option>
                  <option value="HIGH">高</option>
                </select>
              </div>
              <div className="field">
                <span>胜利条件</span>
                <select
                  value={room?.config.victory.kind ?? 'ASSET_TARGET'}
                  onChange={(event) => {
                    const base = room?.config ?? config;
                    hostTable.setConfig({
                      ...base,
                      victory:
                        event.target.value === 'ASSET_TARGET'
                          ? { kind: 'ASSET_TARGET', value: 3 }
                          : { kind: 'TURN_LIMIT', value: 90 },
                    });
                  }}
                >
                  <option value="ASSET_TARGET">资产达标</option>
                  <option value="TURN_LIMIT">回合上限</option>
                </select>
              </div>
              <div className="field">
                <span>数值</span>
                <select
                  value={room?.config.victory.value ?? 3}
                  onChange={(event) =>
                    hostTable.setConfig({
                      ...(room?.config ?? config),
                      victory: {
                        ...(room?.config ?? config).victory,
                        value: Number(event.target.value),
                      } as RoomConfig['victory'],
                    })
                  }
                >
                  {(room?.config.victory.kind === 'TURN_LIMIT'
                    ? [30, 90, 180, 365, 730]
                    : [2, 3, 5, 10]
                  ).map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <span>补位</span>
                <button type="button" onClick={() => hostTable.addAi()}>
                  添加 AI 玩家
                </button>
              </div>
            </div>
            <p className="muted small">{DURATION_NOTE}</p>
          </>
        )}

        {onlineError === null ? null : <p className="error">{onlineError}</p>}
      </Screen>
    );
  }

  if (effectiveRoute === 'solo') {
    return (
      <SoloSetupScreen
        characters={CONTENT_PACK.characters}
        nickname={nickname}
        onNickname={setNickname}
        characterId={characterId}
        onCharacter={setCharacterId}
        config={config}
        onConfig={setConfig}
        onStart={startSolo}
        onBack={() => setRoute('menu')}
      />
    );
  }

  if (effectiveRoute === 'online') {
    return (
      <OnlineScreen
        mode="join"
        nickname={nickname}
        onNickname={setNickname}
        roomCode={roomCodeInput}
        onRoomCode={setRoomCodeInput}
        busy={busy}
        error={onlineError}
        onCreate={createRoom}
        onJoin={joinRoom}
        onBack={() => setRoute('menu')}
      />
    );
  }

  if (effectiveRoute === 'settings') {
    return (
      <SettingsScreen
        settings={settings}
        qualityPresets={(['LOW', 'MEDIUM', 'HIGH'] as const).map((level) => ({
          level,
          label: QUALITY_LABELS[level],
        }))}
        onChange={update}
        onReset={() => settingsStore.reset()}
        onBack={() => setRoute('menu')}
      />
    );
  }

  if (effectiveRoute === 'rules') {
    return <RulesScreen onBack={() => setRoute('menu')} />;
  }

  return (
    <>
      <MenuScreen
        onSolo={() => setRoute('solo')}
        onOnline={() => setRoute('online')}
        onSettings={() => setRoute('settings')}
        onRules={() => setRoute('rules')}
      />
      {error === null ? null : <p className="error banner">{error}</p>}
    </>
  );
}
