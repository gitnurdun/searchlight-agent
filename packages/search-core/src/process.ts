import { spawn } from 'node:child_process';

export async function runProcess(command: string, args: string[], options: { timeoutMs?: number; maxBytes?: number; cwd?: string } = {}): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    let bytes = 0; let done = false;
    const finish = (error?: Error, code = -1) => {
      if (done) return; done = true; clearTimeout(timer);
      if (error) reject(error); else resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8') });
    };
    const max = options.maxBytes ?? 30 * 1024 * 1024;
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > max) { child.kill(); finish(new Error('Process output exceeded its safety limit.')); }
      else stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error) => finish(error));
    child.on('close', (code) => finish(undefined, code ?? -1));
    const timer = setTimeout(() => { child.kill(); finish(new Error('Process timed out.')); }, options.timeoutMs ?? 60_000);
  });
}
