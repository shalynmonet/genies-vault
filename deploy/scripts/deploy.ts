import { network } from 'hardhat';

// Run with: npm run deploy:base-sepolia   (or deploy:base for mainnet)
const { viem, networkName } = await network.getOrCreate();

console.log(`Deploying GeniesVaultGame to ${networkName}...`);

const [deployer] = await viem.getWalletClients();
console.log('Deployer address:', deployer.account.address);

const publicClient = await viem.getPublicClient();
const balance = await publicClient.getBalance({ address: deployer.account.address });
console.log('Deployer balance:', balance, 'wei');
if (balance === 0n) {
  throw new Error(
    'Deployer wallet has 0 ETH on this network -- fund it with a little Base ETH for gas first ' +
      '(Base Sepolia: use a faucet such as https://www.alchemy.com/faucets/base-sepolia).',
  );
}

const game = await viem.deployContract('GeniesVaultGame', []);
console.log('GeniesVaultGame deployed at:', game.address);
console.log('\nNext steps:');
console.log('1. Verify the contract on Basescan (optional but recommended):');
console.log(`   npx hardhat verify --network ${networkName} ${game.address}`);
console.log('2. Send this address, plus your frontend URL, to the Chain.wtf / jam.chain.wtf team');
console.log('   for whitelisting on CasinoGameFacet, indexer registration, and catalog entry.');
