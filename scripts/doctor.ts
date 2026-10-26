import { loadConfig } from '../packages/search-core/src/index.js';
import { doctor } from '../apps/server/src/runtime.js';

console.log(JSON.stringify(await doctor(loadConfig(process.cwd())), null, 2));
