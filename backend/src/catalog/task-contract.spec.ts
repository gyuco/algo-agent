import { join } from 'node:path';
import { buildCatalog, readCatalogDir } from './catalog.js';
import { normalizeSteps, sortSteps } from './workflow-graph.js';
import { taskContractErrors } from './task-contract.js';

describe('taskContractErrors', () => {
  it('accepts the three task models shipped with the app', async () => {
    const catalog = buildCatalog(
      await readCatalogDir(join(process.cwd(), 'catalog')),
    );
    for (const key of ['task-tdd', 'task-docs', 'task-config']) {
      const workflow = catalog.workflows.get(key)!;
      expect(workflow.task).toBe(true);
      expect(workflow.result).toBe('verify');
    }
  });

  it('requires result to run commands and be judged by another agent', () => {
    const steps = sortSteps(
      normalizeSteps([
        { id: 'write', agent: 'role:implementer', prompt: 'P' },
        { id: 'verify', agent: 'role:reviewer', prompt: 'P', verdict: ['ok', 'problemi'] },
      ]),
    )!;
    expect(taskContractErrors(steps, 'verify')).toEqual([
      'passo verify, run: la verifica finale deve eseguire i controlli',
    ]);

    const same = sortSteps(
      normalizeSteps([
        { id: 'write', agent: 'role:implementer', prompt: 'P' },
        {
          id: 'verify',
          agent: 'role:implementer',
          run: ['test'],
          prompt: 'P',
          verdict: ['ok', 'problemi'],
        },
      ]),
    )!;
    expect(taskContractErrors(same, 'verify')).toContain(
      'passo verify, agent: chi giudica non può essere anche chi scrive (role:implementer)',
    );
  });

  it('rejects writes outside the result’s path and repeats over 3', () => {
    const steps = sortSteps(
      normalizeSteps([
        {
          id: 'fix',
          agent: 'role:implementer',
          prompt: 'P',
          repeat: { with: 'check', until: 'ok', max: 4 },
        },
        { id: 'check', agent: 'role:reviewer', run: ['test'], verdict: ['ok', 'problemi'], prompt: 'P' },
        { id: 'extra', agent: 'role:implementer', prompt: 'P' },
      ]),
    )!;
    const errors = taskContractErrors(steps, 'check');
    expect(errors).toContain('passo fix, repeat.max: al massimo 3 nei modelli di task');
    expect(errors).toContain(
      'passo extra: con un agente deve venire prima di check o essere il passo che ripete su check',
    );
  });

  it('rejects stop verdicts that result does not declare', () => {
    const steps = sortSteps(
      normalizeSteps([
        {
          id: 'fix',
          agent: 'role:implementer',
          prompt: 'P',
          repeat: { with: 'check', until: 'ok', max: 2, stop: ['test_errati'] },
        },
        { id: 'check', agent: 'role:reviewer', run: ['test'], verdict: ['ok', 'problemi'], prompt: 'P' },
      ]),
    )!;
    expect(taskContractErrors(steps, 'check')).toContain(
      'passo fix, repeat.stop: "test_errati" non è tra i verdetti di check',
    );
  });
});
