import { describe, expect, it } from 'vitest';
import type { ClientIntentMessage } from '../src/engine/contracts/net';
import {
  applyIntent,
  resolveCurrentLanding,
  sessionNetWorth,
  startGame,
} from '../src/engine/reducer';
import type { GameSession } from '../src/engine/reducer';
import {
  makeSession,
  ownTile,
  patchSession,
  placeInCenter,
  placeOnRing,
  setMoney,
  TEST_MINIGAMES,
} from './fixtures/content';

let sequence = 0;

function msg<T extends ClientIntentMessage['type']>(
  type: T,
  from: string,
  payload: Extract<ClientIntentMessage, { type: T }>['payload'],
): ClientIntentMessage {
  sequence += 1;
  return { v: 1, type, seq: sequence, from, payload } as ClientIntentMessage;
}

function moneyOf(session: GameSession, playerId: string): number {
  return session.state.players.find((player) => player.id === playerId)?.money ?? Number.NaN;
}

function boot(): GameSession {
  const started = startGame(makeSession());
  expect(started.rejected).toBeNull();
  return started.session;
}

describe('game setup', () => {
  it('starts from SETUP and hands the turn to the first player', () => {
    const session = boot();
    expect(session.state.phase).toBe('AWAIT_ROLL');
    expect(session.state.turn).toBe(1);
    expect(session.state.players[session.state.activePlayerIndex]?.id).toBe('p1');
  });

  it('applies an ON_TURN_START passive for the first player', () => {
    expect(moneyOf(boot(), 'p1')).toBe(20_200);
  });

  it('refuses duplicate character picks', () => {
    const session = makeSession();
    const result = applyIntent(
      session,
      msg('INTENT_SELECT_CHARACTER', 'p2', { characterId: 'char_farmer' }),
    );
    expect(result.rejected).toBe('character-taken');
    expect(result.events.some((event) => event.type === 'CHARACTER_TAKEN')).toBe(true);
  });

  it('refuses to start with duplicate characters', () => {
    const session = makeSession({
      players: [
        { id: 'p1', nickname: 'a', characterId: 'char_farmer', isAI: false },
        { id: 'p2', nickname: 'b', characterId: 'char_farmer', isAI: true },
      ],
    });
    expect(startGame(session).rejected).toBe('duplicate-characters');
  });
});

describe('turn guards', () => {
  it('rejects a roll from a player who is not active', () => {
    const session = boot();
    const result = applyIntent(session, msg('INTENT_ROLL', 'p2', {}));
    expect(result.rejected).toBe('not-your-turn');
    expect(result.session.state).toBe(session.state);
  });

  it('rejects an intent that does not match the phase', () => {
    const session = boot();
    expect(applyIntent(session, msg('INTENT_END_TURN', 'p1', {})).rejected).toBe(
      'not-awaiting-end-turn',
    );
    expect(applyIntent(session, msg('INTENT_BUY', 'p1', { tileId: 't1' })).rejected).toBe(
      'no-purchase-pending',
    );
  });
});

describe('rolling and movement', () => {
  it('rolls a die, advances the cursor and resolves the landing', () => {
    const session = boot();
    const result = applyIntent(session, msg('INTENT_ROLL', 'p1', {}));
    expect(result.rejected).toBeNull();
    expect(result.events.some((event) => event.type === 'DICE_ROLLED')).toBe(true);
    expect(result.session.state.rngCursor).toBeGreaterThan(session.state.rngCursor);
    expect(['AWAIT_CHOICE', 'AWAIT_END_TURN', 'MINIGAME', 'GAME_OVER']).toContain(
      result.session.state.phase,
    );
  });
});

describe('property economy', () => {
  it('buys an unowned property and debits the price', () => {
    let session = boot();
    session = placeOnRing(session, 'p1', 1);
    const landing = resolveCurrentLanding(session, 'p1');
    expect(landing.session.state.pendingChoice?.kind).toBe('BUY_PROPERTY');
    const before = moneyOf(landing.session, 'p1');
    const bought = applyIntent(landing.session, msg('INTENT_BUY', 'p1', { tileId: 't1' }));
    expect(bought.rejected).toBeNull();
    expect(moneyOf(bought.session, 'p1')).toBe(before - 600);
    expect(bought.session.state.board.tiles['t1']?.ownerId).toBe('p1');
    expect(bought.session.state.players.find((player) => player.id === 'p1')?.properties).toEqual([
      { tileId: 't1', level: 0, mortgaged: false },
    ]);
  });

  it('rejects a purchase the player cannot afford', () => {
    let session = boot();
    session = placeOnRing(session, 'p1', 4);
    session = setMoney(session, 'p1', 100);
    const landing = resolveCurrentLanding(session, 'p1');
    const result = applyIntent(landing.session, msg('INTENT_BUY', 'p1', { tileId: 't4' }));
    expect(result.rejected).toBe('insufficient-funds');
  });

  it('charges rent with the owner RENT_BOOST applied', () => {
    let session = boot();
    session = ownTile(session, 't2', 'p3', 0);
    session = placeOnRing(session, 'p1', 2);
    const before = moneyOf(session, 'p1');
    const ownerBefore = moneyOf(session, 'p3');
    const result = resolveCurrentLanding(session, 'p1');
    // base rent 60, madame skill +20% => 72
    expect(moneyOf(result.session, 'p1')).toBe(before - 72);
    expect(moneyOf(result.session, 'p3')).toBe(ownerBefore + 72);
  });

  it('collects no rent while the property is mortgaged', () => {
    let session = boot();
    session = ownTile(session, 't2', 'p3', 0, true);
    session = placeOnRing(session, 'p1', 2);
    const before = moneyOf(session, 'p1');
    const result = resolveCurrentLanding(session, 'p1');
    expect(moneyOf(result.session, 'p1')).toBe(before);
  });

  it('upgrades a property up to the maximum level', () => {
    let session = boot();
    session = ownTile(session, 't1', 'p1', 0);
    session = placeOnRing(session, 'p1', 1);
    const landing = resolveCurrentLanding(session, 'p1');
    expect(landing.session.state.pendingChoice?.kind).toBe('UPGRADE_PROPERTY');
    const before = moneyOf(landing.session, 'p1');
    const upgraded = applyIntent(landing.session, msg('INTENT_UPGRADE', 'p1', { tileId: 't1' }));
    expect(upgraded.rejected).toBeNull();
    // level 0 -> 1 costs price * 0.5 * 1
    expect(moneyOf(upgraded.session, 'p1')).toBe(before - 300);
    expect(upgraded.session.state.board.tiles['t1']?.level).toBe(1);
  });

  it('does not inflate net worth when a property is mortgaged', () => {
    const owned = ownTile(boot(), 't4', 'p1', 0);
    const withProperty = sessionNetWorth(owned, 'p1');
    const mortgaged = applyIntent(owned, msg('INTENT_MORTGAGE', 'p1', { tileId: 't4' }));
    expect(mortgaged.rejected).toBeNull();
    expect(sessionNetWorth(mortgaged.session, 'p1')).toBe(withProperty);
  });

  it('mortgages and redeems a property', () => {
    const session = ownTile(boot(), 't4', 'p1', 0);
    const before = moneyOf(session, 'p1');
    const mortgaged = applyIntent(session, msg('INTENT_MORTGAGE', 'p1', { tileId: 't4' }));
    expect(mortgaged.rejected).toBeNull();
    expect(moneyOf(mortgaged.session, 'p1')).toBe(before + 500);
    expect(mortgaged.session.state.board.tiles['t4']?.mortgaged).toBe(true);
    expect(
      applyIntent(mortgaged.session, msg('INTENT_MORTGAGE', 'p1', { tileId: 't4' })).rejected,
    ).toBe('already-mortgaged');

    const redeemBefore = moneyOf(mortgaged.session, 'p1');
    const redeemed = applyIntent(mortgaged.session, msg('INTENT_REDEEM', 'p1', { tileId: 't4' }));
    expect(redeemed.rejected).toBeNull();
    expect(moneyOf(redeemed.session, 'p1')).toBe(redeemBefore - 550);
    expect(redeemed.session.state.board.tiles['t4']?.mortgaged).toBe(false);
  });
});

describe('board effects', () => {
  it('pays a start bonus and a bonus tile', () => {
    const bonus = resolveCurrentLanding(placeOnRing(boot(), 'p1', 9), 'p1');
    expect(bonus.events.some((event) => event.type === 'BONUS_GRANTED')).toBe(true);
  });

  it('charges tax proportional to cash', () => {
    let session = boot();
    session = setMoney(session, 'p1', 10_000);
    const result = resolveCurrentLanding(placeOnRing(session, 'p1', 5), 'p1');
    expect(result.events.some((event) => event.type === 'TAX_DUE')).toBe(true);
    expect(moneyOf(result.session, 'p1')).toBe(9_000);
  });

  it('jails the player for the configured number of turns', () => {
    const result = resolveCurrentLanding(placeOnRing(boot(), 'p1', 6), 'p1');
    expect(result.session.state.players.find((player) => player.id === 'p1')?.skipTurns).toBe(2);
  });

  it('always draws a chaos event when the trigger chance is 1', () => {
    const session = placeOnRing(boot(), 'p1', 10);
    const result = resolveCurrentLanding(session, 'p1');
    expect(result.events.some((event) => event.type === 'CHAOS_DRAWN')).toBe(true);
    expect(result.session.state.rngCursor).toBe(session.state.rngCursor + 2);
  });

  it('warps into the centre and back to the entry tile', () => {
    const session = placeOnRing(boot(), 'p1', 7);
    const result = resolveCurrentLanding(session, 'p1');
    const player = result.session.state.players.find((entry) => entry.id === 'p1');
    expect(result.events.some((event) => event.type === 'PLAYER_WARPED')).toBe(true);
    expect(['t7', undefined]).toContain(
      player?.position.zone === 'center' ? player.position.entryTileId : undefined,
    );
  });

  it('runs a mini-game and returns the player to the ring', () => {
    let session = resolveCurrentLanding(placeOnRing(boot(), 'p1', 11), 'p1').session;
    expect(session.state.phase).toBe('MINIGAME');
    expect(session.state.minigame?.kind).toBe(TEST_MINIGAMES[0]!.kind);

    for (const playerId of session.state.minigame?.participantIds ?? []) {
      const action = session.state.minigame?.kind === 'RPS' ? 'ROCK' : 'SPIN';
      const result = applyIntent(
        session,
        msg('INTENT_MINIGAME_ACTION', playerId, {
          minigameId: session.state.minigame?.minigameId ?? '',
          action,
        }),
      );
      expect(result.rejected).toBeNull();
      session = result.session;
    }

    expect(session.state.minigame).toBeNull();
    expect(['AWAIT_END_TURN', 'AWAIT_CHOICE']).toContain(session.state.phase);
    expect(session.state.players.find((player) => player.id === 'p1')?.position.zone).toBe('ring');
  });

  it('refuses a centre exit from a player the engine is not waiting on', () => {
    const session = patchSession(placeInCenter(boot(), 'p1', 'c_plaza'), (state) => ({
      ...state,
      activePlayerIndex: 1,
      pendingChoice: null,
    }));
    expect(applyIntent(session, msg('INTENT_ENTER_CENTER', 'p1', { nodeId: 't0' })).rejected).toBe(
      'not-your-turn',
    );
  });

  it('requires an explicit exit when the centre entry is unknown', () => {
    let session = placeInCenter(boot(), 'p1', 'c_plaza');
    session = patchSession(session, (state) => ({
      ...state,
      phase: 'AWAIT_CHOICE',
      pendingChoice: { kind: 'CENTER_EXIT', playerId: 'p1', options: ['RING_RETURN'] },
    }));
    const blocked = applyIntent(session, msg('INTENT_END_TURN', 'p1', {}));
    expect(blocked.rejected).toBe('not-awaiting-end-turn');

    const exited = applyIntent(session, msg('INTENT_ENTER_CENTER', 'p1', { nodeId: 't0' }));
    expect(exited.rejected).toBeNull();
    expect(exited.session.state.players.find((player) => player.id === 'p1')?.position).toEqual({
      zone: 'ring',
      index: 0,
    });
  });
});

describe('skills', () => {
  it('uses an active skill and starts its cooldown', () => {
    const session = boot();
    const before = moneyOf(session, 'p1');
    expect(before).toBe(20_200);
    const result = applyIntent(
      patchSession(session, (state) => ({ ...state, activePlayerIndex: 1 })),
      msg('INTENT_USE_SKILL', 'p2', { skillId: 'skill_girl_allowance' }),
    );
    expect(result.rejected).toBeNull();
    expect(moneyOf(result.session, 'p2')).toBe(21_500);
    expect(
      result.session.state.players.find((player) => player.id === 'p2')?.skillCooldowns[
        'skill_girl_allowance'
      ],
    ).toBe(3);
  });

  it('refuses a skill the player does not own', () => {
    const session = boot();
    const result = applyIntent(
      session,
      msg('INTENT_USE_SKILL', 'p1', { skillId: 'skill_girl_allowance' }),
    );
    expect(result.rejected).toBe('skill-not-owned');
  });

  it('grants the ninja an extra step after rolling', () => {
    const session = boot();
    const moved = applyIntent(session, msg('INTENT_ROLL', 'p1', {}));
    expect(moved.rejected).toBeNull();
    // p4 is an AI with the ninja TRIGGER skill; put it on turn and roll.
    let ninjaTurn = patchSession(moved.session, (state) => ({ ...state, activePlayerIndex: 3 }));
    ninjaTurn = patchSession(ninjaTurn, (state) => ({
      ...state,
      phase: 'AWAIT_ROLL',
      pendingChoice: null,
    }));
    const before = ninjaTurn.state.players.find((player) => player.id === 'p4')?.position;
    const after = applyIntent(ninjaTurn, msg('INTENT_ROLL', 'p4', {}));
    expect(after.rejected).toBeNull();
    const moved2 = after.events.filter((event) => event.type === 'PLAYER_MOVED');
    expect(moved2.length).toBeGreaterThanOrEqual(2);
    expect(before).toBeDefined();
  });
});

describe('bankruptcy and victory', () => {
  it('declares bankruptcy and awards the game to the last survivor', () => {
    let session = boot();
    session = ownTile(session, 't4', 'p2', 4);
    session = setMoney(session, 'p1', 10);
    session = setMoney(session, 'p3', 0);
    session = setMoney(session, 'p4', 0);
    session = patchSession(session, (state) => ({
      ...state,
      players: state.players.map((player) =>
        player.id === 'p3' || player.id === 'p4' ? { ...player, bankrupt: true } : player,
      ),
    }));
    const result = resolveCurrentLanding(placeOnRing(session, 'p1', 4), 'p1');
    expect(result.events.some((event) => event.type === 'PLAYER_BANKRUPT')).toBe(true);
    expect(result.session.state.phase).toBe('GAME_OVER');
    expect(result.session.state.winnerId).toBe('p2');
  });

  it('ends the game as soon as a player reaches the asset target', () => {
    const session = setMoney(boot(), 'p1', 60_000);
    const result = applyIntent(session, msg('INTENT_ROLL', 'p1', {}));
    expect(result.session.state.phase).toBe('GAME_OVER');
    expect(result.session.state.winnerId).toBe('p1');
    expect(sessionNetWorth(result.session, 'p1')).toBeGreaterThanOrEqual(60_000);
  });

  it('resolves a turn-limit game by net worth', () => {
    const limited = makeSession({
      roomConfig: {
        eventRate: 'MEDIUM',
        victory: { kind: 'TURN_LIMIT', value: 30 },
        requireApproval: false,
      },
    });
    const started = startGame(limited).session;
    const session = patchSession(started, (state) => ({
      ...state,
      turn: 30,
      activePlayerIndex: 3,
      phase: 'AWAIT_END_TURN',
      pendingChoice: null,
    }));
    const result = applyIntent(session, msg('INTENT_END_TURN', 'p4', {}));
    expect(result.session.state.phase).toBe('GAME_OVER');
    expect(result.session.state.winnerId).toBe('p1');
  });
});
