# fastboot-bun-ts

Cross-platform Fastboot CLI and library for Bun/TypeScript.

## Install

```bash
bun install -g github:enigma550/fastboot-bun-ts
```

Install as a library in another project:

```bash
bun add github:enigma550/fastboot-bun-ts
```

## Structure

- `apps/fastboot`: Fastboot protocol implementation and CLI.
- `apps/usb`: USB transport and host/platform compatibility fixes.
- `packages/contracts`: Shared Effect Schema contracts.
- `packages/shared`: Shared runtime helpers.

## Usage

```bash
bun install
fastboot-bt devices
```

Examples:

```bash
fastboot-bt getvar product
fastboot-bt flash boot ./boot.img
fastboot-bt reboot bootloader
```

## Library API

Basic library usage:

```ts
import { FastbootClient } from "fastboot-bun-ts/fastboot";

const client = await FastbootClient.connect({
  onInfo: (message) => console.error(`(bootloader) ${message}`),
  onText: (message) => process.stdout.write(message),
});

try {
  console.log(await client.getVar("product"));
} finally {
  await client.close();
}
```

Auto-approve host fixes without an interactive `y/n` prompt:

```ts
import { FastbootClient } from "fastboot-bun-ts/fastboot";

const client = await FastbootClient.connect({
  confirmPrivilegedFix: async () => true,
});
```

Disable automatic host fixes completely:

```ts
import { FastbootClient } from "fastboot-bun-ts/fastboot";

const client = await FastbootClient.connect({
  autoApplyPlatformFixes: false,
});
```

Select a specific Fastboot device and flash a partition:

```ts
import { FastbootClient } from "fastboot-bun-ts/fastboot";

const client = await FastbootClient.connect({
  serial: "ZY224XZ4B8",
  confirmPrivilegedFix: async () => true,
});

try {
  await client.flashFile("boot", "./boot.img");
} finally {
  await client.close();
}
```

The library entry points are exported through:

- `fastboot-bun-ts/fastboot`
- `fastboot-bun-ts/usb`
- `fastboot-bun-ts/shared/*`
- `fastboot-bun-ts/contracts/*`

## Known Limitations

- macOS cannot apply the Linux/Windows host-side USB fix; if a Fastboot device hangs or behaves unreliably there, reconnect it through a USB 2.0 hub.

## License

MIT

## Credit

Fastboot protocol credit to Android Open Source Project / Google: https://android.googlesource.com/platform/system/core/+/master/fastboot/
