// src/core/config.ts
import toppings from './toppings'

export interface FilePizzaConfig {
  serverUrl?: string;
  channelTtl: number;
  bodyKeys: {
    uploaderPeerID: {
      min: number;
      max: number;
    };
    slug: {
      min: number;
      max: number;
    };
  };
  shortSlug: {
    numChars: number;
    chars: string;
    maxAttempts: number;
  };
  longSlug: {
    numWords: number;
    words: string[];
    maxAttempts: number;
  };
  chunkSize: number;
}

const defaultConfig: FilePizzaConfig = {
  channelTtl: 60 * 60, // 1 hour
  bodyKeys: {
    uploaderPeerID: {
      min: 3,
      max: 256,
    },
    slug: {
      min: 3,
      max: 256,
    },
  },
  shortSlug: {
    numChars: 8,
    chars: '0123456789abcdefghijklmnopqrstuvwxyz',
    maxAttempts: 8,
  },
  longSlug: {
    numWords: 4,
    words: toppings,
    maxAttempts: 8,
  },
  chunkSize: 256 * 1024, // 256 KB
}

export default defaultConfig