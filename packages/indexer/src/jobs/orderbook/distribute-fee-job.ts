import { AbstractRabbitMqJobHandler } from "@/jobs/abstract-rabbit-mq-job-handler";
import { acquireLock, redlock, releaseLock } from "@/common/redis";
import { logger } from "@/common/logger";
import { redb } from "@/common/db";
import { config } from "@/config/index";
import {
  getPaymentSplitFromDb,
  updatePaymentSplitBalance,
  PaymentSplit,
  setPaymentSplitIsDeployed,
} from "@/utils/payment-splits";
import { bn } from "@/common/utils";
import { AddressZero } from "@ethersproject/constants";

import cron from "node-cron";
import { baseProvider } from "@/common/provider";
import * as Sdk from "@reservoir0x/sdk";

import { Contract } from "@ethersproject/contracts";
import { Interface } from "@ethersproject/abi";
import { BigNumber } from "ethers";

const PAYMENTSPLIT_DEPLOY_THRESHOLD = bn(1e18);

export type DistributeFeeJobPayload = {
  address: string;
};

export default class DistributeFeeJob extends AbstractRabbitMqJobHandler {
  queueName = "distribute-fee-queue";
  maxRetries = 10;
  concurrency = 1;
  useSharedChannel = true;
  timeout = 120000;

  public async process(payload: DistributeFeeJobPayload) {
    const { address } = payload;
    if (await acquireLock(this.getLockName(address), 60 * 5)) {
      try {
        const paymentSplit = await getPaymentSplitFromDb(address);
        if (!paymentSplit) {
          return;
        }

        const nativeTokenBalance = await this.refreshBalance(address);

        // Reach threshold and un-deployed
        if (nativeTokenBalance.gt(PAYMENTSPLIT_DEPLOY_THRESHOLD) && paymentSplit?.isDeployed) {
          await this.deploy(paymentSplit);
        }
      } catch (error) {
        logger.error(this.queueName, `Distribute failed. address=${address}, error=${error}`);
      }

      await releaseLock(this.getLockName(address));
    } else {
      logger.info(this.queueName, `Unable to acquire lock. address=${address}`);
    }
  }

  public getLockName(address: string) {
    return `${this.queueName}:${address}-lock`;
  }

  public async refreshBalance(splitAddress: string) {
    let nativeTokenBalance: BigNumber = bn(0);
    // Native Token
    if (Sdk.Common.Addresses.Native[config.chainId]) {
      nativeTokenBalance = await baseProvider.getBalance(splitAddress);
      await updatePaymentSplitBalance(
        splitAddress,
        Sdk.Common.Addresses.Native[config.chainId],
        nativeTokenBalance.toString()
      );
    }
    return nativeTokenBalance;
  }

  public async deploy(paymentSplit: PaymentSplit) {
    const zeroSplit = new Contract(
      Sdk.ZeroExSplits.Addresses.SplitMain[config.chainId],
      new Interface([
        `function predictImmutableSplitAddress(address[] calldata accounts, uint32[] calldata percentAllocations, uint32 distributorFee) external view returns (address split)`,
        `function createSplit(address[] calldata accounts, uint32[] calldata percentAllocations, uint32 distributorFee, address controller) external returns (address split)`,
        `function distributeETH(address split, address[] calldata accounts, uint32[] calldata percentAllocations, uint32 distributorFee, address distributorAddress) external`,
        `function distributeERC20(address split, address token, address[] calldata accounts, uint32[] calldata percentAllocations, uint32 distributorFee, address distributorAddress) external`,
        `function getETHBalance(address account) external view returns (uint256)`,
        `function getERC20Balance(address account, address token) external view returns (uint256)`,
      ])
    );
    const splitFees = paymentSplit.fees;
    // Sort by recipient
    splitFees.sort((a, b) => (bn(a.recipient).gt(bn(b.recipient)) ? 0 : -1));

    // Create split
    const deployTx = await zeroSplit.createSplit(
      splitFees.map((c) => c.recipient),
      splitFees.map((c) => c.bps),
      0,
      AddressZero
    );

    // Deploy
    await deployTx.wait();

    // Mark as deployed
    await setPaymentSplitIsDeployed(paymentSplit.address);
  }

  public async addToQueue(params: DistributeFeeJobPayload) {
    await this.send({ payload: params });
  }
}

export const distributeFeeJob = new DistributeFeeJob();

// BACKGROUND WORKER ONLY
if (config.doBackgroundWork) {
  cron.schedule(
    "0 1 * * *",
    async () =>
      await redlock
        .acquire([`distribute-fee-cron-lock`], (5 * 60 - 5) * 1000)
        .then(async () => {
          redb
            .manyOrNone(`SELECT payment_splits.address FROM payment_splits`)
            .then(async (splits) =>
              splits.forEach((split) => distributeFeeJob.addToQueue({ address: split.address }))
            )
            .catch(() => {
              // Skip on any errors
            });
        })
        .catch(() => {
          // Skip on any errors
        })
  );
}
