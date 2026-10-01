import { LiveEngine, LIVE_VERSION } from './prime-live.mjs';
import { startLive } from './prime-live-transport.mjs';
await startLive(LiveEngine, LIVE_VERSION);
