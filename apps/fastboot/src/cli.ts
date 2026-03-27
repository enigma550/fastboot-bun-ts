#!/usr/bin/env bun

import { basename } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { listFastbootDevices } from "fastboot-bun-ts/usb";

import { FastbootClient } from "./client";

interface ParsedArgs {
  command: string | undefined;
  positional: string[];
  serial?: string;
  noAutoFix: boolean;
  yesFix: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  let serial: string | undefined;
  let noAutoFix = false;
  let yesFix = false;

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === undefined) {
      break;
    }

    if (value === "--serial" || value === "-s") {
      serial = argv[index + 1];
      index += 1;
      continue;
    }

    if (value === "--no-auto-fix") {
      noAutoFix = true;
      continue;
    }

    if (value === "--yes-fix") {
      yesFix = true;
      continue;
    }

    positional.push(value);
  }

  return {
    command: positional[0],
    positional: positional.slice(1),
    serial,
    noAutoFix,
    yesFix,
  };
}

function printHelp(): void {
  console.log(`fastboot-bun-ts

Usage:
  fastboot-bt devices
  fastboot-bt getvar <name> [--serial SERIAL]
  fastboot-bt flash <partition> <file> [--serial SERIAL]
  fastboot-bt download <file> [--serial SERIAL]
  fastboot-bt boot <file> [--serial SERIAL]
  fastboot-bt erase <partition> [--serial SERIAL]
  fastboot-bt reboot [target] [--serial SERIAL]
  fastboot-bt set-active <slot> [--serial SERIAL]
  fastboot-bt oem <command...> [--serial SERIAL]
  fastboot-bt ... --yes-fix
`);
}

async function askForPrivilegedFix(message: string): Promise<boolean> {
  if (!input.isTTY || !output.isTTY) {
    throw new Error(
      `${message}\nInteractive confirmation is required before auto-fix can request admin/root rights. Re-run in a terminal, pass '--yes-fix', or use '--no-auto-fix'.`,
    );
  }

  const readline = createInterface({ input, output });

  try {
    const answer = await readline.question(`${message} [y/N] `);
    return ["y", "yes"].includes(answer.trim().toLowerCase());
  } finally {
    readline.close();
  }
}

async function withClient(
  parsed: ParsedArgs,
  work: (client: FastbootClient) => Promise<void>,
): Promise<void> {
  const client = await FastbootClient.connect({
    serial: parsed.serial,
    autoApplyPlatformFixes: !parsed.noAutoFix,
    confirmPrivilegedFix: parsed.yesFix
      ? () => Promise.resolve(true)
      : askForPrivilegedFix,
    onInfo: (message) => console.error(`(bootloader) ${message}`),
    onText: (message) => process.stdout.write(message),
  });

  try {
    await work(client);
  } finally {
    await client.close();
  }
}

async function run(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));

  switch (parsed.command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;

    case "devices": {
      const devices = await listFastbootDevices();
      for (const device of devices) {
        const label = device.serialNumber ?? device.path;
        const product = device.product ?? "unknown-product";
        console.log(`${label}\tfastboot\t${product}`);
      }
      return;
    }

    case "getvar": {
      const [name] = parsed.positional;
      if (name === undefined) {
        throw new Error("Missing variable name.");
      }

      await withClient(parsed, async (client) => {
        const value = await client.getVar(name);
        console.log(value);
      });
      return;
    }

    case "flash": {
      const [partition, filePath] = parsed.positional;
      if (partition === undefined || filePath === undefined) {
        throw new Error("Usage: flash <partition> <file>");
      }

      await withClient(parsed, async (client) => {
        console.error(`Sending '${basename(filePath)}'`);
        await client.flashFile(partition, filePath);
        console.error(`Flashed '${partition}'`);
      });
      return;
    }

    case "download": {
      const [filePath] = parsed.positional;
      if (filePath === undefined) {
        throw new Error("Usage: download <file>");
      }

      await withClient(parsed, async (client) => {
        console.error(`Sending '${basename(filePath)}'`);
        await client.downloadFile(filePath);
        console.error("Download completed");
      });
      return;
    }

    case "boot": {
      const [filePath] = parsed.positional;
      if (filePath === undefined) {
        throw new Error("Usage: boot <file>");
      }

      await withClient(parsed, async (client) => {
        await client.bootFile(filePath);
        console.error(`Booted '${basename(filePath)}'`);
      });
      return;
    }

    case "erase": {
      const [partition] = parsed.positional;
      if (partition === undefined) {
        throw new Error("Usage: erase <partition>");
      }

      await withClient(parsed, async (client) => {
        console.log(await client.erase(partition));
      });
      return;
    }

    case "reboot": {
      const [target] = parsed.positional;
      await withClient(parsed, async (client) => {
        console.log(await client.reboot(target));
      });
      return;
    }

    case "set-active": {
      const [slot] = parsed.positional;
      if (slot === undefined) {
        throw new Error("Usage: set-active <slot>");
      }

      await withClient(parsed, async (client) => {
        console.log(await client.setActive(slot));
      });
      return;
    }

    case "oem": {
      if (parsed.positional.length === 0) {
        throw new Error("Usage: oem <command...>");
      }

      await withClient(parsed, async (client) => {
        console.log(await client.oem(parsed.positional.join(" ")));
      });
      return;
    }

    default:
      throw new Error(`Unknown command '${parsed.command}'.`);
  }
}

await run();
