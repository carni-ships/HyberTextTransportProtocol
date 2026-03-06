import { Command } from 'commander';
import { packPath } from './pack';
import { publishSite } from './publish';

const program = new Command();

program
  .name('hybertext')
  .description('Publish websites to Berachain as immutable calldata')
  .version('0.1.0');

program
  .command('publish <path>')
  .description('Publish a file or directory as a website on Berachain')
  .option('--rpc <url>', 'Berachain RPC URL', 'https://rpc.berachain.com')
  .option('--key <key>', 'Private key hex (or set PRIVATE_KEY env var)')
  .action(async (inputPath: string, opts: { rpc: string; key?: string }) => {
    const rawKey = opts.key ?? process.env.PRIVATE_KEY;
    if (!rawKey) {
      console.error('Error: private key required via --key or PRIVATE_KEY env var');
      process.exit(1);
    }
    const privateKey = (rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`) as `0x${string}`;

    try {
      console.log(`Packing ${inputPath}...`);
      const { payload, compression, contentType } = await packPath(inputPath);
      const compressionName = ['none', 'gzip', 'brotli'][compression];
      const typeName = ['html', 'tar', 'manifest'][contentType];
      console.log(`Packed: ${payload.length.toLocaleString()} bytes (${compressionName}, ${typeName})`);

      console.log('Publishing to Berachain...');
      const txHash = await publishSite(
        payload,
        compression as any,
        contentType as any,
        { rpcUrl: opts.rpc, privateKey }
      );

      console.log('');
      console.log('Site published!');
      console.log(`  Address (tx hash): ${txHash}`);
      console.log(`  Local resolver:    http://localhost:3000/${txHash}`);
    } catch (err: any) {
      console.error('Error:', err.message ?? err);
      process.exit(1);
    }
  });

program.parse();
