import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type AgentContainment,
  type AgentRunId,
  DEFAULT_RUNTIME_MAX_SEC,
  DEFAULT_SLICE,
  MAX_RUNTIME_SEC,
  NO_CONTAINMENT,
  agentContainmentSchema,
  agentScopeUnit,
  containAgentInvocation,
  parseAgentRunId,
  rawAgentContainment,
} from './agent-containment.js';

// ─── Generators (built through the production parsers) ───────────────────────

const runIdArb: fc.Arbitrary<AgentRunId> = fc.uuid().map((raw) => {
  const id = parseAgentRunId(raw);
  if (id === null) throw new Error(`fc.uuid produced an unparseable id: ${raw}`);
  return id;
});

const unitStemArb = fc.stringMatching(/^[a-z][a-z0-9-]{0,30}$/);

const scopedArb: fc.Arbitrary<AgentContainment> = fc
  .record({
    slice: unitStemArb.map((s) => `${s}.slice`),
    bindsTo: fc.option(
      unitStemArb.map((s) => `${s}.service`),
      { nil: null },
    ),
    runtimeMaxSec: fc.integer({ min: 1, max: MAX_RUNTIME_SEC }),
  })
  .map((raw) => agentContainmentSchema.parse({ kind: 'systemd-scope', ...raw }));

/** Agent argv as backends build it: never empty, arbitrary strings after the command. */
const argvArb = fc.array(fc.string(), { minLength: 1, maxLength: 12 });

const parse = (raw: unknown) => agentContainmentSchema.safeParse(raw);

// ─── Run ids ──────────────────────────────────────────────────────────────────

describe('parseAgentRunId', () => {
  it('accepts lowercase UUIDs', () => {
    fc.assert(fc.property(fc.uuid(), (raw) => parseAgentRunId(raw) === raw));
  });

  it.each([
    ['uppercase', 'ABCDEF01-2345-6789-ABCD-EF0123456789'],
    ['unit-name injection', '00000000-0000-0000-0000-000000000000.scope --property=X'],
    ['empty', ''],
    ['path', '../reclaw.service'],
  ])('rejects %s', (_label, raw) => {
    expect(parseAgentRunId(raw)).toBeNull();
  });
});

// ─── Policy parsing ───────────────────────────────────────────────────────────

describe('rawAgentContainment + agentContainmentSchema', () => {
  const env = (overrides: Partial<Parameters<typeof rawAgentContainment>[0]> = {}) =>
    rawAgentContainment({
      mode: undefined,
      slice: undefined,
      bindsTo: undefined,
      runtimeMaxSec: undefined,
      ...overrides,
    });

  it('defaults to no containment when the mode is unset or empty', () => {
    expect(parse(env()).data).toEqual(NO_CONTAINMENT);
    expect(parse(env({ mode: '' })).data).toEqual(NO_CONTAINMENT);
  });

  it('ignores scope settings when containment is off', () => {
    expect(parse(env({ mode: 'none', slice: 'x.slice', runtimeMaxSec: 5 })).data).toEqual(
      NO_CONTAINMENT,
    );
  });

  it('fills slice and lifetime defaults for systemd-scope', () => {
    expect(parse(env({ mode: 'systemd-scope' })).data).toEqual({
      kind: 'systemd-scope',
      slice: DEFAULT_SLICE,
      bindsTo: null,
      runtimeMaxSec: DEFAULT_RUNTIME_MAX_SEC,
    });
  });

  it('keeps explicit scope settings', () => {
    const parsed = parse(
      env({
        mode: 'systemd-scope',
        slice: 'agents.slice',
        bindsTo: 'reclaw.service',
        runtimeMaxSec: 600,
      }),
    );
    expect(parsed.data).toEqual({
      kind: 'systemd-scope',
      slice: 'agents.slice',
      bindsTo: 'reclaw.service',
      runtimeMaxSec: 600,
    });
  });

  it.each([
    ['an unknown mode', { mode: 'cgroup' }],
    ['a slice without the suffix', { mode: 'systemd-scope', slice: 'reclaw-agents' }],
    ['a bare suffix', { mode: 'systemd-scope', slice: '.slice' }],
    ['a slice with a space', { mode: 'systemd-scope', slice: 'a b.slice' }],
    ['a slice with an escape', { mode: 'systemd-scope', slice: 'a\\x2db.slice' }],
    ['bindsTo naming a slice', { mode: 'systemd-scope', bindsTo: 'reclaw.slice' }],
    ['a zero lifetime', { mode: 'systemd-scope', runtimeMaxSec: 0 }],
    ['a lifetime over a day', { mode: 'systemd-scope', runtimeMaxSec: MAX_RUNTIME_SEC + 1 }],
  ])('rejects %s', (_label, overrides) => {
    expect(parse(env(overrides)).success).toBe(false);
  });
});

// ─── Invocation ───────────────────────────────────────────────────────────────

/** The agent argv systemd-run will exec: everything after the first `--`. */
const execedArgv = (argv: readonly string[]): readonly string[] =>
  argv.slice(argv.indexOf('--') + 1);

/** Options systemd-run parses: everything before the first `--`. */
const runnerOptions = (argv: readonly string[]): readonly string[] =>
  argv.slice(0, argv.indexOf('--'));

describe('containAgentInvocation', () => {
  it('leaves an uncontained run exactly as the backend built it, with no teardown', () => {
    fc.assert(
      fc.property(runIdArb, argvArb, (runId, argv) => {
        const invocation = containAgentInvocation(NO_CONTAINMENT, runId, argv);
        expect(invocation.argv).toEqual(argv);
        expect(invocation.teardownArgv).toBeNull();
      }),
    );
  });

  it('execs the agent argv unchanged after the first `--`, whatever it contains', () => {
    // Agent argv may itself contain `--` or strings that look like systemd-run
    // options; none of it may be read as an option to systemd-run.
    fc.assert(
      fc.property(scopedArb, runIdArb, argvArb, (containment, runId, argv) => {
        const { argv: contained } = containAgentInvocation(containment, runId, argv);
        expect(contained[0]).toBe('systemd-run');
        expect(execedArgv(contained)).toEqual(argv);
      }),
    );
  });

  it('places every run in its own scope under the configured slice, and tears down that scope', () => {
    fc.assert(
      fc.property(scopedArb, runIdArb, argvArb, (containment, runId, argv) => {
        if (containment.kind !== 'systemd-scope') throw new Error('generator invariant');
        const { argv: contained, teardownArgv } = containAgentInvocation(containment, runId, argv);
        const options = runnerOptions(contained);
        const unit = agentScopeUnit(runId);
        expect(options).toEqual(
          expect.arrayContaining([
            '--user',
            '--scope',
            '--collect',
            `--unit=${unit}`,
            `--slice=${containment.slice}`,
          ]),
        );
        expect(teardownArgv).toEqual(['systemctl', '--user', 'stop', unit]);
      }),
    );
  });

  it('binds the scope lifetime to the service and to the runtime ceiling', () => {
    fc.assert(
      fc.property(scopedArb, runIdArb, argvArb, (containment, runId, argv) => {
        if (containment.kind !== 'systemd-scope') throw new Error('generator invariant');
        const options = runnerOptions(containAgentInvocation(containment, runId, argv).argv);
        const properties = options.filter((_, i) => options[i - 1] === '--property');
        expect(properties).toContain(`RuntimeMaxSec=${containment.runtimeMaxSec}`);
        expect(properties).toContain('OOMPolicy=continue');
        expect(properties.some((p) => p.startsWith('BindsTo='))).toBe(containment.bindsTo !== null);
        if (containment.bindsTo !== null) {
          expect(properties).toContain(`BindsTo=${containment.bindsTo}`);
        }
      }),
    );
  });

  it('gives distinct runs distinct scopes', () => {
    fc.assert(
      fc.property(scopedArb, runIdArb, runIdArb, argvArb, (containment, a, b, argv) => {
        fc.pre(a !== b);
        const first = containAgentInvocation(containment, a, argv).teardownArgv;
        const second = containAgentInvocation(containment, b, argv).teardownArgv;
        expect(first).not.toEqual(second);
      }),
    );
  });
});
