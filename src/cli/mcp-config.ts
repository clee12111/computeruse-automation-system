// src/cli/mcp-config.ts — Prints the claude_desktop_config.json block for THIS machine.
// Resolves absolute cwd at runtime, correct command per platform.

import { resolve } from 'node:path';
import { platform } from 'node:os';

const cwd = resolve('.');
const isWindows = platform() === 'win32';

// Claude Desktop doesn't reliably honor `cwd`, so we bake cd into the command.
// Windows: cmd /c "cd /d <path> && npx tsx ..."
// macOS/Linux: bash -c "cd <path> && npx tsx ..."
const command = isWindows ? 'cmd' : 'bash';
const escapedCwd = isWindows ? cwd.replace(/\//g, '\\') : cwd;
const innerCmd = `cd ${isWindows ? '/d ' : ''}"${escapedCwd}" && npx tsx src/mcp/server.ts`;
const args = isWindows ? ['/c', innerCmd] : ['-c', innerCmd];

const config = {
  mcpServers: {
    'computeruse-automation': {
      command,
      args,
      env: {
        CONSOLE_USER: '',
        CONSOLE_PASS: '',
      },
    },
  },
};

// Config file location per OS
const configPaths: Record<string, string> = {
  win32: '%APPDATA%\\Claude\\claude_desktop_config.json',
  darwin: '~/Library/Application Support/Claude/claude_desktop_config.json',
  linux: '~/.config/Claude/claude_desktop_config.json',
};
const configPath = configPaths[platform()] || configPaths.linux;

console.log(`\nClaude Desktop MCP configuration for this machine:\n`);
console.log(`Config file: ${configPath}\n`);
console.log(`Add this to your claude_desktop_config.json:\n`);
console.log(JSON.stringify(config, null, 2));
console.log(`\n⚠️  Fill in CONSOLE_USER and CONSOLE_PASS with real values.`);
console.log(`   Never commit credentials to the config file.\n`);
