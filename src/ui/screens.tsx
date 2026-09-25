import type { ReactNode } from 'react';

import type { Character } from '@/engine/contracts/content';
import {
  ASSET_TARGET_MULTIPLIERS,
  TURN_LIMIT_VALUES,
  type RoomConfig,
} from '@/engine/contracts/config';
import { EVENT_RATES, type EventRate, type Quality } from '@/engine/contracts/primitives';
import type { Settings } from '@/engine/contracts/config';

/* ------------------------------------------------------------------ labels */

export const EVENT_RATE_LABELS: Record<EventRate, string> = {
  LOW: '低（偶尔来一下）',
  MEDIUM: '中（经典频率）',
  HIGH: '高（鸡飞狗跳）',
};

/**
 * Wall-clock estimates. The measured AI medians were 20 rounds at 2x and 41 at
 * 3x, so 1.75 minutes per round is the conversion used throughout. Human tables
 * are slower, which the caption says out loud rather than hiding.
 */
export const MINUTES_PER_ROUND = 1.75;

export function assetTargetEstimate(value: number): string {
  if (value === 2) return '约 30–50 分钟';
  if (value === 3) return '约 60–90 分钟';
  return '预计 90 分钟以上';
}

export function turnLimitEstimate(value: number): string {
  const minutes = Math.round(value * MINUTES_PER_ROUND);
  if (minutes < 60) return `约 ${minutes} 分钟`;
  return `约 ${Math.round(minutes / 60)} 小时`;
}

export const DURATION_NOTE = '时长按每回合约 1.75 分钟估算，真人同桌通常更慢。';

/* -------------------------------------------------------------- primitives */

export function Screen({
  title,
  subtitle,
  children,
  actions,
  wide,
}: {
  title: string;
  subtitle?: string;
  children?: ReactNode;
  actions?: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={wide ? 'screen screen-wide' : 'screen'}>
      <header className="screen-head">
        <h1>{title}</h1>
        {subtitle === undefined ? null : <p className="muted">{subtitle}</p>}
      </header>
      <div className="screen-body">{children}</div>
      {actions === undefined ? null : <footer className="screen-actions">{actions}</footer>}
    </div>
  );
}

export function CharacterPicker({
  characters,
  value,
  onChange,
  taken = [],
  disabled = false,
}: {
  characters: readonly Character[];
  value: string | null;
  onChange: (id: string) => void;
  taken?: readonly string[];
  disabled?: boolean;
}) {
  return (
    <div className="character-grid">
      {characters.map((character) => {
        const isTaken = taken.includes(character.id);
        const selected = character.id === value;
        return (
          <button
            key={character.id}
            type="button"
            className={`character-card${selected ? ' is-selected' : ''}`}
            disabled={disabled || (isTaken && !selected)}
            aria-pressed={selected}
            onClick={() => onChange(character.id)}
          >
            <img src={`/models/${character.portraitRef}.png`} alt="" />
            <strong>{character.name}</strong>
            <span className="muted">{character.skill.name}</span>
            <span className="character-skill">{character.skill.desc}</span>
            {isTaken && !selected ? <em className="taken">已被选择</em> : null}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ screens */

export function MenuScreen({
  onSolo,
  onOnline,
  onSettings,
  onRules,
}: {
  onSolo: () => void;
  onOnline: () => void;
  onSettings: () => void;
  onRules: () => void;
}) {
  return (
    <div className="screen screen-menu">
      <div className="brand">
        <span className="brand-tag">Q 版微缩都市</span>
        <h1>都会大亨</h1>
        <p className="muted">买地、盖楼、整蛊好兄弟的四人棋盘。</p>
      </div>
      <div className="menu-actions">
        <button type="button" className="button-primary" onClick={onSolo}>
          单人开局
        </button>
        <button type="button" onClick={onOnline}>
          联机对战
        </button>
        <button type="button" onClick={onSettings}>
          设置
        </button>
        <button type="button" onClick={onRules}>
          规则说明
        </button>
      </div>
    </div>
  );
}

export function SoloSetupScreen({
  characters,
  nickname,
  onNickname,
  characterId,
  onCharacter,
  config,
  onConfig,
  onStart,
  onBack,
}: {
  characters: readonly Character[];
  nickname: string;
  onNickname: (value: string) => void;
  characterId: string;
  onCharacter: (id: string) => void;
  config: RoomConfig;
  onConfig: (config: RoomConfig) => void;
  onStart: () => void;
  onBack: () => void;
}) {
  const isAssetTarget = config.victory.kind === 'ASSET_TARGET';
  return (
    <Screen
      title="单人开局"
      subtitle="你会和 3 名 AI 同桌，角色不能重复。"
      wide
      actions={
        <>
          <button type="button" onClick={onBack}>
            返回
          </button>
          <button type="button" className="button-primary" onClick={onStart}>
            开始游戏
          </button>
        </>
      }
    >
      <label className="field">
        <span>你的称呼</span>
        <input
          type="text"
          value={nickname}
          maxLength={16}
          placeholder="阿伟"
          onChange={(event) => onNickname(event.target.value)}
        />
      </label>

      <h2>选择角色</h2>
      <CharacterPicker characters={characters} value={characterId} onChange={onCharacter} />

      <h2>开局预设</h2>
      <div className="preset-row">
        <div className="field">
          <span>事件频率</span>
          <select
            value={config.eventRate}
            onChange={(event) =>
              onConfig({ ...config, eventRate: event.target.value as EventRate })
            }
          >
            {EVENT_RATES.map((rate) => (
              <option key={rate} value={rate}>
                {EVENT_RATE_LABELS[rate]}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <span>胜利条件</span>
          <select
            value={config.victory.kind}
            onChange={(event) =>
              onConfig({
                ...config,
                victory:
                  event.target.value === 'ASSET_TARGET'
                    ? { kind: 'ASSET_TARGET', value: 3 }
                    : { kind: 'TURN_LIMIT', value: 90 },
              })
            }
          >
            <option value="ASSET_TARGET">资产达标（先到先赢）</option>
            <option value="TURN_LIMIT">回合上限（结束时最富者赢）</option>
          </select>
        </div>

        <div className="field">
          <span>{isAssetTarget ? '目标资产（初始资金的倍数）' : '回合上限'}</span>
          <select
            value={config.victory.value}
            onChange={(event) =>
              onConfig({
                ...config,
                victory: {
                  ...config.victory,
                  value: Number(event.target.value),
                } as RoomConfig['victory'],
              })
            }
          >
            {(isAssetTarget ? ASSET_TARGET_MULTIPLIERS : TURN_LIMIT_VALUES).map((value) => (
              <option key={value} value={value}>
                {isAssetTarget ? `${value} ×` : `${value} 回合`}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className="muted small">
        预计时长：
        {isAssetTarget
          ? assetTargetEstimate(config.victory.value)
          : turnLimitEstimate(config.victory.value)}
        。{DURATION_NOTE}
      </p>
    </Screen>
  );
}

export function SettingsScreen({
  settings,
  qualityPresets,
  onChange,
  onReset,
  onBack,
}: {
  settings: Settings;
  qualityPresets: readonly { level: Quality; label: string }[];
  onChange: (patch: Partial<Omit<Settings, 'v'>>) => void;
  onReset: () => void;
  onBack: () => void;
}) {
  return (
    <Screen
      title="设置"
      subtitle="设置会保存在本机浏览器里。"
      actions={
        <>
          <button type="button" onClick={onReset}>
            恢复默认
          </button>
          <button type="button" className="button-primary" onClick={onBack}>
            完成
          </button>
        </>
      }
    >
      <label className="field">
        <span>昵称</span>
        <input
          type="text"
          value={settings.nickname}
          maxLength={16}
          onChange={(event) => onChange({ nickname: event.target.value })}
        />
      </label>

      <label className="field slider">
        <span>背景音乐 {Math.round(settings.bgmVolume * 100)}</span>
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(settings.bgmVolume * 100)}
          onChange={(event) => onChange({ bgmVolume: Number(event.target.value) / 100 })}
        />
      </label>

      <label className="field slider">
        <span>音效 {Math.round(settings.sfxVolume * 100)}</span>
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(settings.sfxVolume * 100)}
          onChange={(event) => onChange({ sfxVolume: Number(event.target.value) / 100 })}
        />
      </label>

      <label className="field">
        <span>画质</span>
        <select
          value={settings.quality}
          onChange={(event) => onChange({ quality: event.target.value as Quality })}
        >
          {qualityPresets.map((preset) => (
            <option key={preset.level} value={preset.level}>
              {preset.label}
            </option>
          ))}
        </select>
      </label>

      <label className="field checkbox">
        <input
          type="checkbox"
          checked={settings.muted}
          onChange={(event) => onChange({ muted: event.target.checked })}
        />
        <span>全部静音</span>
      </label>
    </Screen>
  );
}

export const RULES_SECTIONS: readonly { title: string; lines: readonly string[] }[] = [
  {
    title: '目标',
    lines: [
      '掷骰前进，买地盖楼收租，把对手的现金耗尽。',
      '默认胜利条件是「总资产达到初始资金的 3 倍」；房主也可以改成回合上限，到点由最富的人获胜。',
      '总资产 = 现金 + 地产投入 − 未赎回的抵押负债。',
    ],
  },
  {
    title: '一回合做什么',
    lines: [
      '掷骰移动，停在格子上结算事件。',
      '无主地产可以买下；自己的地产可以升级，最高 4 级，租金逐级翻倍。',
      '现金不够时可以抵押地产换钱，之后再赎回。',
      '结束回合交给下一位。',
    ],
  },
  {
    title: '格子类型',
    lines: [
      '地产：可买可升级，分四个地段组。',
      '机会：随机好事或坏事。',
      '恶搞：本作的主角，26 个整蛊事件，可能全场一起遭殃。',
      '税收与奖励：按比例扣钱或发钱。',
      '监狱：停一次行动。',
      '地铁口：传送到棋盘中央。',
    ],
  },
  {
    title: '中央区域',
    lines: [
      '地铁口通往中央的转盘、猜拳和抽卡，赢家有奖金和护盾。',
      '中央还会有特殊事件，之后可以从入口回到环线。',
    ],
  },
  {
    title: '联机',
    lines: [
      '房主选好规则后生成分享链接和 6 位房间码。',
      '用链接加入的人可以直接进场；手输房间码的人需要房主同意。',
      '房主的浏览器就是服务器，房主离开对局即结束。',
      '同一网络打洞失败时无法直连，换个网络再试。',
    ],
  },
];

export function RulesScreen({ onBack }: { onBack: () => void }) {
  return (
    <Screen
      title="规则说明"
      wide
      actions={
        <button type="button" className="button-primary" onClick={onBack}>
          返回
        </button>
      }
    >
      {RULES_SECTIONS.map((section) => (
        <section key={section.title} className="rules-section">
          <h2>{section.title}</h2>
          <ul>
            {section.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      ))}
    </Screen>
  );
}

export function OnlineScreen({
  mode,
  nickname,
  onNickname,
  roomCode,
  onRoomCode,
  busy,
  error,
  onCreate,
  onJoin,
  onBack,
}: {
  mode: 'choose' | 'join';
  nickname: string;
  onNickname: (value: string) => void;
  roomCode: string;
  onRoomCode: (value: string) => void;
  busy: boolean;
  error: string | null;
  onCreate: () => void;
  onJoin: () => void;
  onBack: () => void;
}) {
  return (
    <Screen
      title="联机对战"
      subtitle="房主的浏览器就是服务器，最多 4 人同桌。"
      actions={
        <button type="button" onClick={onBack}>
          返回
        </button>
      }
    >
      <label className="field">
        <span>你的称呼</span>
        <input
          type="text"
          value={nickname}
          maxLength={16}
          onChange={(event) => onNickname(event.target.value)}
        />
      </label>

      <div className="field">
        <span>创建房间</span>
        <button type="button" className="button-primary" disabled={busy} onClick={onCreate}>
          创建并生成邀请链接
        </button>
      </div>

      <div className="field">
        <span>用 6 位房间码加入</span>
        <div className="inline-row">
          <input
            type="text"
            value={roomCode}
            maxLength={8}
            placeholder="7K9Q2M"
            className="room-code-input"
            onChange={(event) => onRoomCode(event.target.value.toUpperCase())}
          />
          <button type="button" disabled={busy || mode !== 'join'} onClick={onJoin}>
            加入
          </button>
        </div>
        <p className="muted small">
          房间码加入需要房主同意；如果你有点对点的完整邀请链接，直接打开链接即可。
        </p>
      </div>

      {error === null ? null : <p className="error">{error}</p>}
    </Screen>
  );
}
