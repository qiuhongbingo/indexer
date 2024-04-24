import { AbstractRabbitMqJobHandler } from "@/jobs/abstract-rabbit-mq-job-handler";
import { acquireLock, redlock, releaseLock } from "@/common/redis";
import { logger } from "@/common/logger";
import { config } from "@/config/index";
import { Wallet } from "@ethersproject/wallet";
import {
  getPaymentSplitFromDb,
  updatePaymentSplitBalance,
  getPaymentSplitCurrencies,
  PaymentSplit,
  setPaymentSplitIsDeployed,
  getPaymentSplits,
} from "@/utils/payment-splits";
import { bn, now } from "@/common/utils";
import { AddressZero } from "@ethersproject/constants";
import { getUSDAndNativePrices } from "@/utils/prices";
import { isNative } from "@reservoir0x/sdk/dist/router/v6/utils";

import cron from "node-cron";
import { baseProvider } from "@/common/provider";
import * as Sdk from "@reservoir0x/sdk";

import { Contract } from "@ethersproject/contracts";
import { Interface } from "@ethersproject/abi";

const PAYMENTSPLIT_DEPLOY_THRESHOLD = bn(10000);

export const splitFeeDistributor = () => {
  if (config.splitFeeDistributorPrivateKey) {
    return new Wallet(config.splitFeeDistributorPrivateKey, baseProvider);
  }

  throw new Error("Simulation not supported");
};

export type DistributeFeeJobPayload = {
  address: string;
};

export default class DistributeFeeJob extends AbstractRabbitMqJobHandler {
  queueName = "distribute-fee-queue";
  maxRetries = 10;
  concurrency = 1;
  timeout = 120000;

  public async process(payload: DistributeFeeJobPayload) {
    const { address } = payload;
    if (await acquireLock(this.getLockName(address), 60 * 5)) {
      try {
        const paymentSplit = await getPaymentSplitFromDb(address);
        if (!paymentSplit) {
          return;
        }

        const usdBlance = await this.refreshBalance(address);

        if (usdBlance.gt(PAYMENTSPLIT_DEPLOY_THRESHOLD)) {
          if (!paymentSplit.isDeployed) {
            await this.deploy(paymentSplit);
          }

          await this.distribute(paymentSplit);
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
    const usedCurrencies = await getPaymentSplitCurrencies(splitAddress);
    const timestamp = now();
    let totalUsd = bn(0);

    for (const usedCurrency of usedCurrencies) {
      const currencyBalance = isNative(config.chainId, usedCurrency)
        ? await baseProvider.getBalance(splitAddress)
        : await new Sdk.Common.Helpers.Erc20(baseProvider, usedCurrency).getBalance(splitAddress);

      try {
        const priceData = await getUSDAndNativePrices(
          usedCurrency,
          currencyBalance.toString(),
          timestamp
        );

        if (priceData) {
          totalUsd = totalUsd.add(bn(priceData.usdPrice!));
        }
      } catch {
        // fetch price failed
      }

      // Update balance
      await updatePaymentSplitBalance(splitAddress, usedCurrency, currencyBalance.toString());
    }

    return totalUsd;
  }

  public getSplit() {
    const split = new Contract(
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
    const distributor = splitFeeDistributor();
    return split.connect(distributor);
  }

  public async distribute(paymentSplit: PaymentSplit) {
    const zeroSplit = this.getSplit();
    const splitFees = paymentSplit.fees;
    // Sort by recipient
    splitFees.sort((a, b) => (bn(a.recipient).gt(bn(b.recipient)) ? 0 : -1));

    // TODO: use multicall
    {
      const tx = await zeroSplit.distributeETH(
        splitFees.map((c) => c.recipient),
        splitFees.map((c) => c.bps),
        0,
        AddressZero
      );
      await tx.wait();
    }

    {
      const tx = await zeroSplit.distributeERC20(
        splitFees.map((c) => c.recipient),
        splitFees.map((c) => c.bps),
        0,
        AddressZero
      );
      await tx.wait();
    }
  }

  public async deploy(paymentSplit: PaymentSplit) {
    const zeroSplit = this.getSplit();
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
          getPaymentSplits()
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
