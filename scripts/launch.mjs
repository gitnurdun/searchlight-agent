import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const data = path.join(root, '.data');
const entry = path.join(root, 'dist', 'apps', 'server', 'src', 'index.js');
if (!fs.existsSync(entry)) {
  console.error('Search Agent has not been built. Run npm install and npm run build first.');
  process.exit(1);
}
fs.mkdirSync(data, { recursive: true });
const state = path.join(data, 'server.json');
try {
  const saved = JSON.parse(fs.readFileSync(state, 'utf8'));
  const response = await fetch(`http://127.0.0.1:${saved.port}/api/v1/health`, { signal: AbortSignal.timeout(1200) });
  if (response.ok) {
    spawn('cmd.exe', ['/c', 'start', '', `http://127.0.0.1:${saved.port}`], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    process.exit(0);
  }
} catch {}
const log = fs.openSync(path.join(data, 'server.log'), 'a');
const child = spawn(process.execPath, [entry], { cwd: root, detached: true, windowsHide: true, stdio: ['ignore', log, log] });
child.unref(); fs.closeSync(log);
for (let i = 0; i < 40; i++) {
  await new Promise((resolve) => setTimeout(resolve, 250));
  try {
    const response = await fetch('http://127.0.0.1:4321/api/v1/health', { signal: AbortSignal.timeout(800) });
    if (response.ok) {
      spawn('cmd.exe', ['/c', 'start', '', 'http://127.0.0.1:4321'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      process.exit(0);
    }
  } catch {}
}
console.error('Search Agent did not become ready. See .data\\server.log.');
process.exit(1);
