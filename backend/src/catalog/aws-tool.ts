import { spawn } from 'node:child_process';
import { CommandLineError, parseCommand } from '../missions/command-line.js';

/**
 * The `aws` app tool: the AWS CLI without a shell, read-only operations only,
 * on the account and region the project's secrets name. IAM is the real
 * boundary; this keeps the agent from leaving the project's account, writing
 * files or reading local ones through the CLI.
 */

/** The operations the tool runs, by service. Everything else is refused. */
export const AWS_OPERATIONS: Record<string, readonly string[]> = {
  logs: [
    'describe-log-groups',
    'describe-log-streams',
    'describe-metric-filters',
    'describe-queries',
    'describe-subscription-filters',
    'filter-log-events',
    'get-log-events',
    'get-log-group-fields',
    'get-query-results',
    'list-tags-for-resource',
    'start-query',
    'stop-query',
    'tail',
  ],
  cloudwatch: [
    'describe-alarm-history',
    'describe-alarms',
    'describe-alarms-for-metric',
    'get-dashboard',
    'get-metric-data',
    'get-metric-statistics',
    'list-dashboards',
    'list-metrics',
  ],
};

/** What the agent reads about the tool. */
export const AWS_TOOL_PROMPT = [
  "Runs a read-only AWS CLI command on the project's AWS account, without a shell.",
  'Write it without the leading "aws", e.g. "logs tail /ecs/api --since 1h --filter-pattern ERROR".',
  `Allowed: ${Object.entries(AWS_OPERATIONS)
    .map(([service, ops]) => `${service} (${ops.join(', ')})`)
    .join('; ')}.`,
  'Profile and region are fixed: no --profile, --region, --endpoint-url, --follow or file:// arguments.',
].join(' ');

/**
 * Options the agent may not pass: the account and endpoint are the project's,
 * local files stay unread, and `tail` never follows.
 */
const FORBIDDEN_OPTIONS = [
  '--profile',
  '--region',
  '--endpoint-url',
  '--ca-bundle',
  '--cli-input-json',
  '--cli-input-yaml',
  '--debug',
  '--follow',
  '--no-verify-ssl',
];

/** Secrets of the project that pin the account and the region. */
export const AWS_VARIABLES = ['AWS_PROFILE', 'AWS_REGION'] as const;

export class AwsCommandError extends Error {}

/**
 * The arguments of `aws` for `command`, as the agent writes it without the
 * leading `aws`; throws AwsCommandError when the command isn't allowed.
 */
export function awsArgs(command: string): string[] {
  let argv: string[];
  try {
    argv = parseCommand(command.trim().replace(/^aws\s+/, ''));
  } catch (error) {
    if (error instanceof CommandLineError) {
      throw new AwsCommandError(error.message);
    }
    throw error;
  }
  const [service, operation] = argv;
  const operations = AWS_OPERATIONS[service];
  if (!operations) {
    throw new AwsCommandError(
      `Servizio "${service}" non consentito: solo ${Object.keys(AWS_OPERATIONS).join(', ')}`,
    );
  }
  if (!operation || !operations.includes(operation)) {
    throw new AwsCommandError(
      `Operazione "${service} ${operation ?? ''}" non consentita: solo ${operations.join(', ')}`,
    );
  }
  for (const arg of argv.slice(2)) {
    const option = arg.split('=')[0];
    // The CLI also takes a unique prefix of an option, e.g. --prof.
    const forbidden =
      option.startsWith('--') &&
      option.length > 2 &&
      FORBIDDEN_OPTIONS.some((f) => f.startsWith(option));
    if (forbidden) {
      throw new AwsCommandError(`L'opzione ${option} non è consentita`);
    }
    if (/^fileb?:\/\//i.test(arg)) {
      throw new AwsCommandError('Gli argomenti file:// non sono consentiti');
    }
  }
  return argv;
}

/** Profile and region of the run, from the project's secrets then the user's. */
export function awsEnv(
  variables: Record<string, string>,
): Record<string, string> {
  const missing = AWS_VARIABLES.filter((name) => !variables[name]);
  if (missing.length) {
    throw new AwsCommandError(
      `Segreti non impostati nel progetto: ${missing.join(', ')}`,
    );
  }
  return {
    PATH: process.env.PATH ?? '',
    // The CLI reads ~/.aws for the profile's credentials.
    HOME: process.env.HOME ?? '',
    LANG: 'en_US.UTF-8',
    AWS_PROFILE: variables.AWS_PROFILE,
    AWS_REGION: variables.AWS_REGION,
    AWS_PAGER: '',
  };
}

const TIMEOUT_MS = 60_000;
const OUTPUT_BYTES = 50_000;

export interface AwsResult {
  ok: boolean;
  text: string;
}

/** Runs `aws` with `args` and no shell; keeps the last part of a long output. */
export function runAws(
  args: string[],
  env: Record<string, string>,
  cwd: string,
): Promise<AwsResult> {
  return new Promise((resolve) => {
    const child = spawn('aws', [...args, '--no-cli-pager'], {
      cwd,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: TIMEOUT_MS,
    });
    let output = '';
    let truncated = false;
    const append = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (Buffer.byteLength(output) > OUTPUT_BYTES) {
        output = Buffer.from(output).subarray(-OUTPUT_BYTES).toString('utf8');
        truncated = true;
      }
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', (error) =>
      resolve({ ok: false, text: `aws non avviato: ${error.message}` }),
    );
    child.on('close', (code, signal) => {
      const head = truncated ? '[output troncato: ultimi 50 KB]\n' : '';
      if (signal) {
        resolve({
          ok: false,
          text: `${head}${output}\n[interrotto dopo ${TIMEOUT_MS / 1000}s]`,
        });
      } else {
        resolve({ ok: code === 0, text: head + (output || '(nessun output)') });
      }
    });
  });
}
