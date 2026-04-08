import { execFile } from "node:child_process";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

function normalizeExitCode(error: { code?: string | number | null }): number {
  if (typeof error.code === "number") {
    return error.code;
  }

  if (error.code === "ENOENT") {
    return 127;
  }

  return 1;
}

function isTimedOut(error: {
  code?: string | number | null;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
}): boolean {
  return error.code === "ETIMEDOUT" || error.killed === true || error.signal === "SIGKILL";
}

export async function runCommand(
  command: string,
  args: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  return await new Promise((resolve) => {
    execFile(command, args, {
      cwd: options.cwd,
      encoding: "utf8",
      env: options.env,
      killSignal: "SIGKILL",
      timeout: options.timeoutMs,
    }, (error, stdout, stderr) => {
      if (error !== null) {
        const timedOut = isTimedOut(error);
        const exitCode = timedOut ? 124 : normalizeExitCode(error);
        resolve({ exitCode, stdout, stderr, timedOut });
        return;
      }

      resolve({ exitCode: 0, stdout, stderr, timedOut: false });
    });
  });
}

export async function runCommandWithInput(
  command: string,
  args: string[],
  input: string,
  options: CommandOptions = {},
): Promise<CommandResult> {
  return await new Promise((resolve) => {
    const child = execFile(
      command,
      args,
      {
        cwd: options.cwd,
        encoding: "utf8",
        env: options.env,
        killSignal: "SIGKILL",
        timeout: options.timeoutMs,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          const timedOut = isTimedOut(error);
          const exitCode = timedOut ? 124 : normalizeExitCode(error);
          resolve({ exitCode, stdout, stderr, timedOut });
          return;
        }

        resolve({ exitCode: 0, stdout, stderr, timedOut: false });
      },
    );

    child.stdin?.end(input);
  });
}
