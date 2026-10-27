#!/usr/bin/env node
// npm-executable shim: tsx resolves the TS CLI graph (.ts sources, .js specifiers),
// so this works on any Node >=22 — raw type-stripping would not map ./x.js -> ./x.ts.
import { tsImport } from "tsx/esm/api";
const { main } = await tsImport("../src/cli.ts", import.meta.url);
const code = main(process.argv.slice(2));
if (code instanceof Promise) {
  code.then(
    (exitCode) => process.exit(exitCode),
    (error) => {
      console.log(error instanceof Error ? error.message : String(error));
      process.exit(2);
    },
  );
} else {
  process.exit(code);
}
