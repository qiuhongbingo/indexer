import { Interface } from "@ethersproject/abi";
import { AddressZero } from "@ethersproject/constants";
import { Contract } from "@ethersproject/contracts";
import { Wallet } from "@ethersproject/wallet";
import * as Sdk from "@reservoir0x/sdk";
import cron from "node-cron";

import { logger } from "@/common/logger";
import { baseProvider } from "@/common/provider";
import { acquireLock, redlock, releaseLock } from "@/common/redis";
import { bn, now } from "@/common/utils";
import { config } from "@/config/index";
import { AbstractRabbitMqJobHandler } from "@/jobs/abstract-rabbit-mq-job-handler";
import {
  PaymentSplit,
  getPaymentSplitCurrencies,
  getPaymentSplitFromDb,
  getPaymentSplits,
  setPaymentSplitIsDeployed,
  updatePaymentSplitBalance,
} from "@/utils/payment-splits";
import { getUSDAndNativePrices } from "@/utils/prices";

const PAYMENT_SPLIT_DEPLOY_THRESHOLD = bn(1000);

export const paymentSplitDistributor = () =>
  new Wallet(config.paymentSplitDistributorPrivateKey!, baseProvider);

export type DistributeFeesJobPayload = {
  paymentSplitAddress: string;
};

export default class DistributeFeesJob extends AbstractRabbitMqJobHandler {
  queueName = "distribute-fees-queue";
  maxRetries = 10;
  concurrency = 1;
  timeout = 120000;

  public async process(payload: DistributeFeesJobPayload) {
    const { paymentSplitAddress } = payload;

    if (await acquireLock(this.getLockName(paymentSplitAddress), 60 * 5)) {
      try {
        const paymentSplit = await getPaymentSplitFromDb(paymentSplitAddress);
        if (!paymentSplit) {
          return;
        }

        const currencies = await getPaymentSplitCurrencies(paymentSplitAddress);
        for (const currency of currencies) {
          const { balance, usdBalance } = await this.refreshBalance(paymentSplitAddress, currency);
          logger.info(
            this.queueName,
            JSON.stringify({
              msg: `Balance of payment split ${paymentSplitAddress} for currency ${currency} is ${balance} (~$${usdBalance})`,
            })
          );

          if (config.paymentSplitDistributorPrivateKey) {
            if (usdBalance && bn(usdBalance).gt(PAYMENT_SPLIT_DEPLOY_THRESHOLD)) {
              if (!paymentSplit.isDeployed) {
                await this.deploy(paymentSplit);
              }

              await this.distribute(paymentSplit, currency);
            }
          }
        }
      } catch (error) {
        logger.error(
          this.queueName,
          `Distribute failed. paymentSplitAddress=${paymentSplitAddress}, error=${error}`
        );
      }

      await releaseLock(this.getLockName(paymentSplitAddress));
    } else {
      logger.info(
        this.queueName,
        `Unable to acquire lock. paymentSplitAddress=${paymentSplitAddress}`
      );
    }
  }

  public getLockName(address: string) {
    return `${this.queueName}:${address}-lock`;
  }

  public async refreshBalance(splitAddress: string, currency: string) {
    const timestamp = now();

    const balance =
      currency === Sdk.Common.Addresses.Native[config.chainId]
        ? await baseProvider.getBalance(splitAddress)
        : await new Sdk.Common.Helpers.Erc20(baseProvider, currency).getBalance(splitAddress);

    // Update balance
    await updatePaymentSplitBalance(splitAddress, currency, balance.toString());

    return {
      balance: balance.toString(),
      usdBalance: await getUSDAndNativePrices(currency, balance.toString(), timestamp).then(
        (priceData) => priceData.usdPrice
      ),
    };
  }

  public getSplit() {
    const split = new Contract(
      Sdk.ZeroExSplits.Addresses.SplitMain[config.chainId],
      new Interface([
        `function createSplit(address[] calldata accounts, uint32[] calldata percentAllocations, uint32 distributorFee, address controller) returns (address split)`,
        `function distributeETH(address split, address[] calldata accounts, uint32[] calldata percentAllocations, uint32 distributorFee, address distributorAddress)`,
        `function distributeERC20(address split, address token, address[] calldata accounts, uint32[] calldata percentAllocations, uint32 distributorFee, address distributorAddress)`,
      ])
    );
    const distributor = paymentSplitDistributor();
    return split.connect(distributor);
  }

  public async distribute(paymentSplit: PaymentSplit, currency: string) {
    const splitContract = this.getSplit();

    if (currency === Sdk.Common.Addresses.Native[config.chainId]) {
      const tx = await splitContract.distributeETH(
        paymentSplit.address,
        paymentSplit.fees.map((c) => c.recipient),
        paymentSplit.fees.map((c) => c.bps),
        0,
        AddressZero
      );
      await tx.wait();
    } else {
      const tx = await splitContract.distributeERC20(
        paymentSplit.address,
        currency,
        paymentSplit.fees.map((c) => c.recipient),
        paymentSplit.fees.map((c) => c.bps),
        0,
        AddressZero
      );
      await tx.wait();
    }
  }

  public async deploy(paymentSplit: PaymentSplit) {
    const splitContract = this.getSplit();

    const tx = await splitContract.createSplit(
      paymentSplit.fees.map((c) => c.recipient),
      paymentSplit.fees.map((c) => c.bps),
      0,
      AddressZero
    );
    await tx.wait();

    // Mark as deployed
    await setPaymentSplitIsDeployed(paymentSplit.address);
  }

  public async addToQueue(params: DistributeFeesJobPayload) {
    await this.send({ payload: params });
  }
}

export const distributeFeesJob = new DistributeFeesJob();

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
              splits.forEach((split) =>
                distributeFeesJob.addToQueue({ paymentSplitAddress: split.address })
              )
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
