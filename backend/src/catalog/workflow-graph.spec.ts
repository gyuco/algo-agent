import {
  fillPrompt,
  graphErrors,
  normalizeSteps,
  sortSteps,
  type StepSpec,
} from './workflow-graph.js';

const step = (spec: Partial<StepSpec> = {}): StepSpec => ({
  agent: 'a',
  prompt: 'P',
  ...spec,
});

const errors = (steps: StepSpec[]) => graphErrors(normalizeSteps(steps));

describe('normalizeSteps', () => {
  it('turns a plain list into the chain it always was', () => {
    const base = {
      agent: 'a',
      prompt: 'P',
      approval: false,
      run: null,
      expect: 'pass',
      protect: [],
    };
    const none = { verdict: null, repeat: null };
    expect(normalizeSteps([step(), step(), step()])).toEqual([
      { id: 'step-1', ...base, needs: [], ...none },
      { id: 'step-2', ...base, needs: ['step-1'], ...none },
      { id: 'step-3', ...base, needs: ['step-2'], ...none },
    ]);
  });

  it('makes a repeat fail at its last round unless told otherwise', () => {
    const [fix] = normalizeSteps([
      step({ repeat: { with: 'check', until: 'ok', max: 2 } }),
    ]);
    expect(fix.repeat?.onMax).toBe('fail');
  });

  it('chains to the id the previous step was given', () => {
    const [, second] = normalizeSteps([step({ id: 'review' }), step()]);
    expect(second).toMatchObject({ id: 'step-2', needs: ['review'] });
  });

  it('keeps needs that are written out', () => {
    const [, second] = normalizeSteps([step(), step({ needs: [] })]);
    expect(second.needs).toEqual([]);
  });
});

describe('sortSteps', () => {
  it('puts each step after the ones it needs, else in list order', () => {
    const sorted = sortSteps(
      normalizeSteps([
        step({ id: 'fix', needs: ['review', 'security'] }),
        step({ id: 'review', needs: [] }),
        step({ id: 'security', needs: [] }),
      ]),
    );
    expect(sorted?.map((s) => s.id)).toEqual(['review', 'security', 'fix']);
  });
});

describe('graphErrors', () => {
  it('accepts the workflows written before steps had ids', () => {
    expect(
      errors([
        step({ prompt: '{{input}} {{previous}}' }),
        step({ prompt: '{{previous}}' }),
      ]),
    ).toEqual([]);
  });

  it('accepts references to any step above in the graph', () => {
    expect(
      errors([
        step({ id: 'review', needs: [] }),
        step({ id: 'security', needs: [] }),
        step({
          id: 'fix',
          needs: ['review', 'security'],
          prompt: '{{steps.review}} {{steps.security}}',
        }),
        step({ id: 'check', prompt: '{{steps.review}} {{previous}}' }),
      ]),
    ).toEqual([]);
  });

  it.each<[string, StepSpec[], string]>([
    [
      'duplicate ids',
      [step({ id: 'step-2' }), step()],
      'passo step-2, id: duplicato',
    ],
    [
      'unknown dependencies',
      [step({ needs: ['ghost'] })],
      'passo step-1, needs: passo sconosciuto "ghost"',
    ],
    [
      'a step needing itself',
      [step({ id: 'x', needs: ['x'] })],
      'passo x, needs: dipende da sé stesso',
    ],
    [
      'cycles',
      [step({ id: 'x', needs: ['y'] }), step({ id: 'y', needs: ['x'] })],
      'needs: le dipendenze formano un ciclo',
    ],
    [
      'references to unknown steps',
      [step({ prompt: '{{steps.ghost}}' })],
      'passo step-1, prompt: {{steps.ghost}} non esiste',
    ],
    [
      'references to steps that may not have run',
      [
        step({ id: 'x', needs: [] }),
        step({ prompt: '{{steps.x}}', needs: [] }),
      ],
      'passo step-2, prompt: {{steps.x}} non è tra le dipendenze del passo',
    ],
    [
      '{{previous}} with more than one dependency',
      [
        step({ id: 'x', needs: [] }),
        step({ id: 'y', needs: [] }),
        step({ prompt: '{{previous}}', needs: ['x', 'y'] }),
      ],
      'passo step-3, prompt: {{previous}} vale solo con una dipendenza; usa {{steps.<id>}}',
    ],
  ])('rejects %s', (_, steps, message) => {
    expect(errors(steps)).toContain(message);
  });
});

describe('graphErrors with repeat', () => {
  const fix = (repeat: Partial<StepSpec['repeat']> = {}, prompt = 'P') =>
    step({
      id: 'fix',
      prompt,
      repeat: { with: 'check', until: 'ok', max: 3, ...repeat },
    });
  const check = (spec: Partial<StepSpec> = {}) =>
    step({ id: 'check', verdict: ['ok', 'again'], ...spec });

  it('accepts a step and its check, each seeing the other', () => {
    expect(
      errors([
        fix({}, '{{steps.check}} {{iteration}}'),
        check({ prompt: '{{steps.fix}} {{iteration}}' }),
        step({ id: 'after', prompt: '{{steps.fix}} {{steps.check}}' }),
      ]),
    ).toEqual([]);
  });

  it.each<[string, StepSpec[], string]>([
    [
      'an unknown check',
      [fix({ with: 'ghost' })],
      'passo fix, repeat.with: passo sconosciuto "ghost"',
    ],
    [
      'a check depending on other steps',
      [step({ id: 'x' }), fix(), check({ needs: ['fix', 'x'] })],
      'passo fix, repeat.with: la verifica deve dipendere solo da fix',
    ],
    [
      'a check without verdicts',
      [fix(), step({ id: 'check' })],
      'passo fix, repeat.with: la verifica deve dichiarare verdict',
    ],
    [
      'an until that is not a verdict',
      [fix({ until: 'done' }), check()],
      'passo fix, repeat.until: "done" non è tra i verdetti di check',
    ],
    [
      'a check asking for approval',
      [fix(), check({ approval: true })],
      'passo fix, repeat.with: la verifica non può chiedere approvazione',
    ],
    [
      'a check shared by two steps',
      [
        fix(),
        check(),
        step({
          id: 'fix2',
          needs: ['check'],
          repeat: { with: 'check', until: 'ok', max: 2 },
        }),
      ],
      'passo fix, repeat.with: check è già la verifica di un altro passo',
    ],
    [
      'repeated verdict values',
      [check({ verdict: ['ok', 'ok'] })],
      'passo check, verdict: valori ripetuti',
    ],
    [
      '{{iteration}} outside a repeat',
      [step({ prompt: '{{iteration}}' })],
      'passo step-1, prompt: {{iteration}} vale solo in un passo con repeat o nella sua verifica',
    ],
  ])('rejects %s', (_, steps, message) => {
    expect(errors(steps)).toContain(message);
  });
});

describe('fillPrompt', () => {
  it('fills the input, the steps by id and the only dependency', () => {
    const [, second] = normalizeSteps([
      step({ id: 'review' }),
      step({ prompt: '{{input}}: {{steps.review}} / {{previous}}' }),
    ]);
    expect(fillPrompt(second, 'src', { review: 'ok' })).toBe('src: ok / ok');
  });

  it('fills the round of a repeat', () => {
    const [first] = normalizeSteps([step({ prompt: 'round {{iteration}}' })]);
    expect(fillPrompt(first, '', {}, 2)).toBe('round 2');
  });

  it('leaves {{previous}} empty on a step that needs nothing', () => {
    const [first] = normalizeSteps([step({ prompt: '[{{previous}}]' })]);
    expect(fillPrompt(first, 'src', {})).toBe('[]');
  });
});
