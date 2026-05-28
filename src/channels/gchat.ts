/**
 * Google Chat channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 */
import { createGoogleChatAdapter } from '@chat-adapter/gchat';

import { readEnvFile } from '../env.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

registerChannelAdapter('gchat', {
  factory: () => {
    const env = readEnvFile(['GCHAT_CREDENTIALS', 'GCHAT_WEBHOOK_URL']);
    if (!env.GCHAT_CREDENTIALS) return null;
    const gchatAdapter = createGoogleChatAdapter({
      credentials: JSON.parse(env.GCHAT_CREDENTIALS),
      endpointUrl: env.GCHAT_WEBHOOK_URL,
    });
    return createChatSdkBridge({ adapter: gchatAdapter, concurrency: 'concurrent', supportsThreads: true });
  },
});
