import { AddressZero } from "@ethersproject/constants";

import { config } from "@/config/index";
import { OrderKind } from "@/orderbook/orders";
import {
  getPaymentSplitFromDb,
  generatePaymentSplit,
  supportsPaymentSplits,
} from "@/utils/payment-splits";
import { ApiKeyManager } from "@/models/api-keys";

export const FEE_BPS = config.enableOrderbookFee ? 50 : 0;
export const FEE_RECIPIENT = config.enableOrderbookFee
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
  apiKeyRaw?: string
) => {
  // Empty will cause the `generatePaymentSplit` to throw an error
  const apiKey = apiKeyRaw ?? "unknown";

  // Ensure orderbook fee enabled
  if (!config.enableOrderbookFee) {
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

  const FEE_BPS = await ApiKeyManager.getOrderbookFee(apiKey, params.orderKind);
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
        apiKey,
        {
          recipient: params.feeRecipient[0],
          bps: Number(params.fee),
        },
        {
          recipient: FEE_RECIPIENT,
          bps: FEE_BPS,
        }
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
  isReservoir?: boolean
) => {
  // Ensure orderbook fee enabled
  if (!config.enableOrderbookFee) {
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

  // TODO: should get the actual fee by API key
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
