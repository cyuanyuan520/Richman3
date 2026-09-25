import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/global.css';

const container = document.getElementById('root');

if (!container) {
  throw new Error('Root container "#root" was not found in index.html');
}

/**
 * AC-024: the board renders through WebGL2 and the layout assumes a desk-sized
 * viewport. Both are checked before React mounts so an unsupported device gets a
 * sentence instead of a blank canvas.
 */
function unsupported(): string | null {
  if (typeof WebGL2RenderingContext === 'undefined') {
    return '这台设备或浏览器不支持 WebGL2，无法运行棋盘。';
  }
  const probe = document.createElement('canvas');
  const context = probe.getContext('webgl2');
  if (context === null) {
    return '无法创建 WebGL2 上下文，请检查浏览器是否禁用了硬件加速。';
  }
  if (window.matchMedia('(pointer: coarse)').matches && window.innerWidth < 900) {
    return '这是桌面端游戏，请使用电脑打开，横屏体验最佳。';
  }
  return null;
}

const blocker = unsupported();

if (blocker === null) {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
} else {
  const panel = document.createElement('div');
  panel.className = 'app-fallback';
  const title = document.createElement('h1');
  title.textContent = '无法启动大富翁 3D';
  const detail = document.createElement('p');
  detail.textContent = blocker;
  panel.append(title, detail);
  container.replaceChildren(panel);
}
