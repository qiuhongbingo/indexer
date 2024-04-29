import { config } from "@/config/index";
import { ApiKeyManager } from "@/models/api-keys";
import { OrderKind } from "@/orderbook/orders";
import {
  getPaymentSplitFromDb,
  generatePaymentSplit,
  getPaymentSplitBalance,
  supportsPaymentSplits,
  updatePaymentSplitBalance,
} from "@/utils/payment-splits";

const orderbookFeeEnabled = config.chainId === 11155111;

export const FEE_RECIPIENT = "0xf3d63166f0ca56c3c1a3508fce03ff0cf3fb691e";

export const ORDERBOOK_FEE_ORDER_KINDS: OrderKind[] = [
  "alienswap",
  "payment-processor",
  "payment-processor-v2",
  "seaport-v1.4",
  "seaport-v1.5",
  "seaport-v1.6",
];

const SINGLE_FEE_ORDER_KINDS: OrderKind[] = ["payment-processor", "payment-processor-v2"];

export const attachOrderbookFee = async (
  params: {
    fee?: string[];
    feeRecipient?: string[];
    orderKind: OrderKind;
    orderbook: string;
    currency: string;
  },
  apiKey = ""
) => {
  // Only if enabled
  if (!orderbookFeeEnabled) {
    return;
  }

  // Only native orders
  if (params.orderbook != "reservoir") {
    return;
  }

  const feeBps = await ApiKeyManager.getOrderbookFee(apiKey, params.orderKind);

  if (feeBps > 0) {
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
          bps: feeBps,
        },
        apiKey
      );
      if (!paymentSplit) {
        throw new Error("Could not generate payment split");
      }

      // Keep track of the currency
      const balance = await getPaymentSplitBalance(paymentSplit.address, params.currency);
      if (!balance) {
        await updatePaymentSplitBalance(paymentSplit.address, params.currency, "0");
      }

      // Override
      params.feeRecipient = [paymentSplit.address];
      params.fee = [String(params.fee.map(Number).reduce((a, b) => a + b) + feeBps)];
    } else {
      params.fee.push(String(feeBps));
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
  apiKey = "",
  isReservoir?: boolean
) => {
  // Only if enabled
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

  const feeBps = await ApiKeyManager.getOrderbookFee(apiKey, orderKind);

  if (feeBps > 0) {
    let foundOrderbookFee = false;

    for (const fee of feeBreakdown) {
      if (fee.recipient.toLowerCase() === FEE_RECIPIENT.toLowerCase() && fee.bps === feeBps) {
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
