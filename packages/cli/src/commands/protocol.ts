/**
 * pc402 protocol decode/encode — Inspect and build pc402 headers
 */

import { Command } from "commander";
import { readFileSync } from "node:fs";
import { decodeHeader, encodeHeader } from "pc402-core";

function detectType(obj: Record<string, unknown>): string {
  if (typeof obj.success === "boolean") return "PAYMENT-RESPONSE";
  if (typeof obj.x402Version === "number" && typeof obj.scheme === "string")
    return "PAYMENT-SIGNATURE";
  if (typeof obj.scheme === "string") return "PAYMENT-REQUIRED";
  return "unknown";
}

export function makeProtocolCommand(): Command {
  const cmd = new Command("protocol").description("Encode/decode pc402 protocol headers");

  cmd
    .command("decode <base64>")
    .description("Decode a pc402 header and pretty-print JSON (use - to read from stdin)")
    .action((b64: string) => {
      if (b64 === "-") {
        b64 = readFileSync("/dev/stdin", "utf-8").trim();
      }
      const obj = decodeHeader<Record<string, unknown>>(b64);
      if (obj === null) {
        console.error("Error: failed to decode header (invalid base64 or JSON)");
        process.exit(1);
      }
      const type = detectType(obj);
      if (type !== "unknown") {
        console.error(`[pc402] Type: ${type}`);
      }
      console.log(JSON.stringify(obj, null, 2));
    });

  cmd
    .command("encode <json>")
    .description("Encode a JSON string to pc402 base64 header format")
    .action((json: string) => {
      let obj: unknown;
      try {
        obj = JSON.parse(json);
      } catch {
        console.error("Error: invalid JSON");
        process.exit(1);
      }
      console.log(encodeHeader(obj));
    });

  return cmd;
}
