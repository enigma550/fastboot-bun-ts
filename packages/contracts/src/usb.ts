import * as Schema from "effect/Schema";

export const UsbEndpointSchema = Schema.Struct({
  address: Schema.Number,
  direction: Schema.Literal("in", "out"),
  transferType: Schema.Number,
  maxPacketSize: Schema.Number,
});

export const UsbInterfaceSchema = Schema.Struct({
  interfaceNumber: Schema.Number,
  alternateSetting: Schema.Number,
  interfaceClass: Schema.Number,
  interfaceSubClass: Schema.Number,
  interfaceProtocol: Schema.Number,
});

export type UsbEndpoint = Schema.Schema.Type<typeof UsbEndpointSchema>;
export type UsbInterface = Schema.Schema.Type<typeof UsbInterfaceSchema>;
