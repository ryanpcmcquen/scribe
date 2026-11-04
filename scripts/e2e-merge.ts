import { Scribe } from "../src/scribe";

async function main(): Promise<void> {
  const scribe = new Scribe({
    workspacePath: process.env.SCRIBE_WORKSPACE,
  });

  const focus = scribe.compose("2026-11");
  console.log(JSON.stringify(focus, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
