#!/usr/bin/env node
// npm-executable shim: tsx resolves the TS CLI graph (.ts sources, .js specifiers),
// so this works on any Node >=22 — raw type-stripping would not map ./x.js -> ./x.ts.
import { tsImport } from "tsx/esm/api";
const { main } = await tsImport("../src/cli.ts", import.meta.url);
process.exit(main(process.argv.slice(2)));
