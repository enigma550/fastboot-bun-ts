import * as Schema from "effect/Schema";

export const FastbootResponseKindSchema = Schema.Literal(
  "INFO",
  "TEXT",
  "DATA",
  "OKAY",
  "FAIL",
);

export const FastbootDeviceSchema = Schema.Struct({
  idVendor: Schema.Number,
  idProduct: Schema.Number,
  bcdUSB: Schema.Number,
  bcdDevice: Schema.Number,
  serialNumber: Schema.NullOr(Schema.String),
  product: Schema.NullOr(Schema.String),
  manufacturer: Schema.NullOr(Schema.String),
  interfaceNumber: Schema.Number,
  path: Schema.String,
});

export const FastbootStatusPacketSchema = Schema.Struct({
  kind: FastbootResponseKindSchema,
  payload: Schema.String,
});

export const PlatformFixSchema = Schema.Struct({
  platform: Schema.Literal("linux", "windows", "darwin", "unknown"),
  required: Schema.Boolean,
  applied: Schema.Boolean,
  requiresReplug: Schema.Boolean,
  summary: Schema.String,
});

export type FastbootDevice = Schema.Schema.Type<typeof FastbootDeviceSchema>;
export type FastbootStatusPacket = Schema.Schema.Type<
  typeof FastbootStatusPacketSchema
>;
export type PlatformFix = Schema.Schema.Type<typeof PlatformFixSchema>;
