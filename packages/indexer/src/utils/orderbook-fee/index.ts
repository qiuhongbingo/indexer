import { AddressZero } from "@ethersproject/constants";

import { config } from "@/config/index";
import { OrderKind } from "@/orderbook/orders";
import {
  getPaymentSplitFromDb,
  generatePaymentSplit,
  supportsPaymentSplits,
} from "@/utils/payment-splits";
import { ApiKeyManager } from "@/models/api-keys";

const orderbookFeeEnabled =
  config.enableOrderbookFee || (config.environment !== "prod" && config.chainId === 11155111);

export const FEE_RECIPIENT = orderbookFeeEnabled
  ? "0xf3d63166f0ca56c3c1a3508fce03ff0cf3fb691e"
  : AddressZero;

export const ORDERBOOK_FEE_ORDER_KINDS: OrderKind[] = [
  "alienswap",
  "payment-processor",
  "payment-processor-v2",
  "seaport-v1.4",
  "seaport-v1.5",
  "seaport-v1.6",
];

const SINGLE_FEE_ORDER_KINDS: OrderKind[] = ["payment-processor-v2"];

export const attachOrderbookFee = async (
  params: {
    fee?: string[];
    feeRecipient?: string[];
    orderKind: OrderKind;
    orderbook: string;
  },
  apiKey?: string
) => {
  // Ensure orderbook fee enabled
  if (!orderbookFeeEnabled) {
    return;
  }

  // Only native orders
  if (params.orderbook != "reservoir") {
    return;
  }

  // Only certain order kinds
  if (!ORDERBOOK_FEE_ORDER_KINDS.includes(params.orderKind)) {
    return;
  }

  const FEE_BPS = apiKey
    ? await ApiKeyManager.getOrderbookFee(apiKey, params.orderKind)
    : ApiKeyManager.defaultOrderbookFeeBps;
  if (FEE_BPS > 0) {
    params.fee = params.fee ?? [];
    params.feeRecipient = params.feeRecipient ?? [];

    // Handle single fee order kinds by using a payment split
    if (params.fee.length >= 1 && SINGLE_FEE_ORDER_KINDS.includes(params.orderKind)) {
      // Skip chains where payment splits are not supported
      if (!supportsPaymentSplits()) {
        return;
      }

      const paymentSplit = await generatePaymentSplit(
        {
          recipient: params.feeRecipient[0],
          bps: Number(params.fee),
        },
        {
          recipient: FEE_RECIPIENT,
          bps: FEE_BPS,
        },
        apiKey
      );
      if (!paymentSplit) {
        throw new Error("Could not generate payment split");
      }

      // Override
      params.feeRecipient = [paymentSplit.address];
      params.fee = [String(params.fee.map(Number).reduce((a, b) => a + b) + FEE_BPS)];
    } else {
      params.fee.push(String(FEE_BPS));
      params.feeRecipient.push(FEE_RECIPIENT);
    }
  }
};

export const validateOrderbookFee = async (
  orderKind: OrderKind,
  feeBreakdown: {
    kind: string;
    recipient: string;
    bps: number;
  }[],
  isReservoir?: boolean,
  apiKey?: string
) => {
  // Ensure orderbook fee enabled
  if (!orderbookFeeEnabled) {
    return;
  }

  // Only native orders
  if (!isReservoir) {
    return;
  }

  // This is not the best place to add this check, but it does the job for now
  const totalBps = feeBreakdown.reduce((t, b) => t + b.bps, 0);
  if (totalBps > 10000) {
    throw new Error("invalid-fee");
  }

  // Only certain order kinds
  if (!ORDERBOOK_FEE_ORDER_KINDS.includes(orderKind)) {
    return;
  }

  const FEE_BPS = !apiKey
    ? ApiKeyManager.defaultOrderbookFeeBps
    : await ApiKeyManager.getOrderbookFee(apiKey, orderKind);
  if (FEE_BPS > 0) {
    let foundOrderbookFee = false;

    for (const fee of feeBreakdown) {
      if (fee.recipient.toLowerCase() === FEE_RECIPIENT.toLowerCase() && fee.bps === FEE_BPS) {
        foundOrderbookFee = true;
      }

      if (SINGLE_FEE_ORDER_KINDS.includes(orderKind)) {
        const paymentSplit = await getPaymentSplitFromDb(fee.recipient.toLowerCase());
        if (paymentSplit) {
          foundOrderbookFee = true;
        }
      }
    }

    if (!foundOrderbookFee) {
      throw new Error("missing-orderbook-fee");
    }
  }
};
