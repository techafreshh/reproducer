#!/usr/bin/env node
// npm-executable shim: tsx loads the TypeScript CLI as ESM, then hands it argv.
import { register } from "tsx/esm/api";
import { main } from "../src/cli.ts";
register();
process.exit(main(process.argv.slice(2)));
