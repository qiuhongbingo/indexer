/* eslint-disable @typescript-eslint/no-unused-vars,@typescript-eslint/no-empty-function */

import { config as dotEnvConfig } from "dotenv";
dotEnvConfig();

import { jest, describe, it, expect } from "@jest/globals";
import { validateSwapPrice } from "@/utils/prices";

jest.setTimeout(1000 * 1000);

describe("Swap validate", () => {
  it("sell", async () => {
    let error;
    try {
      validateSwapPrice(
        [
          {
            currency: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
            totalRawPrice: "244900000000000000",
            sellOutCurrency: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
            sellOutRawQuote: "732630962",
          },
        ],
        [
          {
            tokenIn: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
            amountIn: "238777500000000000",
            amountOut: "597989992",
          },
        ]
      );
    } catch (err) {
      error = err;
    }

    expect(error).not.toBe(undefined);
  });

  it("buy", async () => {
    let error;
    try {
      validateSwapPrice(
        [
          {
            currency: "0x0000000000000000000000000000000000000000",
            totalRawPrice: "168900000000000000",
            buyInCurrency: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
            buyInRawQuote: "517731672",
          },
        ],
        [
          {
            tokenIn: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
            amountIn: "663739973",
            amountOut: "168900000000000000",
          },
        ]
      );
    } catch (err) {
      error = err;
    }

    expect(error).not.toBe(undefined);
  });
});
