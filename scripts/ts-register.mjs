/**
 * Side-effectful registration for the repository TypeScript resolve hook.
 * Scripts that (transitively) import `./src/*.ts` statically import this
 * module first (or pass it via `--import`), then import TypeScript freely.
 *
 * Uses `module.registerHooks` (in-thread hooks, Node 22.15+/24+) instead of
 * the deprecated `module.register` loader thread (DEP0205 on Node 26).
 */
import { registerHooks } from "node:module";

import { resolve } from "./ts-loader.mjs";

registerHooks({ resolve });
