import { Scribe } from "../src/scribe";

async function main(): Promise<void> {
  const scribe = new Scribe({
    workspacePath: process.env.SCRIBE_WORKSPACE,
  });

  const entries = scribe.readKnowledge("2026-11");
  console.log(JSON.stringify(entries, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
