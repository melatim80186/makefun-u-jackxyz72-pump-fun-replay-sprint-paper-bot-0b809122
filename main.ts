// pump-fun-replay-sprint: early-entry paper bot with tail-riding exits.
// The grader runs `node /bot/main.ts`; the strategy lives in strategy.ts and the SDK shim is
// the kit's sdk/ts file, vendored byte for byte as vendor/agentfun-bot.ts.

import { runBot } from './vendor/agentfun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
