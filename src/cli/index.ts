// CLI entry point — routes to discover or replay subcommands.
//
// Flag reference (ARCHITECTURE.md §3 and §4):
//
// discover:
//   --name          Capability name
//   --goal          Natural-language goal description
//   --input         Key=value input pair (repeatable)
//   --input-type    Type declaration key:type:pattern (repeatable)
//   --output        Output declaration key:type (repeatable)
//   --app           Target app identifier
//   --start         Start path / URL
//
// replay:
//   <capability>    Positional: capability name to replay
//   --<inputKey>    Dynamic flags matching artifact's declared inputs
//   --attended      Enable attended mode (human escalation)
//   --allow-risky   Permit execution of risky steps

// Load .env so users don't need to export vars manually
import { resolve } from 'node:path';
import { loadEnvFile } from '../discovery/openai-client.js';
loadEnvFile(resolve(process.cwd(), '.env'));

const args = process.argv.slice(2);
const command = args[0];

function printUsage(): void {
  console.log(`computeruse-automation-system

Usage:
  npm run cli -- <command> [options]

Commands:
  discover    Discover a capability via LLM-driven exploration
  replay      Replay a recorded capability artifact deterministically
  approve     Approve a capability for production use
  revoke      Revoke approval for a capability
  trust       View trust status and promotion dossier

discover options:
  --name <name>              Capability name
  --goal <goal>              Natural-language goal
  --input <key=value>        Input pair (repeatable)
  --input-type <key:type:re> Input type declaration (repeatable)
  --output <key:type>        Output declaration (repeatable)
  --app <app-id>             Target application identifier
  --app-description <desc>   One-line description of the target application
  --start <path>             Start path / URL

replay options:
  <capability>               Capability name (positional)
  --<inputKey> <value>       Input values matching artifact's declared inputs
  --attended                 Enable attended mode (human escalation)
  --allow-risky              Allow execution of risky steps

Examples:
  npm run cli -- discover --name lookup-balance \\
    --goal "Look up the account and read the balance" \\
    --input accountId=12345 --input-type "accountId:string:^[0-9]{5}$" \\
    --output "balance:money" --app vendor-console \\
    --app-description "a legacy operator console" \\
    --start /search

  npm run cli -- replay lookup-balance --accountId 12345`);
}

if (!command || command === '--help' || command === '-h') {
  printUsage();
  process.exit(0);
}

if (command === 'discover') {
  const { runDiscover } = await import('./discover.js');
  await runDiscover(args.slice(1));
} else if (command === 'replay') {
  const { runReplay } = await import('./replay.js');
  await runReplay(args.slice(1));
} else if (command === 'approve') {
  const { approveCapability } = await import('../guardrails/trust.js');
  const capName = args[1];
  if (!capName) { console.error('Usage: approve <capability> [--version x.y.z] [--note "..."]'); process.exit(1); }
  const vFlag = args.indexOf('--version');
  const version = vFlag >= 0 ? args[vFlag + 1] : '1.0.0';
  const nFlag = args.indexOf('--note');
  const note = nFlag >= 0 ? args[nFlag + 1] : undefined;
  const entry = approveCapability(capName, version, note);
  console.log(`Approved: ${capName}@${version} by ${entry.approvedBy} at ${entry.approvedAt}`);
  if (note) console.log(`  Note: ${note}`);
} else if (command === 'revoke') {
  const { revokeCapability, getTrustStatus } = await import('../guardrails/trust.js');
  const capName = args[1];
  if (!capName) { console.error('Usage: revoke <capability> [--version x.y.z]'); process.exit(1); }
  const vFlag = args.indexOf('--version');
  const version = vFlag >= 0 ? args[vFlag + 1] : '1.0.0';
  const before = getTrustStatus(capName, version);
  if (before.status === 'manual') {
    console.log(`${capName}@${version} is already unapproved (status: manual).`);
  } else {
    revokeCapability(capName, version);
    console.log(`Revoked: ${capName}@${version} (was approved by ${before.approvedBy} at ${before.approvedAt})`);
  }
} else if (command === 'trust') {
  const { getTrustStatus, computeDossier } = await import('../guardrails/trust.js');
  const capName = args[1];
  if (!capName) { console.error('Usage: trust <capability> [--version x.y.z]'); process.exit(1); }
  const vFlag = args.indexOf('--version');
  const version = vFlag >= 0 ? args[vFlag + 1] : '1.0.0';
  const trust = getTrustStatus(capName, version);
  const dossier = computeDossier(capName, version);
  console.log(`Trust status for ${capName}@${version}:`);
  console.log(`  Status:        ${trust.status}`);
  if (trust.approvedBy) console.log(`  Approved by:   ${trust.approvedBy}`);
  if (trust.approvedAt) console.log(`  Approved at:   ${trust.approvedAt}`);
  if (trust.note) console.log(`  Note:          ${trust.note}`);
  console.log(`\nPromotion dossier:`);
  console.log(`  Run count:     ${dossier.runCount}`);
  console.log(`  Success count: ${dossier.successCount}`);
  console.log(`  Success rate:  ${dossier.successRate}`);
  console.log(`  Interventions: ${dossier.interventionCount}`);
  console.log(`  Gate stops:    ${dossier.gateStops}`);
  console.log(`  Note:          ${dossier.note}`);
} else {
  console.error(`Unknown command: ${command}`);
  printUsage();
  process.exit(1);
}
