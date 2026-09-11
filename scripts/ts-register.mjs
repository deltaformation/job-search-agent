/**
 * Side-effectful registration for the repository TypeScript resolve hook.
 * Scripts that (transitively) import `./src/*.ts` statically import this
 * module first, then dynamic-import TypeScript freely.
 */
import { register } from "node:module";

register("./ts-loader.mjs", import.meta.url);
