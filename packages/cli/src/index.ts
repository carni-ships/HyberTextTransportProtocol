import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { Command } from 'commander';
import { packPath, detectFunctions } from './pack';
import { publishSite, publishWithFunctions, publishEncryptedSite } from './publish';
import { publishDirectoryV4 } from './publishV4';
import { detectFramework, runBuild } from './detect';
import { generateVaultKeypair, derivePublicKey } from './encrypt';
import { setup7702, revoke7702, check7702 } from './setup7702';
import { setAlias, resolveAlias } from './aliases';
import { loadConfig, saveConfig, resolveConfig, resolveRpcList, CONFIG_FILE } from './config';
import { CHUNK_SIZE } from './pack';

const program = new Command();

/** Return the configured gateway base URL with any trailing slash removed. */
function gw(cfg: ReturnType<typeof resolveConfig>): string {
  return (cfg.gatewayUrl ?? 'https://hybertext.xyz').replace(/\/+$/, '');
}

program
  .name('hybertext')
  .description('Publish websites to Berachain as immutable calldata')
  .version('0.1.0');

// ---------------------------------------------------------------------------
// hybertext config
// ---------------------------------------------------------------------------

const configCmd = program.command('config').description('Manage local configuration');

configCmd
  .command('set <key> <value>')
  .description('Set a config value (rpc, privateKey, registryAddress)')
  .action((key: string, value: string) => {
    const allowed = ['rpc', 'rpcFallbacks', 'privateKey', 'keyCommand', 'gatewayUrl', 'registryAddress', 'indexAddress', 'vaultAddress', 'vaultPubkey', 'paymentRecipient', 'executorAddress'];
    if (!allowed.includes(key)) {
      console.error(`Unknown config key "${key}". Valid keys: ${allowed.join(', ')}`);
      process.exit(1);
    }
    saveConfig({ [key]: value });
    console.log(`Saved ${key} to ${CONFIG_FILE}`);
  });

configCmd
  .command('get <key>')
  .description('Print a config value')
  .action((key: string) => {
    const cfg = loadConfig() as Record<string, string>;
    const val = cfg[key];
    if (val === undefined) {
      console.log(`(not set)`);
    } else {
      // Mask private key
      console.log(key === 'privateKey' ? val.slice(0, 6) + '...' + val.slice(-4) : val);
    }
  });

configCmd
  .command('show')
  .description('Print all saved config')
  .action(() => {
    const cfg = loadConfig() as Record<string, string>;
    if (Object.keys(cfg).length === 0) {
      console.log(`No config saved. File would be at: ${CONFIG_FILE}`);
      return;
    }
    for (const [k, v] of Object.entries(cfg)) {
      const display = k === 'privateKey' ? v.slice(0, 6) + '...' + v.slice(-4) : v;
      console.log(`${k}: ${display}`);
    }
  });

configCmd
  .command('clear')
  .description('Delete saved config file')
  .action(() => {
    try { fs.unlinkSync(CONFIG_FILE); } catch { /* already gone */ }
    console.log('Config cleared.');
  });

// ---------------------------------------------------------------------------
// hybertext publish <path>
// ---------------------------------------------------------------------------

program
  .command('publish <path>')
  .description('Pack and publish a file or directory to Berachain')
  .option('--rpc <url>', 'Berachain RPC URL')
  .option('--key <key>', 'Private key hex')
  .option('--index <address>', 'HyberIndex contract address (announce publication)')
  .option('--encrypt', 'Encrypt the site payload (requires --vault, --vault-pubkey, --price)')
  .option('--vault <address>', 'HyberKeyVault contract address')
  .option('--vault-pubkey <hex>', 'Worker X25519 public key (32-byte hex)')
  .option('--price <wei>', 'Access price in wei (BERA)')
  .option('--key-duration <seconds>', 'Key lifetime in seconds (0 = permanent)', '0')
  .option('--payment-recipient <address>', 'Address receiving BERA payments (default: publisher)')
  .option('--via <address>', 'EIP-7702: announce to HyberIndex under this wallet\'s identity (deploy key pattern)')
  .option('--executor <address>', 'HyberDeployExecutor contract address (for --via)')
  .action(async (inputPath: string, flags: {
    rpc?: string; key?: string; index?: string;
    encrypt?: boolean; vault?: string; vaultPubkey?: string;
    price?: string; keyDuration?: string; paymentRecipient?: string;
    via?: string; executor?: string;
  }) => {
    const cfg = resolveConfig(flags);
    if (!cfg.privateKey) {
      console.error('Error: private key required. Set via --key, PRIVATE_KEY env, or: hybertext config set privateKey 0x...');
      process.exit(1);
    }
    const privateKey      = (cfg.privateKey.startsWith('0x') ? cfg.privateKey : `0x${cfg.privateKey}`) as `0x${string}`;
    const indexAddress    = cfg.indexAddress as `0x${string}` | undefined;
    const viaAddress      = (flags.via) as `0x${string}` | undefined;
    const executorAddress = (cfg.executorAddress ?? flags.executor) as `0x${string}` | undefined;

    try {
      console.log(`Packing ${inputPath}...`);
      const { payload, compression, contentType } = await packPath(inputPath);
      console.log(`Packed: ${payload.length.toLocaleString()} bytes`);

      console.log('Publishing to Berachain...');

      const baseOpts = { rpcUrl: cfg.rpc, privateKey, indexAddress, viaAddress, executorAddress };

      let txHash: `0x${string}`;
      if (flags.encrypt) {
        const vaultAddress = (cfg.vaultAddress ?? flags.vault) as `0x${string}` | undefined;
        const vaultPubkey  = cfg.vaultPubkey ?? flags.vaultPubkey;
        if (!vaultAddress || vaultAddress === '0x0000000000000000000000000000000000000000') {
          console.error('Error: --encrypt requires --vault <address> or config set vaultAddress');
          process.exit(1);
        }
        if (!vaultPubkey) {
          console.error('Error: --encrypt requires --vault-pubkey <hex> or config set vaultPubkey');
          process.exit(1);
        }
        if (!flags.price) {
          console.error('Error: --encrypt requires --price <wei>');
          process.exit(1);
        }
        txHash = await publishEncryptedSite(payload, compression as any, contentType as any, {
          ...baseOpts,
          vaultAddress, vaultPubkey,
          priceWei:    BigInt(flags.price),
          keyDuration: parseInt(flags.keyDuration ?? '0', 10),
          paymentRecipient: (cfg.paymentRecipient ?? flags.paymentRecipient) as `0x${string}` | undefined,
        });
      } else {
        txHash = await publishSite(payload, compression as any, contentType as any, baseOpts);
      }

      console.log(`\nPublished: ${txHash}`);
      console.log(`  Gateway: ${gw(cfg)}/${txHash}`);
    } catch (err: any) {
      console.error('Error:', err.message ?? err);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// hybertext deploy <path>
// ---------------------------------------------------------------------------

program
  .command('deploy <path>')
  .description('Publish a site (and any functions/) then optionally register an alias')
  .option('--rpc <url>', 'Berachain RPC URL')
  .option('--key <key>', 'Private key hex')
  .option('--name <alias>', 'Register or update this alias after publishing')
  .option('--registry <address>', 'HyberRegistry contract address')
  .option('--index <address>', 'HyberIndex contract address (announce publication)')
  .option('--build', 'Auto-detect framework and run build before deploying')
  .option('--build-cmd <cmd>', 'Override the build command (e.g. "npm run build:static")')
  .option('--out <dir>', 'Override the build output directory')
  .option('--v4', 'Use manifest v4: per-file addressing with incremental deploy cache')
  .option('--encrypt', 'Encrypt the site payload (requires --vault, --vault-pubkey, --price)')
  .option('--vault <address>', 'HyberKeyVault contract address')
  .option('--vault-pubkey <hex>', 'Worker X25519 public key (32-byte hex)')
  .option('--price <wei>', 'Access price in wei (BERA)')
  .option('--key-duration <seconds>', 'Key lifetime in seconds (0 = permanent)', '0')
  .option('--payment-recipient <address>', 'Address receiving BERA payments (default: publisher)')
  .option('--via <address>', 'EIP-7702: announce to HyberIndex under this wallet\'s identity (deploy key pattern)')
  .option('--executor <address>', 'HyberDeployExecutor contract address (for --via)')
  .option('--fn-url <name=url>', 'Pre-deployed Worker URL for a function (repeatable). e.g. --fn-url _worker=https://...', (v, prev: string[]) => [...(prev || []), v], [] as string[])
  .action(async (inputPath: string, flags: {
    rpc?: string; key?: string; name?: string; registry?: string; index?: string;
    build?: boolean; buildCmd?: string; out?: string; v4?: boolean;
    encrypt?: boolean; vault?: string; vaultPubkey?: string;
    price?: string; keyDuration?: string; paymentRecipient?: string;
    via?: string; executor?: string; fnUrl?: string[];
  }) => {
    const cfg = resolveConfig(flags);
    if (!cfg.privateKey) {
      console.error('Error: private key required. Set via --key, PRIVATE_KEY env, or: hybertext config set privateKey 0x...');
      process.exit(1);
    }
    const privateKey      = (cfg.privateKey.startsWith('0x') ? cfg.privateKey : `0x${cfg.privateKey}`) as `0x${string}`;
    const indexAddress    = cfg.indexAddress as `0x${string}` | undefined;
    const viaAddress      = (flags.via) as `0x${string}` | undefined;
    const executorAddress = (cfg.executorAddress ?? flags.executor) as `0x${string}` | undefined;

    let deployDir = path.resolve(inputPath);

    try {
      // ── Optional build step ────────────────────────────────────────────────
      if (flags.build || flags.buildCmd) {
        const fw = detectFramework(deployDir);
        const buildCmd = flags.buildCmd ?? fw?.buildCmd;
        if (!buildCmd) {
          console.error('Error: could not detect framework. Use --build-cmd <cmd> to specify the build command.');
          process.exit(1);
        }
        if (fw?.warn) console.warn(`Warning: ${fw.warn}`);
        console.log(`Building with: ${buildCmd}`);
        await runBuild(deployDir, buildCmd);
        // Switch deploy target to build output dir
        const outDir = flags.out ?? fw?.outDir ?? 'dist';
        deployDir = path.join(deployDir, outDir);
        console.log(`Build output: ${deployDir}`);
      }

      const baseOpts = { rpcUrl: cfg.rpc, privateKey, indexAddress, viaAddress, executorAddress };

      // ── Manifest v4 path ───────────────────────────────────────────────────
      if (flags.v4) {
        if (!fs.existsSync(deployDir) || !fs.statSync(deployDir).isDirectory()) {
          console.error(`Error: --v4 requires a directory (got: ${deployDir})`);
          process.exit(1);
        }
        console.log('Publishing with manifest v4 (per-file addressing)...');
        const txHash = await publishDirectoryV4(deployDir, baseOpts);
        console.log(`\nPublished: ${txHash}`);
        console.log(`  Gateway: ${gw(cfg)}/${txHash}`);

        if (flags.name) {
          const registryAddress = cfg.registryAddress as `0x${string}` | undefined;
          console.log(`\nRegistering alias "${flags.name}"...`);
          await setAlias(flags.name, txHash, 'auto', { rpcUrl: cfg.rpc, privateKey, registryAddress });
          console.log(`Alias set:  ${gw(cfg)}/${flags.name}`);
        }
        return;
      }

      // ── Standard publish path ─────────────────────────────────────────────
      console.log(`Packing ${deployDir}...`);
      const { payload, compression, contentType } = await packPath(deployDir);
      const functions = fs.statSync(deployDir).isDirectory() ? detectFunctions(deployDir) : new Map<string, Buffer>();

      if (functions.size > 0) {
        console.log(`Detected ${functions.size} function(s): ${[...functions.keys()].join(', ')}`);
      }
      console.log(`Packed: ${payload.length.toLocaleString()} bytes`);

      console.log('Publishing to Berachain...');

      let txHash: `0x${string}`;
      if (flags.encrypt) {
        const vaultAddress = (cfg.vaultAddress ?? flags.vault) as `0x${string}` | undefined;
        const vaultPubkey  = cfg.vaultPubkey ?? flags.vaultPubkey;
        if (!vaultAddress || vaultAddress === '0x0000000000000000000000000000000000000000') {
          console.error('Error: --encrypt requires --vault <address> or config set vaultAddress');
          process.exit(1);
        }
        if (!vaultPubkey) {
          console.error('Error: --encrypt requires --vault-pubkey <hex> or config set vaultPubkey');
          process.exit(1);
        }
        if (!flags.price) {
          console.error('Error: --encrypt requires --price <wei>');
          process.exit(1);
        }
        txHash = await publishEncryptedSite(payload, compression as any, contentType as any, {
          ...baseOpts, vaultAddress, vaultPubkey,
          priceWei:    BigInt(flags.price),
          keyDuration: parseInt(flags.keyDuration ?? '0', 10),
          paymentRecipient: (cfg.paymentRecipient ?? flags.paymentRecipient) as `0x${string}` | undefined,
        });
      } else {
        // Parse --fn-url name=url pairs
        const fnUrls: Record<string, string> | undefined =
          flags.fnUrl && flags.fnUrl.length > 0
            ? Object.fromEntries(flags.fnUrl.map(s => {
                const eq = s.indexOf('=');
                return eq < 0 ? [s, ''] : [s.slice(0, eq), s.slice(eq + 1)];
              }))
            : undefined;

        txHash = functions.size > 0
          ? await publishWithFunctions(payload, compression as any, contentType as any, functions, baseOpts, fnUrls)
          : await publishSite(payload, compression as any, contentType as any, baseOpts);
      }

      console.log(`\nPublished: ${txHash}`);
      console.log(`  Gateway: ${gw(cfg)}/${txHash}`);

      if (flags.name) {
        const registryAddress = cfg.registryAddress as `0x${string}` | undefined;
        console.log(`\nRegistering alias "${flags.name}"...`);
        await setAlias(flags.name, txHash, 'auto', { rpcUrl: cfg.rpc, privateKey, registryAddress });
        console.log(`Alias set:  ${gw(cfg)}/${flags.name}`);
      }
    } catch (err: any) {
      console.error('Error:', err.message ?? err);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// hybertext init <name>
// ---------------------------------------------------------------------------

program
  .command('init <name>')
  .description('Create a new HyberText site scaffold')
  .option('--functions', 'Include an example edge function', false)
  .action((name: string, opts: { functions: boolean }) => {
    const dir = path.resolve(name);
    if (fs.existsSync(dir)) {
      console.error(`Error: directory "${name}" already exists`);
      process.exit(1);
    }
    fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(path.join(dir, 'index.html'), `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${name}</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <h1>${name}</h1>
  <p>Published on Berachain via <a href="${gw(cfg)}">HyberText</a>.</p>
  <script src="app.js"></script>
</body>
</html>
`);
    fs.writeFileSync(path.join(dir, 'styles.css'), `* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: system-ui, sans-serif; max-width: 800px; margin: 4rem auto; padding: 0 1rem; }
h1 { font-size: 2rem; margin-bottom: 1rem; }
a { color: #d97706; }
`);
    fs.writeFileSync(path.join(dir, 'app.js'), `console.log('${name} loaded');\n`);

    if (opts.functions) {
      const fnDir = path.join(dir, 'functions', 'api');
      fs.mkdirSync(fnDir, { recursive: true });
      fs.writeFileSync(path.join(fnDir, 'hello.js'), `// Edge function served at /api/hello
// env.params contains dynamic route params (e.g. for api/users/[id].js → env.params.id)
module.exports = {
  async fetch(request, env) {
    return new Response(JSON.stringify({ hello: 'world', url: request.url }), {
      headers: { 'Content-Type': 'application/json' },
    });
  },
};
`);
    }

    console.log(`Created ${name}/`);
    if (opts.functions) console.log(`  functions/api/hello.js`);
    console.log(`\nNext steps:`);
    console.log(`  cd ${name}`);
    console.log(`  hybertext dev .`);
    console.log(`  hybertext deploy . --key $PRIVATE_KEY`);
  });

// ---------------------------------------------------------------------------
// hybertext dev [path]
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8', css: 'text/css',
  js: 'application/javascript', mjs: 'application/javascript',
  json: 'application/json', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon',
  woff: 'font/woff', woff2: 'font/woff2', txt: 'text/plain',
};

program
  .command('dev [path]')
  .description('Start a local dev server (default: current directory)')
  .option('--port <port>', 'Port to listen on', '3000')
  .action((sitePath: string | undefined, opts: { port: string }) => {
    const dir  = path.resolve(sitePath ?? '.');
    const port = parseInt(opts.port, 10);

    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      console.error(`Error: "${dir}" is not a directory`);
      process.exit(1);
    }

    const server = http.createServer((req, res) => {
      let urlPath: string;
      try {
        urlPath = decodeURIComponent(new URL(req.url!, `http://localhost:${port}`).pathname);
      } catch {
        res.writeHead(400); res.end('Bad request'); return;
      }

      let filePath = path.join(dir, urlPath === '/' ? 'index.html' : urlPath);
      if (!filePath.startsWith(dir + path.sep) && filePath !== dir) {
        res.writeHead(403); res.end('Forbidden'); return;
      }
      if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
        filePath = path.join(filePath, 'index.html');
      }
      if (!fs.existsSync(filePath)) {
        const hasExt = path.extname(urlPath).length > 0;
        if (!hasExt) {
          const fallback404 = path.join(dir, '404.html');
          filePath = fs.existsSync(fallback404) ? fallback404 : path.join(dir, 'index.html');
        }
      }
      if (!fs.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return;
      }

      const ext = path.extname(filePath).slice(1).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
    });

    server.listen(port, () => {
      console.log(`Dev server: http://localhost:${port}  (${dir})`);
      console.log('Press Ctrl+C to stop.');
    });
  });

// ---------------------------------------------------------------------------
// hybertext alias <name> <txhash>
// ---------------------------------------------------------------------------

program
  .command('alias <name> <txhash>')
  .description('Register or update a HyberRegistry alias')
  .option('--rpc <url>', 'Berachain RPC URL')
  .option('--key <key>', 'Private key hex')
  .option('--registry <address>', 'HyberRegistry contract address')
  .option('--register', 'Force register (fails if already taken)', false)
  .option('--update',   'Force update (fails if not owner)', false)
  .action(async (name: string, txhash: string, flags: { rpc?: string; key?: string; registry?: string; register: boolean; update: boolean }) => {
    const cfg = resolveConfig(flags);
    if (!cfg.privateKey) {
      console.error('Error: private key required');
      process.exit(1);
    }
    if (!/^0x[a-fA-F0-9]{64}$/.test(txhash)) {
      console.error('Error: txhash must be a 0x-prefixed 32-byte hex string');
      process.exit(1);
    }
    const privateKey      = (cfg.privateKey.startsWith('0x') ? cfg.privateKey : `0x${cfg.privateKey}`) as `0x${string}`;
    const registryAddress = cfg.registryAddress as `0x${string}` | undefined;
    const action          = flags.register ? 'register' : flags.update ? 'update' : 'auto';

    try {
      console.log(`Setting alias "${name}" → ${txhash.slice(0, 12)}...`);
      const aliasTx = await setAlias(name, txhash as `0x${string}`, action, { rpcUrl: cfg.rpc, privateKey, registryAddress });
      console.log(`Done! Registry tx: ${aliasTx}`);
    } catch (err: any) {
      console.error('Error:', err.message ?? err);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// hybertext resolve <name>
// ---------------------------------------------------------------------------

program
  .command('resolve <name>')
  .description('Look up a HyberRegistry alias')
  .option('--rpc <url>', 'Berachain RPC URL')
  .option('--registry <address>', 'HyberRegistry contract address')
  .action(async (name: string, flags: { rpc?: string; registry?: string }) => {
    const cfg = resolveConfig(flags);
    const registryAddress = cfg.registryAddress as `0x${string}` | undefined;
    try {
      const txHash = await resolveAlias(name, cfg.rpc, registryAddress);
      if (!txHash) {
        console.log(`"${name}" is not registered.`);
      } else {
        console.log(txHash);
        console.log(`  Gateway: ${gw(cfg)}/${txHash}`);
      }
    } catch (err: any) {
      console.error('Error:', err.message ?? err);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// hybertext 7702-setup / 7702-revoke / 7702-check
// ---------------------------------------------------------------------------

program
  .command('7702-setup')
  .description('Delegate publish identity to a deploy key via EIP-7702 (run once, locally)')
  .requiredOption('--key <key>', 'Main wallet private key (signs the 7702 authorization)')
  .requiredOption('--deploy-key-address <address>', 'CI/deploy wallet address to authorize')
  .option('--executor <address>', 'HyberDeployExecutor contract address', '0xc6784264f8951E1d0638969E159279aD5b977b0d')
  .option('--rpc <url>', 'Berachain RPC URL')
  .action(async (flags: { key: string; deployKeyAddress: string; executor: string; rpc?: string }) => {
    const cfg        = resolveConfig(flags);
    const privateKey = (flags.key.startsWith('0x') ? flags.key : `0x${flags.key}`) as `0x${string}`;
    try {
      await setup7702({
        rpcUrl:           cfg.rpc,
        mainPrivateKey:   privateKey,
        deployKeyAddress: flags.deployKeyAddress as `0x${string}`,
        executorAddress:  flags.executor as `0x${string}`,
      });
    } catch (err: any) {
      console.error('Error:', err.message ?? err);
      process.exit(1);
    }
  });

program
  .command('7702-revoke')
  .description('Remove the authorized deploy key from your wallet')
  .requiredOption('--key <key>', 'Main wallet private key')
  .option('--executor <address>', 'HyberDeployExecutor contract address', '0xc6784264f8951E1d0638969E159279aD5b977b0d')
  .option('--rpc <url>', 'Berachain RPC URL')
  .action(async (flags: { key: string; executor: string; rpc?: string }) => {
    const cfg        = resolveConfig(flags);
    const privateKey = (flags.key.startsWith('0x') ? flags.key : `0x${flags.key}`) as `0x${string}`;
    try {
      await revoke7702({ rpcUrl: cfg.rpc, mainPrivateKey: privateKey, executorAddress: flags.executor as `0x${string}` });
    } catch (err: any) {
      console.error('Error:', err.message ?? err);
      process.exit(1);
    }
  });

program
  .command('7702-check <address>')
  .description('Show the authorized deploy key for a wallet address')
  .option('--executor <address>', 'HyberDeployExecutor contract address', '0xc6784264f8951E1d0638969E159279aD5b977b0d')
  .option('--rpc <url>', 'Berachain RPC URL')
  .action(async (address: string, flags: { executor: string; rpc?: string }) => {
    const cfg = resolveConfig(flags);
    try {
      await check7702({ rpcUrl: cfg.rpc, mainAddress: address as `0x${string}`, executorAddress: flags.executor as `0x${string}` });
    } catch (err: any) {
      console.error('Error:', err.message ?? err);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// hybertext vault-keygen
// ---------------------------------------------------------------------------

program
  .command('vault-keygen')
  .description('Generate an X25519 keypair for the HyberKeyVault Worker')
  .option('--from-key <hex>', 'Derive public key from an existing private key (32-byte hex)')
  .action((opts: { fromKey?: string }) => {
    if (opts.fromKey) {
      const privHex = opts.fromKey.replace(/^0x/, '');
      if (!/^[0-9a-f]{64}$/i.test(privHex)) {
        console.error('Error: private key must be a 32-byte hex string');
        process.exit(1);
      }
      const pubHex = derivePublicKey(privHex);
      console.log(`Public key: ${pubHex}`);
    } else {
      const { privateKey, publicKey } = generateVaultKeypair();
      console.log('Generated X25519 keypair:');
      console.log(`  Private key (secret — set as VAULT_X25519_PRIVKEY): ${privateKey}`);
      console.log(`  Public key  (set as VAULT_X25519_PUBKEY):            ${publicKey}`);
      console.log('\nTo configure the Worker:');
      console.log(`  pnpm wrangler secret put VAULT_X25519_PRIVKEY  # paste private key`);
      console.log(`  # Add to wrangler.toml [vars]: VAULT_X25519_PUBKEY = "${publicKey}"`);
    }
  });

// ---------------------------------------------------------------------------
// hybertext estimate <path>
// ---------------------------------------------------------------------------

program
  .command('estimate <path>')
  .description('Estimate gas cost to publish without sending any transactions')
  .option('--rpc <url>', 'Berachain RPC URL')
  .option('--v4', 'Estimate for manifest v4 (per-file) mode')
  .action(async (inputPath: string, flags: { rpc?: string; v4?: boolean }) => {
    const cfg    = resolveConfig(flags);
    const absDir = path.resolve(inputPath);

    try {
      let totalBytes = 0;
      let numTxs     = 0;

      if (flags.v4 && fs.existsSync(absDir) && fs.statSync(absDir).isDirectory()) {
        // v4: count each file as a separate tx (plus 1 manifest tx)
        const walk = (dir: string): void => {
          for (const name of fs.readdirSync(dir)) {
            const full = path.join(dir, name);
            if (fs.statSync(full).isDirectory()) { walk(full); continue; }
            totalBytes += fs.statSync(full).size;
            numTxs++;
          }
        };
        walk(absDir);
        numTxs++; // manifest tx
      } else {
        const { payload } = await packPath(absDir);
        totalBytes = payload.length;
        numTxs = Math.ceil(payload.length / CHUNK_SIZE) + 1; // chunks + manifest
      }

      // Gas estimate: 21000 base + calldata cost
      // After EIP-2028: 16 gas/non-zero byte, 4 gas/zero byte
      // Compressed data is ~75% non-zero
      const bytesPerTx   = Math.min(totalBytes / numTxs, CHUNK_SIZE);
      const nonZero      = Math.floor(bytesPerTx * 0.75);
      const zeroByte     = bytesPerTx - nonZero;
      const gasPerTx     = BigInt(Math.round(21_000 + nonZero * 16 + zeroByte * 4));
      const totalGas     = gasPerTx * BigInt(numTxs);

      // Fetch current gas price
      const res = await fetch(cfg.rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_gasPrice', params: [], id: 1 }),
      });
      const json = await res.json() as { result?: string; error?: { message: string } };
      const gasPriceWei = json.result ? BigInt(json.result) : 1_000_000_000n; // default 1 Gwei
      const totalWei    = totalGas * gasPriceWei;
      const totalBera   = Number(totalWei) / 1e18;

      console.log(`\nEstimate for: ${absDir}`);
      console.log(`  Transactions : ${numTxs} (${flags.v4 ? 'v4 per-file' : 'chunks + manifest'})`);
      console.log(`  Payload size : ${(totalBytes / 1024).toFixed(1)} KB`);
      console.log(`  Estimated gas: ${totalGas.toLocaleString()}`);
      console.log(`  Gas price    : ${Number(gasPriceWei) / 1e9} Gwei`);
      console.log(`  Est. cost    : ${totalBera.toFixed(4)} BERA`);
      console.log(`\nNote: actual cost depends on compression ratio and live gas price.`);
    } catch (err: any) {
      console.error('Error:', err.message ?? err);
      process.exit(1);
    }
  });

program.parse();
