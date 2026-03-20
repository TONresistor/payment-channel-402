/**
 * pc402 fetch <url> — Fetch a URL with automatic 402 payment
 */

import { Command } from "commander";
import { createPC402Fetch } from "pc402-fetch";
import { parsePaymentResponse } from "pc402-core";
import { resolveConfig, type CliOpts } from "../config.js";

export function makeFetchCommand(): Command {
  const cmd = new Command("fetch")
    .description("Fetch a URL with automatic HTTP 402 payment")
    .argument("<url>", "URL to fetch")
    .option("-X, --method <method>", "HTTP method", "GET")
    .option("-d, --data <body>", "Request body")
    .option("-H, --header <header...>", "Additional headers (key:value)")
    .option("-v, --verbose", "Print payment details to stderr")
    .option("--json", "Output structured JSON to stdout")
    .action(
      async (
        url: string,
        cmdOpts: { method: string; data?: string; header?: string[]; verbose?: boolean; json?: boolean },
      ) => {
        const config = await resolveConfig(cmd.optsWithGlobals() as CliOpts);

        const fetch402 = createPC402Fetch({
          keyPair: config.keyPair,
          storage: config.storage,
        });

        const init: RequestInit = { method: cmdOpts.method };
        if (cmdOpts.data) init.body = cmdOpts.data;

        if (cmdOpts.header) {
          const headers: Record<string, string> = {};
          for (const h of cmdOpts.header) {
            const idx = h.indexOf(":");
            if (idx > 0) {
              headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
            }
          }
          init.headers = headers;
        }

        try {
          const res = await fetch402(url, init);
          const paymentResponseHeader = res.headers.get("payment-response");
          const paid = paymentResponseHeader !== null;
          const body = await res.text();

          if (paid && cmdOpts.verbose) {
            const pr = parsePaymentResponse(paymentResponseHeader!);
            if (pr?.success) {
              console.error(`[pc402] status: ${res.status}`);
              if (pr.network) console.error(`[pc402] network: ${pr.network}`);
              console.error(`[pc402] payment-response: ${paymentResponseHeader}`);
            }
          } else if (paid && !cmdOpts.json) {
            console.error(`[pc402] Paid (status ${res.status})`);
          }

          if (cmdOpts.json) {
            const out: Record<string, unknown> = {
              status: res.status,
              body,
              paid,
            };
            if (paid) {
              out["headers"] = { "payment-response": paymentResponseHeader };
            }
            console.log(JSON.stringify(out));
          } else {
            console.log(body);
          }

          process.exit(res.ok ? 0 : 1);
        } catch (err) {
          if (cmdOpts.json) {
            console.log(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
          } else {
            console.error("Error:", err instanceof Error ? err.message : err);
          }
          process.exit(1);
        }
      },
    );

  return cmd;
}
