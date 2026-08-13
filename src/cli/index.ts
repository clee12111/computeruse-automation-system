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

const args = process.argv.slice(2);
const command = args[0];

function printUsage(): void {
  console.log(`computeruse-automation-system

Usage:
  npm run cli -- <command> [options]

Commands:
  discover    Discover a capability via LLM-driven exploration
  replay      Replay a recorded capability artifact deterministically

discover options:
  --name <name>              Capability name
  --goal <goal>              Natural-language goal
  --input <key=value>        Input pair (repeatable)
  --input-type <key:type:re> Input type declaration (repeatable)
  --output <key:type>        Output declaration (repeatable)
  --app <app-id>             Target application identifier
  --start <path>             Start path / URL

replay options:
  <capability>               Capability name (positional)
  --<inputKey> <value>       Input values matching artifact's declared inputs
  --attended                 Enable attended mode (human escalation)
  --allow-risky              Allow execution of risky steps

Examples:
  npm run cli -- discover --name lookup-member-savings-balance \\
    --goal "Look up the member and read their savings account balance" \\
    --input memberId=12345 --input-type "memberId:string:^[0-9]{5}$" \\
    --output "savingsBalance:money" --app vendor-console \\
    --start /t/cascade-cu/search

  npm run cli -- replay lookup-member-savings-balance --memberId 12345`);
}

if (!command || command === '--help' || command === '-h') {
  printUsage();
  process.exit(0);
}

if (command === 'discover') {
  console.log('discover: not implemented (Phase 5)');
  process.exit(1);
} else if (command === 'replay') {
  console.log('replay: not implemented (Phase 4)');
  process.exit(1);
} else {
  console.error(`Unknown command: ${command}`);
  printUsage();
  process.exit(1);
}
