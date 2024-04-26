import { config as dotEnvConfig } from "dotenv";

dotEnvConfig();

// import { attachOrderbookFee } from "../../utils/orderbook-fee";
import { jest, describe, it, expect } from "@jest/globals";
import { OrderKind } from "@/orderbook/orders";
import * as Sdk from "@reservoir0x/sdk";
import { config } from "@/config/index";
import * as orderbookFee from "@/utils/orderbook-fee";
import { getPaymentSplits } from "@/utils/payment-splits";

import { distributeFeeJob } from "@/jobs/orderbook/distribute-fee-job";

jest.setTimeout(1000 * 1000);

describe("Fee Split", () => {
  it("single-fee-split", async () => {
    const params = {
      fee: ["300"],
      feeRecipient: ["0x95222290dd7278aa3ddd389cc1e1d165cc4bafe5"],
      orderKind: "payment-processor-v2",
      orderbook: "reservoir",
      currency: Sdk.Common.Addresses.WNative[config.chainId],
    };

    await orderbookFee.attachOrderbookFee(
      params as {
        fee?: string[];
        feeRecipient?: string[];
        orderKind: OrderKind;
        orderbook: string;
        currency: string;
      },
      "testkey"
    );

    expect(params.fee.length).toBe(1);
  });

  it("distribute", async () => {
    const splits = await getPaymentSplits();

    // console.log(splits)
    await distributeFeeJob.process({
      address: splits[0].address,
    });
  });
});
