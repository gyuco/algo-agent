import {
  CommandLineError,
  parseCommand,
  testFilterArgs,
  validTestPattern,
} from './command-line.js';

describe('parseCommand', () => {
  it('splits on spaces', () => {
    expect(parseCommand('npm run test -- --watch=false')).toEqual([
      'npm',
      'run',
      'test',
      '--',
      '--watch=false',
    ]);
  });

  it('keeps quoted arguments together, empty ones included', () => {
    expect(parseCommand(`echo "a b" 'c d' ""`)).toEqual([
      'echo',
      'a b',
      'c d',
      '',
    ]);
  });

  it('escapes only inside double quotes', () => {
    expect(parseCommand(`echo "a \\"b\\" c"`)).toEqual(['echo', 'a "b" c']);
    expect(parseCommand(`echo 'a \\ b'`)).toEqual(['echo', 'a \\ b']);
  });

  it('keeps $ and * literal inside quotes', () => {
    expect(parseCommand(`echo "$HOME" '*'`)).toEqual(['echo', '$HOME', '*']);
  });

  it.each([
    'npm test && npm run lint',
    'npm test || true',
    'npm test; npm run lint',
    'npm test | tee out.txt',
    'npm test > out.txt',
    'npm test < in.txt',
    'echo `whoami`',
    'echo $(whoami)',
    'echo $HOME',
    'npm test *',
    '~/bin/test',
  ])('refuses the shell operator in %s', (text) => {
    expect(() => parseCommand(text)).toThrow(CommandLineError);
  });

  it('refuses unclosed quotes and empty commands', () => {
    expect(() => parseCommand(`echo "a`)).toThrow(CommandLineError);
    expect(() => parseCommand('   ')).toThrow(CommandLineError);
  });
});

describe('testFilterArgs', () => {
  it('replaces the marker with one argument', () => {
    expect(testFilterArgs('-- {{pattern}}', 'src/a.spec.ts')).toEqual([
      '--',
      'src/a.spec.ts',
    ]);
    expect(testFilterArgs('-t{{pattern}}', 'x')).toEqual(['-tx']);
  });
});

describe('validTestPattern', () => {
  it('accepts paths and rejects spaces or shell text', () => {
    expect(validTestPattern('src/a.spec.ts')).toBe(true);
    expect(validTestPattern('*login*')).toBe(true);
    expect(validTestPattern('a b')).toBe(false);
    expect(validTestPattern('$(rm)')).toBe(false);
  });
});
