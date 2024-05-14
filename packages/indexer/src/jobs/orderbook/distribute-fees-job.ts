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

const PAYMENT_SPLIT_DEPLOY_THRESHOLD = bn(100);

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
              await this.deployAndDistribute(paymentSplit, currency);
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
    return new Contract(
      Sdk.ZeroExSplits.Addresses.SplitMain[config.chainId],
      new Interface([
        "function createSplit(address[] calldata accounts, uint32[] calldata percentAllocations, uint32 distributorFee, address controller) returns (address split)",
        "function distributeETH(address split, address[] calldata accounts, uint32[] calldata percentAllocations, uint32 distributorFee, address distributorAddress)",
        "function distributeERC20(address split, address token, address[] calldata accounts, uint32[] calldata percentAllocations, uint32 distributorFee, address distributorAddress)",
        "function withdraw(address account, uint256 withdrawETH, address[] tokens)",
      ])
    );
  }

  public getMulticall() {
    return new Contract(
      "0xca11bde05977b3631167028862be2a173976ca11",
      new Interface([
        "function aggregate3((address target, bool allowFailure, bytes data)[] calls)",
      ])
    );
  }

  public async deployAndDistribute(paymentSplit: PaymentSplit, currency: string) {
    const multicallContract = this.getMulticall();
    const splitContract = this.getSplit();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let deployCall: any | undefined;

    const code = await baseProvider.getCode(paymentSplit.address);
    if (code === "0x") {
      deployCall = {
        target: splitContract.address,
        allowFailure: false,
        data: splitContract.interface.encodeFunctionData("createSplit", [
          paymentSplit.fees.map((c) => c.recipient),
          paymentSplit.fees.map((c) => c.bps),
          0,
          AddressZero,
        ]),
      };
    } else {
      // Mark as deployed
      await setPaymentSplitIsDeployed(paymentSplit.address);
    }

    let multicallData: string;
    if (currency === Sdk.Common.Addresses.Native[config.chainId]) {
      let calls = [
        {
          target: splitContract.address,
          allowFailure: false,
          data: splitContract.interface.encodeFunctionData("distributeETH", [
            paymentSplit.address,
            paymentSplit.fees.map((c) => c.recipient),
            paymentSplit.fees.map((c) => c.bps),
            0,
            AddressZero,
          ]),
        },
        ...paymentSplit.fees.map(({ recipient }) => ({
          target: splitContract.address,
          allowFailure: false,
          data: splitContract.interface.encodeFunctionData("withdraw", [recipient, 1, []]),
        })),
      ];
      if (deployCall) {
        calls = [deployCall, ...calls];
      }

      multicallData = multicallContract.interface.encodeFunctionData("aggregate3", [calls]);
    } else {
      let calls = [
        {
          target: splitContract.address,
          allowFailure: false,
          data: splitContract.interface.encodeFunctionData("distributeERC20", [
            paymentSplit.address,
            currency,
            paymentSplit.fees.map((c) => c.recipient),
            paymentSplit.fees.map((c) => c.bps),
            0,
            AddressZero,
          ]),
        },
        ...paymentSplit.fees.map(({ recipient }) => ({
          target: splitContract.address,
          allowFailure: false,
          data: splitContract.interface.encodeFunctionData("withdraw", [recipient, 0, [currency]]),
        })),
      ];
      if (deployCall) {
        calls = [deployCall, ...calls];
      }

      multicallData = multicallContract.interface.encodeFunctionData("aggregate3", [calls]);
    }

    await paymentSplitDistributor()
      .sendTransaction({
        to: multicallContract.address,
        data: multicallData,
      })
      .then((tx) => tx.wait());
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
        .acquire([`distribute-fees-cron-lock`], (5 * 60 - 5) * 1000)
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
