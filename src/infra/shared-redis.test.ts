import { describe, expect, it } from 'vitest';
import { sharedRedis } from './shared-redis.js';

/** A connection that counts how often it was opened and quit. */
function countingConnections() {
  const opened: { quits: number }[] = [];
  return {
    opened,
    open: async () => {
      const connection = {
        quits: 0,
        quit: async () => {
          connection.quits += 1;
          return 'OK';
        },
      };
      opened.push(connection);
      return connection;
    },
  };
}

describe('sharedRedis', () => {
  it('opens nothing until a store asks for the connection', async () => {
    const connections = countingConnections();
    const redis = sharedRedis(connections.open);

    await redis.close();

    expect(connections.opened).toHaveLength(0);
  });

  it('opens one connection for every store that asks, even concurrently', async () => {
    const connections = countingConnections();
    const redis = sharedRedis(connections.open);

    const [first, second] = await Promise.all([redis.client(), redis.client()]);

    expect(first).toBe(second);
    expect(connections.opened).toHaveLength(1);
  });

  it('quits the connection exactly once, however often it is closed', async () => {
    const connections = countingConnections();
    const redis = sharedRedis(connections.open);
    await redis.client();

    await Promise.all([redis.close(), redis.close()]);
    await redis.close();

    expect(connections.opened.map((connection) => connection.quits)).toEqual([1]);
  });

  it('refuses to open a connection after close', async () => {
    const connections = countingConnections();
    const redis = sharedRedis(connections.open);
    await redis.close();

    await expect(redis.client()).rejects.toThrow('Shared Redis connection is closed');
    expect(connections.opened).toHaveLength(0);
  });

  it('closes cleanly when opening the connection failed', async () => {
    const redis = sharedRedis(async (): Promise<{ quit: () => Promise<unknown> }> => {
      throw new Error('redis unreachable');
    });

    await expect(redis.client()).rejects.toThrow('redis unreachable');
    await expect(redis.close()).resolves.toBeUndefined();
  });
});
