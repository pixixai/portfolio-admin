import { spawn } from 'node:child_process';

export function openDefaultBrowser(url, { platform = process.platform, launch = spawn, warn = console.warn } = {}) {
  const [command, args] = platform === 'win32'
    ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
    : platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const child = launch(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => warn(`浏览器未能自动打开，请手动访问：${url}`));
    child.unref();
  } catch { warn(`浏览器未能自动打开，请手动访问：${url}`); }
}
