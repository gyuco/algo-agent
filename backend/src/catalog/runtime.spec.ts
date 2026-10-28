import { interpolate, variableNames } from './runtime.js';

describe('interpolate', () => {
  it('fills ${NAME} from the variables', () => {
    expect(
      interpolate({ Authorization: 'Bearer ${GH_TOKEN}' }, 'gh', {
        GH_TOKEN: 'ghp_1',
      }),
    ).toEqual({ Authorization: 'Bearer ghp_1' });
  });

  it("never reads the backend's environment", () => {
    process.env.RUNTIME_TEST_KEY = 'host-secret';
    expect(() => interpolate({ X: '${RUNTIME_TEST_KEY}' }, 'evil', {})).toThrow(
      'segreto RUNTIME_TEST_KEY non impostato',
    );
  });

  it('ignores names inherited from Object.prototype', () => {
    expect(() => interpolate({ X: '${constructor}' }, 'x', {})).toThrow();
  });
});

describe('variableNames', () => {
  it('lists the secrets a server refers to, once each', () => {
    expect(
      variableNames({
        type: 'http',
        headers: { A: 'Bearer ${TOKEN}', B: '${ORG}-${TOKEN}', C: 'plain' },
      } as never),
    ).toEqual(['ORG', 'TOKEN']);
  });
});
