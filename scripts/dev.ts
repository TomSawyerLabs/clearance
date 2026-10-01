export {};

// `bun run dev`: the API server with reload-on-save, and Vite in front of it
// serving the UI with hot reload. Open the Vite address (http://localhost:5173).

const children = [
  Bun.spawn(["bun", "--watch", "src/entry/bun.ts"], {
    stdio: ["inherit", "inherit", "inherit"],
  }),
  Bun.spawn(["bun", "x", "--bun", "vite"], {
    stdio: ["inherit", "inherit", "inherit"],
  }),
];

const stop = () => {
  for (const child of children) child.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

// If either one dies, stop the other instead of leaving half a dev setup running.
await Promise.race(children.map((child) => child.exited));
stop();
