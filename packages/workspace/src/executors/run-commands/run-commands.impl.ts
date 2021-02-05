import { exec, execSync } from 'child_process';
import * as yargsParser from 'yargs-parser';

export const LARGE_BUFFER = 1024 * 1000000;

interface Params<T, R> {
  /**
   * The input collection that will feed the tasks
   */
  collection: T[];
  /**
   * A function that takes an item from the collection and returns a result
   */
  task: (t: T, index: number) => Promise<R>;
  /**
   * The max number of concurrent tasks. If not provided, all tasks are ran at
   * once
   */
  maxConcurrency?: number;
}

/**
 * Like `Promise.all` but you can specify how many concurrent tasks you want at once.
 */
async function pool<T, R>({
  collection,
  task,
  maxConcurrency,
}: Params<T, R>): Promise<R[]> {
  if (!maxConcurrency) {
    return Promise.all(collection.map((item, i) => task(item, i)));
  }

  if (!collection.length) {
    return [];
  }

  const results: Array<[R, number]> = [];
  const mutableCollection = collection
    .slice()
    .map((t, i) => [t, i] as [T, number]);

  let available = maxConcurrency;
  let done = false;
  let globalResolve!: () => void;
  let globalReject!: (err: Error) => void;
  const finalPromise = new Promise<void>((resolve, reject) => {
    globalResolve = resolve;
    globalReject = reject;
  });

  const listeners = new Set<() => void>();
  function notify() {
    for (const listener of listeners) {
      listener();
    }
  }
  function ready() {
    return new Promise<void>((resolve) => {
      const listener = () => {
        if (done) {
          listeners.delete(listener);
          resolve();
        } else if (available > 0) {
          listeners.delete(listener);
          available -= 1;
          resolve();
        }
      };

      listeners.add(listener);
      notify();
    });
  }

  while (true) {
    const value = mutableCollection.shift();
    if (!value) break;
    if (done) break;

    const [t, i] = value;

    await ready();

    task(t, i)
      .then((r) => {
        results.push([r, i]);
        available += 1;

        if (results.length === collection.length) {
          done = true;
          globalResolve();
        }
      })
      .catch((e) => {
        done = true;
        globalReject(e);
      })
      .finally(notify);
  }

  await finalPromise;

  return results
    .slice()
    .sort(([, a], [, b]) => a - b)
    .map(([r]) => r);
}

function loadEnvVars(path?: string) {
  if (path) {
    const result = require('dotenv').config({ path });
    if (result.error) {
      throw result.error;
    }
  } else {
    try {
      require('dotenv').config();
    } catch (e) {}
  }
}

export type Json = { [k: string]: any };
export interface RunCommandsBuilderOptions extends Json {
  command?: string;
  commands?: (
    | {
        command: string;
        forwardAllArgs?: boolean;
      }
    | string
  )[];
  color?: boolean;
  parallel?: boolean;
  maxParallel?: number;
  readyWhen?: string;
  cwd?: string;
  args?: string;
  envFile?: string;
  outputPath?: string;
}

const propKeys = [
  'command',
  'commands',
  'color',
  'parallel',
  'maxParallel',
  'readyWhen',
  'cwd',
  'args',
  'envFile',
  'outputPath',
];

export interface NormalizedRunCommandsBuilderOptions
  extends RunCommandsBuilderOptions {
  commands: {
    command: string;
    forwardAllArgs?: boolean;
  }[];
  parsedArgs: { [k: string]: any };
}

export default async function (
  options: RunCommandsBuilderOptions
): Promise<{ success: boolean }> {
  loadEnvVars(options.envFile);
  const normalized = normalizeOptions(options);

  if (options.readyWhen && !options.parallel) {
    throw new Error(
      'ERROR: Bad builder config for @nrwl/run-commands - "readyWhen" can only be used when parallel=true'
    );
  }

  if (options.maxParallel && !options.parallel) {
    throw new Error(
      'ERROR: Bad builder config for @nrwl/run-commands - "maxParallel" can only be used when parallel=true'
    );
  }

  try {
    const success = options.parallel
      ? await runInParallel(normalized)
      : await runSerially(normalized);
    return { success };
  } catch (e) {
    throw new Error(
      `ERROR: Something went wrong in @nrwl/run-commands - ${e.message}`
    );
  }
}

async function runInParallel(options: NormalizedRunCommandsBuilderOptions) {
  if (options.readyWhen) {
    const procs = options.commands.map((c) =>
      createProcess(
        c.command,
        options.readyWhen,
        options.color,
        options.cwd
      ).then((result) => ({
        result,
        command: c.command,
      }))
    );
    const r = await Promise.race(procs);
    if (!r.result) {
      process.stderr.write(
        `Warning: @nrwl/run-commands command "${r.command}" exited with non-zero status code`
      );
      return false;
    } else {
      return true;
    }
  } else {
    const r = await pool({
      collection: options.commands,
      maxConcurrency: options.maxParallel,
      task: async (c: { command: string; forwardAllArgs?: boolean }) =>
        createProcess(
          c.command,
          options.readyWhen,
          options.color,
          options.cwd
        ).then((result) => ({
          result,
          command: c.command,
        })),
    });
    const failed = r.filter((v) => !v.result);
    if (failed.length > 0) {
      failed.forEach((f) => {
        process.stderr.write(
          `Warning: @nrwl/run-commands command "${f.command}" exited with non-zero status code`
        );
      });
      return false;
    } else {
      return true;
    }
  }
}

function normalizeOptions(
  options: RunCommandsBuilderOptions
): NormalizedRunCommandsBuilderOptions {
  options.parsedArgs = parseArgs(options);

  if (options.command) {
    options.commands = [{ command: options.command }];
    options.parallel = false;
  } else {
    options.commands = options.commands.map((c) =>
      typeof c === 'string' ? { command: c } : c
    );
  }
  (options as NormalizedRunCommandsBuilderOptions).commands.forEach((c) => {
    c.command = transformCommand(
      c.command,
      (options as NormalizedRunCommandsBuilderOptions).parsedArgs,
      c.forwardAllArgs ?? true
    );
  });
  return options as any;
}

async function runSerially(options: NormalizedRunCommandsBuilderOptions) {
  for (const c of options.commands) {
    createSyncProcess(c.command, options.color, options.cwd);
  }
  return true;
}

function createProcess(
  command: string,
  readyWhen: string,
  color: boolean,
  cwd: string
): Promise<boolean> {
  return new Promise((res) => {
    const childProcess = exec(command, {
      maxBuffer: LARGE_BUFFER,
      env: processEnv(color),
      cwd,
    });
    /**
     * Ensure the child process is killed when the parent exits
     */
    process.on('exit', () => childProcess.kill());
    childProcess.stdout.on('data', (data) => {
      process.stdout.write(data);
      if (readyWhen && data.toString().indexOf(readyWhen) > -1) {
        res(true);
      }
    });
    childProcess.stderr.on('data', (err) => {
      process.stderr.write(err);
      if (readyWhen && err.toString().indexOf(readyWhen) > -1) {
        res(true);
      }
    });
    childProcess.on('close', (code) => {
      if (!readyWhen) {
        res(code === 0);
      }
    });
  });
}

function createSyncProcess(command: string, color: boolean, cwd: string) {
  execSync(command, {
    env: processEnv(color),
    stdio: [0, 1, 2],
    maxBuffer: LARGE_BUFFER,
    cwd,
  });
}

function processEnv(color: boolean) {
  const env = { ...process.env };
  if (color) {
    env.FORCE_COLOR = `${color}`;
  }
  return env;
}

function transformCommand(
  command: string,
  args: { [key: string]: string },
  forwardAllArgs: boolean
) {
  if (command.indexOf('{args.') > -1) {
    const regex = /{args\.([^}]+)}/g;
    return command.replace(regex, (_, group: string) => args[camelCase(group)]);
  } else if (Object.keys(args).length > 0 && forwardAllArgs) {
    const stringifiedArgs = Object.keys(args)
      .map((a) => `--${a}=${args[a]}`)
      .join(' ');
    return `${command} ${stringifiedArgs}`;
  } else {
    return command;
  }
}

function parseArgs(options: RunCommandsBuilderOptions) {
  const args = options.args;
  if (!args) {
    const unknownOptionsTreatedAsArgs = Object.keys(options)
      .filter((p) => propKeys.indexOf(p) === -1)
      .reduce((m, c) => ((m[camelCase(c)] = options[c]), m), {});
    return unknownOptionsTreatedAsArgs;
  }
  return yargsParser(args.replace(/(^"|"$)/g, ''), {
    configuration: { 'camel-case-expansion': true },
  });
}

function camelCase(input) {
  if (input.indexOf('-') > 1) {
    return input
      .toLowerCase()
      .replace(/-(.)/g, (match, group1) => group1.toUpperCase());
  } else {
    return input;
  }
}
