import type { Readiness } from '../gameServer';
import { logo } from './logo';

const RELEASES = 'https://github.com/cryptskii/wildstate-dsm/releases/latest';
/** The Android app serves its bundled client from WebViewAssetLoader's origin. */
const inApp = () => window.location.hostname === 'appassets.androidplatform.net';

/** Shown instead of the game when it cannot start: the server is unreachable, or it and this client disagree. */
export function showNotice(state: Exclude<Readiness, 'ok'>): void {
  const reload = () => window.location.reload();
  const [title, detail, label, action]: [string, string, string, string | (() => void)] =
    state === 'unreachable' ? ["Wildstate can't reach the game right now.", 'Check your connection and try again.', 'Try again', reload]
    : state === 'server-behind' ? ['Wildstate is being updated.', 'Try again in a few minutes.', 'Try again', reload]
    : inApp() ? ['A new version of Wildstate is out.', 'Install it to keep playing. What your wallet owns and your saved progress are kept.', 'Get the update', RELEASES]
    : ['Wildstate has been updated.', 'Reload to keep playing.', 'Reload', reload];

  const card = document.createElement('section');
  card.style.cssText = 'position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:32px;box-sizing:border-box;background:#10251b;color:#f6efd2;font:18px/1.4 system-ui,sans-serif;text-align:center';
  const heading = document.createElement('h1');
  heading.style.cssText = 'margin:0;font-size:22px';
  heading.textContent = title;
  const text = document.createElement('p');
  text.style.cssText = 'margin:0;max-width:420px;color:#cfe3cb';
  text.textContent = detail;
  const button = document.createElement(typeof action === 'string' ? 'a' : 'button');
  button.style.cssText = 'margin-top:8px;padding:12px 20px;border:0;background:#e2c35a;color:#10261f;font:inherit;font-weight:600;text-decoration:none;cursor:pointer';
  button.textContent = label;
  if (typeof action === 'string') (button as HTMLAnchorElement).href = action;
  else button.addEventListener('click', action);
  const mark = logo('min(72vw, 420px)');
  mark.style.marginBottom = '12px';
  card.append(mark, heading, text, button);
  document.body.append(card);
}
