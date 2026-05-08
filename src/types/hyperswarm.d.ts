// Minimal ambient types for the `hyperswarm` package, which ships without
// official TypeScript declarations. Keep this surface small — just what OSov
// touches. Expand as we use more of the API.

declare module 'hyperswarm' {
  import { EventEmitter } from 'events';
  import { Duplex } from 'stream';

  export interface PeerInfo {
    publicKey: Buffer;
    topics: Buffer[];
    [key: string]: unknown;
  }

  export interface Connection extends Duplex {
    remotePublicKey: Buffer;
    publicKey: Buffer;
  }

  export interface JoinOptions {
    client?: boolean;
    server?: boolean;
  }

  export interface Discovery {
    flushed(): Promise<void>;
    refresh(opts?: JoinOptions): Promise<void>;
    destroy(): Promise<void>;
  }

  export interface KeyPair {
    publicKey: Buffer;
    secretKey: Buffer;
  }

  export interface HyperswarmOptions {
    keyPair?: KeyPair;
    seed?: Buffer;
    maxPeers?: number;
    firewall?: (remotePublicKey: Buffer) => boolean;
  }

  class Hyperswarm extends EventEmitter {
    constructor(opts?: HyperswarmOptions);
    readonly connections: Iterable<Connection>;
    join(topic: Buffer, opts?: JoinOptions): Discovery;
    leave(topic: Buffer): Promise<void>;
    flush(): Promise<void>;
    destroy(): Promise<void>;
    on(event: 'connection', listener: (conn: Connection, info: PeerInfo) => void): this;
    on(event: string | symbol, listener: (...args: unknown[]) => void): this;
  }

  export default Hyperswarm;
}
