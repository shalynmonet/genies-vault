import hardhatToolboxViemPlugin from '@nomicfoundation/hardhat-toolbox-viem';
import { configVariable, defineConfig } from 'hardhat/config';

// Reads secrets from environment variables at run time via configVariable --
// nothing here is hardcoded, and Hardhat never prints these values. Create a
// `.env` file next to this config (see `.env.example`) and load it with
// `node --env-file=.env` or a package like `dotenv/config`, e.g.:
//   node --env-file=.env node_modules/.bin/hardhat run scripts/deploy.ts --network baseSepolia
export default defineConfig({
  plugins: [hardhatToolboxViemPlugin],
  solidity: {
    profiles: {
      default: {
        version: '0.8.30',
        settings: {
          viaIR: true,
          optimizer: { enabled: true, runs: 200 },
        },
      },
    },
  },
  networks: {
    baseSepolia: {
      type: 'http',
      chainType: 'op',
      url: configVariable('BASE_SEPOLIA_RPC_URL'),
      accounts: [configVariable('DEPLOYER_PRIVATE_KEY')],
    },
    base: {
      type: 'http',
      chainType: 'op',
      url: configVariable('BASE_RPC_URL'),
      accounts: [configVariable('DEPLOYER_PRIVATE_KEY')],
    },
  },
});
