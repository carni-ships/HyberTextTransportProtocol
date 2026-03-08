/**
 * setup7702.ts — EIP-7702 deploy-key setup for HyberText.
 *
 * Flow:
 *   1. Main wallet signs a 7702 authorization delegating to HyberDeployExecutor.
 *   2. Main wallet sends a self-tx with the authorization + setDeployKey(ciAddress).
 *   3. From CI: deploy key calls mainWallet.publishToIndex(...) to announce publishes
 *      under the main wallet's identity. CI never touches the main private key.
 *
 * After setup, the only secret needed in CI is the deploy key's private key.
 */

import {
  createWalletClient,
  createPublicClient,
  http,
  defineChain,
  encodeFunctionData,
} from 'viem';
import { eip7702Actions } from 'viem/experimental';
import { privateKeyToAccount } from 'viem/accounts';

// ---------------------------------------------------------------------------
// HyberDeployExecutor ABI fragments
// ---------------------------------------------------------------------------

const EXECUTOR_ABI = [
  {
    name: 'setDeployKey',
    type: 'function',
    inputs:  [{ name: 'key', type: 'address' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    name: 'revokeDeployKey',
    type:  'function',
    inputs:  [],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    name: 'deployKey',
    type: 'function',
    inputs:  [],
    outputs: [{ name: 'key', type: 'address' }],
    stateMutability: 'view',
  },
] as const;

// ---------------------------------------------------------------------------
// Chain definition
// ---------------------------------------------------------------------------

function makeChain(rpcUrl: string) {
  return defineChain({
    id: 80094,
    name: 'Berachain',
    nativeCurrency: { name: 'BERA', symbol: 'BERA', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

// ---------------------------------------------------------------------------
// setup7702: authorize a deploy key under the main wallet
// ---------------------------------------------------------------------------

export async function setup7702(opts: {
  rpcUrl:          string;
  mainPrivateKey:  `0x${string}`;
  deployKeyAddress: `0x${string}`;
  executorAddress:  `0x${string}`;
}): Promise<void> {
  const { rpcUrl, mainPrivateKey, deployKeyAddress, executorAddress } = opts;
  const chain   = makeChain(rpcUrl);
  const account = privateKeyToAccount(mainPrivateKey);

  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) })
    .extend(eip7702Actions());
  const pub = createPublicClient({ chain, transport: http(rpcUrl) });

  console.log(`Main wallet:    ${account.address}`);
  console.log(`Deploy key:     ${deployKeyAddress}`);
  console.log(`Executor:       ${executorAddress}`);
  console.log('');

  // 1. Sign EIP-7702 authorization
  process.stdout.write('Signing 7702 authorization... ');
  const authorization = await wallet.signAuthorization({
    contractAddress: executorAddress,
  });
  console.log('done');

  // 2. Send self-tx: apply authorization + call setDeployKey
  process.stdout.write('Sending setup transaction... ');
  const data = encodeFunctionData({
    abi:          EXECUTOR_ABI,
    functionName: 'setDeployKey',
    args:         [deployKeyAddress],
  });

  const hash = await wallet.sendTransaction({
    authorizationList: [authorization],
    to:   account.address,  // self-tx
    data,
    value: 0n,
  });
  await pub.waitForTransactionReceipt({ hash });
  console.log(`done (${hash})`);

  console.log('');
  console.log('Setup complete. Your wallet is now configured for EIP-7702 delegation.');
  console.log('');
  console.log('CI configuration:');
  console.log(`  Secret: HYBERTEXT_DEPLOY_KEY = <deploy key private key>`);
  console.log(`  Public: HYBERTEXT_MAIN_WALLET = ${account.address}`);
  console.log('');
  console.log('Deploy command (in CI):');
  console.log(`  hybertext deploy . \\`);
  console.log(`    --key $HYBERTEXT_DEPLOY_KEY \\`);
  console.log(`    --via ${account.address} \\`);
  console.log(`    --executor ${executorAddress} \\`);
  console.log(`    --index 0x82afb1215F60d9e969dC7918888D362E0f1Ac9f6`);
}

// ---------------------------------------------------------------------------
// revoke7702: remove the authorized deploy key
// ---------------------------------------------------------------------------

export async function revoke7702(opts: {
  rpcUrl:         string;
  mainPrivateKey: `0x${string}`;
  executorAddress: `0x${string}`;
}): Promise<void> {
  const { rpcUrl, mainPrivateKey, executorAddress } = opts;
  const chain   = makeChain(rpcUrl);
  const account = privateKeyToAccount(mainPrivateKey);

  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) })
    .extend(eip7702Actions());
  const pub = createPublicClient({ chain, transport: http(rpcUrl) });

  // Sign a fresh authorization (needed to send a type-0x04 tx for the self-call)
  const authorization = await wallet.signAuthorization({
    contractAddress: executorAddress,
  });

  const data = encodeFunctionData({
    abi:          EXECUTOR_ABI,
    functionName: 'revokeDeployKey',
    args:         [],
  });

  process.stdout.write('Revoking deploy key... ');
  const hash = await wallet.sendTransaction({
    authorizationList: [authorization],
    to:   account.address,
    data,
    value: 0n,
  });
  await pub.waitForTransactionReceipt({ hash });
  console.log(`done (${hash})`);
}

// ---------------------------------------------------------------------------
// check7702: read the current deploy key from the main wallet's storage
// ---------------------------------------------------------------------------

export async function check7702(opts: {
  rpcUrl:          string;
  mainAddress:     `0x${string}`;
  executorAddress: `0x${string}`;
}): Promise<void> {
  const { rpcUrl, mainAddress, executorAddress } = opts;
  const chain = makeChain(rpcUrl);
  const pub   = createPublicClient({ chain, transport: http(rpcUrl) });

  const key = await pub.readContract({
    address:      mainAddress,
    abi:          EXECUTOR_ABI,
    functionName: 'deployKey',
  });

  const zero = '0x0000000000000000000000000000000000000000';
  if (!key || key === zero) {
    console.log('No deploy key set. Run: hybertext 7702-setup');
  } else {
    console.log(`Authorized deploy key: ${key}`);
  }
  console.log(`Executor contract:     ${executorAddress}`);
}
