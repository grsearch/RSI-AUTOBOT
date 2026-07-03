import { prisma } from "../src/db.js";
import { collectShadowPairDiagnostics } from "../src/services/shadow-diagnostics.js";

const countArgument = process.argv.find((value) => value.startsWith("--count="));
const sampleSize = countArgument ? Number(countArgument.slice("--count=".length)) : 3;

try {
  const report = await collectShadowPairDiagnostics(sampleSize);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
