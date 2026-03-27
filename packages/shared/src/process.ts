import { execFile } from "node:child_process";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
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

export async function runCommand(
  command: string,
  args: string[],
): Promise<CommandResult> {
  return await new Promise((resolve) => {
    execFile(command, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error !== null) {
        const exitCode = normalizeExitCode(error);
        resolve({ exitCode, stdout, stderr });
        return;
      }

      resolve({ exitCode: 0, stdout, stderr });
    });
  });
}

export async function runCommandWithInput(
  command: string,
  args: string[],
  input: string,
): Promise<CommandResult> {
  return await new Promise((resolve) => {
    const child = execFile(
      command,
      args,
      { encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error !== null) {
          const exitCode = normalizeExitCode(error);
          resolve({ exitCode, stdout, stderr });
          return;
        }

        resolve({ exitCode: 0, stdout, stderr });
      },
    );

    child.stdin?.end(input);
  });
}
