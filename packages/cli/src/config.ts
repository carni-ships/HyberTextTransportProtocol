import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const CONFIG_DIR  = path.join(os.homedir(), '.hybertext');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export interface Config {
  rpc?:              string;
  /** Additional RPC URLs to try on failure, comma-separated or as an array. */
  rpcFallbacks?:     string;
  privateKey?:       string;
  /** Base URL of your HyberText gateway, e.g. https://hybertext-mcp.account.workers.dev */
  gatewayUrl?:       string;
  /**
   * Shell command whose stdout is the private key, e.g. "op read op://vault/key".
   * Used when `privateKey` is not set. Set via HYBERTEXT_KEY_COMMAND env var or
   * `hybertext config set keyCommand "..."`
   */
  keyCommand?:       string;
  registryAddress?:  string;
  indexAddress?:     string;
  vaultAddress?:     string; // HyberKeyVault contract address
  vaultPubkey?:      string; // Worker's X25519 public key (32-byte hex)
  paymentRecipient?: string; // Address receiving BERA payments (defaults to publisher)
  executorAddress?:  string; // HyberDeployExecutor contract address (EIP-7702)
}

export function loadConfig(): Config {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) as Config;
  } catch {
    return {};
  }
}

export function saveConfig(updates: Partial<Config>): void {
  const current = loadConfig();
  const next = { ...current, ...updates };
  // Remove keys explicitly set to empty string
  for (const k of Object.keys(next) as (keyof Config)[]) {
    if (next[k] === '') delete next[k];
  }
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + '\n');
}

/**
 * Resolve a config value: CLI flag → env var → saved config → default.
 * If no private key is found and keyCommand is configured, runs the command
 * synchronously and uses its stdout as the private key.
 */
export function resolveConfig(flags: {
  rpc?:              string;
  key?:              string;
  registry?:         string;
  index?:            string;
  vault?:            string;
  vaultPubkey?:      string;
  paymentRecipient?: string;
  executor?:         string;
}): Required<Pick<Config, 'rpc'>> & Omit<Config, 'rpc'> {
  const stored     = loadConfig();
  const keyCommand = stored.keyCommand ?? process.env.HYBERTEXT_KEY_COMMAND;

  // Resolve private key: flag → env → config → key command
  let privateKey: string | undefined =
    flags.key ?? stored.privateKey ?? process.env.PRIVATE_KEY;

  if (!privateKey && keyCommand) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { execSync } = require('child_process') as typeof import('child_process');
      const out = execSync(keyCommand, { encoding: 'utf8', timeout: 10_000 }).trim();
      if (out) privateKey = out;
    } catch (e: any) {
      // Non-fatal — commands will fail with "private key required" if still unset
      process.stderr.write(`Warning: key command failed: ${e.message}\n`);
    }
  }

  return {
    rpc:              flags.rpc              ?? stored.rpc              ?? process.env.BERACHAIN_RPC      ?? 'https://rpc.berachain.com',
    rpcFallbacks:     stored.rpcFallbacks    ?? process.env.BERACHAIN_RPC_FALLBACKS,
    privateKey,
    keyCommand,
    gatewayUrl:       stored.gatewayUrl      ?? process.env.HYBERTEXT_GATEWAY_URL ?? 'https://hybertext.xyz',
    registryAddress:  flags.registry         ?? stored.registryAddress  ?? process.env.REGISTRY_ADDRESS,
    indexAddress:     flags.index            ?? stored.indexAddress     ?? process.env.HYBERINDEX_ADDRESS,
    vaultAddress:     flags.vault            ?? stored.vaultAddress     ?? process.env.VAULT_ADDRESS,
    vaultPubkey:      flags.vaultPubkey      ?? stored.vaultPubkey      ?? process.env.VAULT_PUBKEY,
    paymentRecipient: flags.paymentRecipient ?? stored.paymentRecipient ?? process.env.PAYMENT_RECIPIENT,
    executorAddress:  flags.executor         ?? stored.executorAddress  ?? process.env.EXECUTOR_ADDRESS,
  };
}

/**
 * Build a list of RPC URLs from config: primary first, then fallbacks.
 * Pass this to functions that accept `string | string[]` for automatic failover.
 */
export function resolveRpcList(cfg: ReturnType<typeof resolveConfig>): string[] {
  const primary   = cfg.rpc;
  const fallbacks = (cfg.rpcFallbacks ?? '').split(',').map(s => s.trim()).filter(Boolean);
  return [primary, ...fallbacks];
}

export { CONFIG_FILE };
