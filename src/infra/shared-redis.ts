// One Redis connection shared by several stores, with a single owner for its
// lifetime: it opens when the first store asks for it and quits exactly once.

import { assertNever } from '../core/types.js';

/** The one thing ownership needs from a connection. */
type Quittable = { readonly quit: () => Promise<unknown> };

export type SharedRedis<C extends Quittable> = {
  /** The shared connection, opened on the first call; refused once `close` has run. */
  readonly client: () => Promise<C>;
  /** Quit the connection if it was opened. Every call shares the first call's promise. */
  readonly close: () => Promise<void>;
};

type Lifetime<C> =
  | { readonly kind: 'unopened' }
  | { readonly kind: 'open'; readonly connection: Promise<C> }
  | { readonly kind: 'closed'; readonly closed: Promise<void> };

export function sharedRedis<C extends Quittable>(open: () => Promise<C>): SharedRedis<C> {
  let lifetime: Lifetime<C> = { kind: 'unopened' };

  const client = (): Promise<C> => {
    switch (lifetime.kind) {
      case 'unopened': {
        const connection = open();
        lifetime = { kind: 'open', connection };
        return connection;
      }
      case 'open':
        return lifetime.connection;
      case 'closed':
        return Promise.reject(new Error('Shared Redis connection is closed'));
      default:
        return assertNever(lifetime);
    }
  };

  const close = (): Promise<void> => {
    switch (lifetime.kind) {
      case 'unopened':
        lifetime = { kind: 'closed', closed: Promise.resolve() };
        return lifetime.closed;
      case 'open': {
        // A connection that failed to open has nothing to quit; its caller already saw the error.
        const closed = lifetime.connection.then(
          async (connection) => {
            await connection.quit();
          },
          () => undefined,
        );
        lifetime = { kind: 'closed', closed };
        return closed;
      }
      case 'closed':
        return lifetime.closed;
      default:
        return assertNever(lifetime);
    }
  };

  return { client, close };
}
