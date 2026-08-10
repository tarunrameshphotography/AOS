/**
 * Starting an HTTP server and failing comprehensibly when the port is taken.
 *
 * WHY THIS IS A MODULE (Stage 4). Every AOS server called `server.listen(...)`
 * and left the `error` event unhandled, so a port collision produced Node's
 * default: a twenty-line `Unhandled 'error' event` stack trace ending in
 * `EADDRINUSE`. That is fine on a developer's machine, where the reader knows
 * what it means. On the office server it is what the operator sees in
 * `supervisor.log` when AOS did not come back after a reboot — repeated every
 * few seconds by the restart backoff — and it does not once say the thing that
 * would actually help: another copy of AOS is already running.
 *
 * The listener still exits non-zero, so the supervisor's restart logic is
 * unchanged. Only the message a human reads is different.
 */

/**
 * @param {import("node:http").Server} server
 * @param {number} port
 * @param {string} host
 * @param {string} name       Human name of this service, for the message.
 * @param {() => void} onListening
 */
export function listenOrExplain(server, port, host, name, onListening) {
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(
        `\n  The AOS ${name} cannot start: port ${port} on ${host} is already in use.\n\n` +
          `  Almost always this means another copy of AOS is already running — a\n` +
          `  \`npm run dev\` in another window, or processes left behind by a\n` +
          `  supervisor that was force-killed rather than stopped.\n\n` +
          `  To see what is holding it:   netstat -ano | findstr :${port}\n` +
          `  To clear AOS's own leftovers: node Backend/free-dev-ports.mjs\n`,
      );
      process.exit(1);
    }
    if (error.code === "EACCES") {
      console.error(
        `\n  The AOS ${name} cannot start: permission denied binding port ${port}.\n` +
          `  Ports below 1024 need an elevated process on Windows. Either run as\n` +
          `  administrator or pick a port above 1024.\n`,
      );
      process.exit(1);
    }
    console.error(`\n  The AOS ${name} failed to start: ${error.message}\n`);
    process.exit(1);
  });

  server.listen(port, host, onListening);
}
