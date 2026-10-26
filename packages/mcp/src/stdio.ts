import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, SearchEngine, Store } from '../../search-core/src/index.js';
import { createMcpServer } from './server.js';

const config = loadConfig(process.cwd()); const store = new Store(config); const engine = new SearchEngine(config, store);
const transport = new StdioServerTransport(); const server = createMcpServer(engine);
await server.connect(transport);
process.on('SIGINT', async () => { await server.close(); store.close(); process.exit(0); });
