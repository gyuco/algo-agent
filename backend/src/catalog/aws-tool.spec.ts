import { awsArgs, awsEnv } from './aws-tool.js';

describe('awsArgs', () => {
  it('splits an allowed command, with or without the leading aws', () => {
    expect(awsArgs('logs tail /ecs/api --since 1h')).toEqual([
      'logs',
      'tail',
      '/ecs/api',
      '--since',
      '1h',
    ]);
    expect(
      awsArgs('aws logs filter-log-events --filter-pattern "ERROR 500"'),
    ).toEqual(['logs', 'filter-log-events', '--filter-pattern', 'ERROR 500']);
  });

  it.each([
    ['s3 cp s3://bucket/key /tmp/x', /Servizio "s3"/],
    [
      'logs delete-log-group --log-group-name x',
      /Operazione "logs delete-log-group"/,
    ],
    ['logs', /Operazione "logs "/],
    ['--profile prod logs tail x', /Servizio "--profile"/],
  ])('refuses the command %s', (command, message) => {
    expect(() => awsArgs(command)).toThrow(message);
  });

  it.each([
    'logs tail x --profile prod',
    'logs tail x --region=us-east-1',
    'logs tail x --prof prod',
    'logs tail x --follow',
    'logs tail x --endpoint-url http://evil',
    'logs start-query --cli-input-json {}',
  ])('refuses the options in %s', (command) => {
    expect(() => awsArgs(command)).toThrow(/non è consentita/);
  });

  it('refuses local files', () => {
    expect(() =>
      awsArgs('logs start-query --query-string file:///etc/passwd'),
    ).toThrow(/file:\/\//);
  });

  it('refuses shell operators', () => {
    expect(() => awsArgs('logs tail x; cat ~/.aws/credentials')).toThrow(
      /operatore di shell/,
    );
    expect(() => awsArgs('logs tail $(whoami)')).toThrow(/operatore di shell/);
  });
});

describe('awsEnv', () => {
  it('pins the profile and region and turns the pager off', () => {
    const env = awsEnv({
      AWS_PROFILE: 'cantine',
      AWS_REGION: 'eu-west-1',
      OTHER_SECRET: 'x',
    });
    expect(env).toMatchObject({
      AWS_PROFILE: 'cantine',
      AWS_REGION: 'eu-west-1',
      AWS_PAGER: '',
    });
    expect(env).not.toHaveProperty('OTHER_SECRET');
  });

  it('needs both secrets', () => {
    expect(() => awsEnv({ AWS_REGION: 'eu-west-1' })).toThrow(/AWS_PROFILE/);
  });
});
