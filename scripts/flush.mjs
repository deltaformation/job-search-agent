/**
 * Plain-JS twin of the logger flush barrier for `.mjs` scripts: an empty
 * write resolves only after earlier writes flush, so awaiting this before
 * exit keeps final lines from being dropped when the loop drains.
 */
export function flushStdio() {
  const drain = (stream) =>
    new Promise((resolveDrain) => {
      try {
        stream.write("", () => resolveDrain());
      } catch {
        resolveDrain();
      }
    });
  return Promise.all([drain(process.stdout), drain(process.stderr)]).then(
    () => undefined,
  );
}
