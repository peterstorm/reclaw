import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  manifestPluginSource,
  marketplaceDirectory,
  resolveCortexExtractScript,
} from './cortex-extract.js';

describe('marketplaceDirectory', () => {
  it('returns the path of a directory-source marketplace', () => {
    const data = { local: { source: { source: 'directory', path: '/m/local' } } };
    expect(marketplaceDirectory(data, 'local')).toBe('/m/local');
  });

  it('returns null for github-source, missing, or malformed marketplaces', () => {
    expect(
      marketplaceDirectory({ cortex: { source: { source: 'github', repo: 'a/b' } } }, 'cortex'),
    ).toBeNull();
    expect(marketplaceDirectory({}, 'local')).toBeNull();
    expect(marketplaceDirectory(null, 'local')).toBeNull();
    expect(
      marketplaceDirectory({ local: { source: { source: 'directory' } } }, 'local'),
    ).toBeNull();
  });
});

describe('manifestPluginSource', () => {
  const manifest = {
    plugins: [
      { name: 'loom', source: './plugins/loom' },
      { name: 'cortex', source: './plugins/cortex' },
    ],
  };

  it('returns the relative source declared for the plugin', () => {
    expect(manifestPluginSource(manifest, 'cortex')).toBe('./plugins/cortex');
  });

  it('returns null for unknown plugins and non-relative or malformed sources', () => {
    expect(manifestPluginSource(manifest, 'nope')).toBeNull();
    expect(
      manifestPluginSource({ plugins: [{ name: 'cortex', source: '/abs' }] }, 'cortex'),
    ).toBeNull();
    expect(
      manifestPluginSource({ plugins: [{ name: 'cortex', source: { url: 'x' } }] }, 'cortex'),
    ).toBeNull();
    expect(manifestPluginSource(undefined, 'cortex')).toBeNull();
  });
});

describe('resolveCortexExtractScript', () => {
  let home: string;

  const writeScript = async (root: string): Promise<string> => {
    const dir = join(root, 'hooks', 'scripts');
    await mkdir(dir, { recursive: true });
    const script = join(dir, 'extract-and-generate.sh');
    await writeFile(script, '#!/usr/bin/env bash\n');
    return script;
  };

  /** Fake ~/.claude with a frozen cache copy and a live directory-source marketplace. */
  const setup = async (opts: { cache: boolean; live: boolean }) => {
    const cacheRoot = join(home, 'cache', 'cortex');
    const liveRoot = join(home, 'dev', 'cortex');
    const marketplace = join(home, 'marketplace');
    const cacheScript = opts.cache ? await writeScript(cacheRoot) : null;
    const liveScript = opts.live ? await writeScript(liveRoot) : null;

    await mkdir(join(marketplace, 'plugins'), { recursive: true });
    await mkdir(join(marketplace, '.claude-plugin'), { recursive: true });
    await symlink(liveRoot, join(marketplace, 'plugins', 'cortex'));
    await writeFile(
      join(marketplace, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({ plugins: [{ name: 'cortex', source: './plugins/cortex' }] }),
    );

    await mkdir(join(home, '.claude', 'plugins'), { recursive: true });
    await writeFile(
      join(home, '.claude', 'plugins', 'known_marketplaces.json'),
      JSON.stringify({ local: { source: { source: 'directory', path: marketplace } } }),
    );
    await writeFile(
      join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({ plugins: { 'cortex@local': [{ installPath: cacheRoot }] } }),
    );
    return { cacheScript, liveScript };
  };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'reclaw-cortex-resolve-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('prefers the live checkout over the frozen cache copy', async () => {
    const { liveScript } = await setup({ cache: true, live: true });
    expect(resolveCortexExtractScript(home)).toBe(liveScript);
  });

  it('falls back to the cache copy when the live checkout is unavailable', async () => {
    const { cacheScript } = await setup({ cache: true, live: false });
    expect(resolveCortexExtractScript(home)).toBe(cacheScript);
  });

  it('returns null when neither has the script', async () => {
    await setup({ cache: false, live: false });
    expect(resolveCortexExtractScript(home)).toBeNull();
  });

  it('returns null when nothing is installed', () => {
    expect(resolveCortexExtractScript(home)).toBeNull();
  });
});
