import fs from 'node:fs/promises';
import path from 'node:path';

const file = path.join(process.cwd(), '.data', 'server.json');
try {
  const saved = JSON.parse(await fs.readFile(file, 'utf8')) as { port: number; token: string };
  const response = await fetch(`http://127.0.0.1:${saved.port}/api/v1/shutdown`, { method: 'POST', headers: { 'x-search-agent-token': saved.token }, body: '{}' });
  if (!response.ok) throw new Error(`Server returned ${response.status}`);
  console.log('Search Agent is stopping. Ollama remains available.');
} catch (error) { console.error(`Could not stop Search Agent: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
