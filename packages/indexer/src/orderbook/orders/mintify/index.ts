import { AddressZero } from "@ethersproject/constants";
import * as Sdk from "@reservoir0x/sdk";
import _ from "lodash";
import pLimit from "p-limit";

import { idb, pgp } from "@/common/db";
import { logger } from "@/common/logger";
import { baseProvider } from "@/common/provider";
import { bn, now, toBuffer } from "@/common/utils";
import { config } from "@/config/index";
import { getNetworkSettings } from "@/config/network";
import { FeeRecipients } from "@/models/fee-recipients";
import { addPendingData } from "@/jobs/arweave-relay";
import {
  orderUpdatesByIdJob,
  OrderUpdatesByIdJobPayload,
} from "@/jobs/order-updates/order-updates-by-id-job";
import { orderbookOrdersJob } from "@/jobs/orderbook/orderbook-orders-job";
import { Sources } from "@/models/sources";
import { SourcesEntity } from "@/models/sources/sources-entity";
import { topBidsCache } from "@/models/top-bids-caching";
import { DbOrder, OrderMetadata, generateSchemaHash } from "@/orderbook/orders/utils";
import { offChainCheck } from "@/orderbook/orders/seaport-base/check";
import { getCollectionFloorAskValue } from "@/orderbook/orders/seaport-base/utils";
import * as tokenSet from "@/orderbook/token-sets";
import { getCurrency } from "@/utils/currencies";
import * as erc721c from "@/utils/erc721c";
import { checkMarketplaceIsFiltered } from "@/utils/marketplace-blacklists";
import * as offchainCancel from "@/utils/offchain-cancel";
import { validateOrderbookFee } from "@/utils/orderbook-fee";
import { getUSDAndNativePrices } from "@/utils/prices";
import * as royalties from "@/utils/royalties";

export type OrderInfo = {
  orderParams: Sdk.SeaportBase.Types.OrderComponents;
  metadata: OrderMetadata;
};

type SaveResult = {
  id: string;
  status: string;
  unfillable?: boolean;
  delay?: number;
};

export const save = async (
  orderInfos: OrderInfo[],
  validateBidValue?: boolean,
  ingestMethod?: "websocket" | "rest",
  ingestDelay?: number
): Promise<SaveResult[]> => {
  const results: SaveResult[] = [];
  const orderValues: DbOrder[] = [];

  const handleOrder = async (
    orderParams: Sdk.SeaportBase.Types.OrderComponents,
    metadata: OrderMetadata
  ) => {
    try {
      const order = new Sdk.Mintify.Order(config.chainId, orderParams);
      const info = order.getInfo();
      const id = order.hash();

      // Check: order has a valid format
      if (!info) {
        return results.push({
          id,
          status: "invalid-format",
        });
      }

      // Check: order doesn't already exist
      const orderExists = await idb.oneOrNone(
        `
          WITH x AS (
            UPDATE orders
            SET
              raw_data = $/rawData/,
              updated_at = now()
            WHERE orders.id = $/id/
              AND raw_data IS NULL
          )
          SELECT 1 FROM orders WHERE orders.id = $/id/
        `,
        {
          id,
          rawData: order.params,
        }
      );

      if (orderExists) {
        return results.push({
          id,
          status: "already-exists",
        });
      }

      // Check: order has a supported conduit
      // if (
      //   !(await isOpen(order.params.conduitKey, Sdk.Mintify.Addresses.Exchange[config.chainId]))
      // ) {
      //   return results.push({
      //     id,
      //     status: "unsupported-conduit",
      //   });
      // }

      // Check: order has a non-zero price
      if (bn(info.price).lte(0)) {
        return results.push({
          id,
          status: "zero-price",
        });
      }

      const currentTime = now();
      const inTheFutureThreshold = 7 * 24 * 60 * 60;

      // Check: order has a valid start time
      const startTime = order.params.startTime;
      if (startTime - inTheFutureThreshold >= currentTime) {
        return results.push({
          id,
          status: "invalid-start-time",
        });
      }

      // Delay the validation of the order if it's start time is very soon in the future
      if (startTime > currentTime) {
        await orderbookOrdersJob.addToQueue(
          [
            {
              kind: "mintify",
              info: { orderParams, metadata },
              validateBidValue,
              ingestMethod,
              ingestDelay: startTime - currentTime + 5,
            },
          ],
          startTime - currentTime + 5,
          id
        );

        return results.push({
          id,
          status: "delayed",
        });
      }

      // Check: order is not expired
      const endTime = order.params.endTime;
      if (currentTime >= endTime) {
        return results.push({
          id,
          status: "expired",
        });
      }

      const isFiltered = await checkMarketplaceIsFiltered(info.contract, [
        new Sdk.Mintify.Exchange(config.chainId).deriveConduit(order.params.conduitKey),
      ]);
      if (isFiltered) {
        return results.push({
          id,
          status: "filtered",
        });
      }

      const erc721cConfigV2 = await erc721c.v2.getConfigFromDb(info.contract);
      if (erc721cConfigV2) {
        const osCustomTransferValidator =
          Sdk.SeaportBase.Addresses.OpenSeaCustomTransferValidator[config.chainId];
        if (
          osCustomTransferValidator &&
          erc721cConfigV2.transferValidator === osCustomTransferValidator
        ) {
          return results.push({
            id,
            status: "filtered",
          });
        }
      }

      // Check: buy order has a supported payment token
      if (info.side === "buy" && !getNetworkSettings().supportedBidCurrencies[info.paymentToken]) {
        return results.push({
          id,
          status: "unsupported-payment-token",
        });
      }

      // Check: order is partially-fillable
      const quantityRemaining = info.amount ?? "1";
      if ([0, 2].includes(order.params.orderType) && bn(quantityRemaining).gt(1)) {
        return results.push({
          id,
          status: "not-partially-fillable",
        });
      }

      // Check: order has a known zone
      if (order.params.orderType > 1) {
        if (
          ![
            // No zone
            AddressZero,
            // Cancellation zone
            Sdk.SeaportBase.Addresses.ReservoirV16CancellationZone[config.chainId],
          ].includes(order.params.zone)
        ) {
          return results.push({
            id,
            status: "unsupported-zone",
          });
        }
      }

      // Check: order is valid
      try {
        order.checkValidity();
      } catch {
        return results.push({
          id,
          status: "invalid",
        });
      }

      // Make sure no zero signatures are allowed
      if (order.params.signature && /^0x0+$/g.test(order.params.signature)) {
        order.params.signature = undefined;
      }

      // Check: order has a valid signature
      if (metadata.fromOnChain) {
        // Skip if:
        // - the order was validated on-chain
        // - the order is coming from OpenSea / Okx and it doesn't have a signature
      } else {
        try {
          await order.checkSignature(baseProvider);
        } catch {
          return results.push({
            id,
            status: "invalid-signature",
          });
        }
      }

      // Check: order fillability
      let fillabilityStatus = "fillable";
      let approvalStatus = "approved";
      const exchange = new Sdk.Mintify.Exchange(config.chainId);
      try {
        await offChainCheck(order, "mintify", exchange, {
          onChainApprovalRecheck: true,
          singleTokenERC721ApprovalCheck: metadata.fromOnChain,
          permitId: metadata.permitId,
          permitIndex: metadata.permitIndex,
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (error: any) {
        // Keep any orders that can potentially get valid in the future
        if (error.message === "no-balance-no-approval") {
          fillabilityStatus = "no-balance";
          approvalStatus = "no-approval";
        } else if (error.message === "no-approval") {
          approvalStatus = "no-approval";
        } else if (error.message === "no-balance") {
          fillabilityStatus = "no-balance";
        } else {
          return results.push({
            id,
            status: "not-fillable",
          });
        }
      }

      // Mark the order when using permits
      if (metadata.permitId) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (order.params as any).permitId = metadata.permitId;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (order.params as any).permitIndex = metadata.permitIndex ?? 0;
      }

      // Check and save: associated token set
      let tokenSetId: string | undefined;
      const schemaHash = metadata.schemaHash ?? generateSchemaHash(metadata.schema);
      switch (order.params.kind) {
        case "single-token": {
          const typedInfo = info as typeof info & { tokenId: string };
          const tokenId = typedInfo.tokenId;

          tokenSetId = `token:${info.contract}:${tokenId}`;
          if (tokenId) {
            await tokenSet.singleToken.save([
              {
                id: tokenSetId,
                schemaHash,
                contract: info.contract,
                tokenId,
              },
            ]);
          }

          break;
        }

        case "contract-wide": {
          tokenSetId = `contract:${info.contract}`;
          await tokenSet.contractWide.save([
            {
              id: tokenSetId,
              schemaHash,
              contract: info.contract,
            },
          ]);

          break;
        }

        case "token-list": {
          const typedInfo = info as typeof info & { merkleRoot: string };
          const merkleRoot = typedInfo.merkleRoot;

          if (merkleRoot) {
            tokenSetId = `list:${info.contract}:${bn(merkleRoot).toHexString()}`;

            const ts = await tokenSet.tokenList.save([
              {
                id: tokenSetId,
                schemaHash,
                schema: metadata.schema,
              },
            ]);

            logger.info(
              "orders-mintify-save",
              `TokenList. orderId=${id}, tokenSetId=${tokenSetId}, schemaHash=${schemaHash}, metadata=${JSON.stringify(
                metadata
              )}, ts=${JSON.stringify(ts)}`
            );
          }

          break;
        }
      }

      if (!tokenSetId) {
        return results.push({
          id,
          status: "invalid-token-set",
        });
      }

      // Handle: fees
      let feeAmount = order.getFeeAmount();

      // Handle: price and value
      let price = bn(order.getMatchingPrice(Math.max(now(), startTime)));
      let value = price;
      if (info.side === "buy") {
        // For buy orders, we set the value as `price - fee` since it
        // is best for UX to show the user exactly what they're going
        // to receive on offer acceptance.
        value = bn(price).sub(feeAmount);
      }

      if (price.lt(0) || value.lt(0)) {
        return results.push({
          id,
          status: "negative-price",
        });
      }

      // The price, value and fee are for a single item
      if (bn(info.amount).gt(1)) {
        price = price.div(info.amount);
        value = value.div(info.amount);
        feeAmount = feeAmount.div(info.amount);
      }

      // Handle: royalties
      let openSeaRoyalties: royalties.Royalty[];
      if (order.params.kind === "single-token") {
        openSeaRoyalties = await royalties.getRoyalties(info.contract, info.tokenId, "", true);
      } else {
        openSeaRoyalties = await royalties.getRoyaltiesByTokenSet(tokenSetId, "", true);
      }

      const feeRecipients = await FeeRecipients.getInstance();

      let feeBps = 0;
      let knownFee = false;
      const feeBreakdown = info.fees.map(({ recipient, amount }) => {
        const bps = price.eq(0)
          ? 0
          : bn(amount)
              .div(info.amount ?? 1)
              .mul(10000)
              .div(price)
              .toNumber();
        feeBps += bps;

        const kind: "marketplace" | "royalty" = feeRecipients.getByAddress(
          recipient.toLowerCase(),
          "marketplace"
        )
          ? "marketplace"
          : "royalty";

        // Check for unknown fees
        knownFee =
          knownFee ||
          !openSeaRoyalties.map(({ recipient }) => recipient).includes(recipient.toLowerCase()); // Check for locally stored royalties

        return {
          kind,
          recipient,
          bps,
        };
      });

      if (feeBps > 10000) {
        return results.push({
          id,
          status: "fees-too-high",
        });
      }

      // Validate the potential inclusion of an orderbook fee
      try {
        await validateOrderbookFee("mintify", feeBreakdown, metadata.apiKey, true);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (error: any) {
        return results.push({
          id,
          status: error.message,
        });
      }

      // Handle: royalties on top
      const defaultRoyalties =
        info.side === "sell"
          ? await royalties.getRoyalties(info.contract, info.tokenId, "default")
          : await royalties.getRoyaltiesByTokenSet(tokenSetId, "default");

      const totalBuiltInBps = feeBreakdown
        .map(({ bps, kind }) => (kind === "royalty" ? bps : 0))
        .reduce((a, b) => a + b, 0);
      const totalDefaultBps = defaultRoyalties.map(({ bps }) => bps).reduce((a, b) => a + b, 0);

      const missingRoyalties = [];
      let missingRoyaltyAmount = bn(0);
      if (totalBuiltInBps < totalDefaultBps) {
        const validRecipients = defaultRoyalties.filter(
          ({ bps, recipient }) => bps && recipient !== AddressZero
        );
        if (validRecipients.length) {
          const bpsDiff = totalDefaultBps - totalBuiltInBps;
          const amount = bn(price).mul(bpsDiff).div(10000);
          missingRoyaltyAmount = missingRoyaltyAmount.add(amount);

          // Split the missing royalties pro-rata across all royalty recipients
          const totalBps = _.sumBy(validRecipients, ({ bps }) => bps);
          for (const { bps, recipient } of validRecipients) {
            // TODO: Handle lost precision (by paying it to the last or first recipient)
            missingRoyalties.push({
              bps: Math.floor((bpsDiff * bps) / totalBps),
              amount: amount.mul(bps).div(totalBps).toString(),
              recipient,
            });
          }
        }
      }

      // Handle: source
      const sources = await Sources.getInstance();

      let source: SourcesEntity | undefined;

      if (metadata.source) {
        source = await sources.getOrInsert(metadata.source);
      } else {
        const sourceHash = bn(order.params.salt)._hex.slice(0, 10);
        const matchedSource = sources.getByDomainHash(sourceHash);
        if (matchedSource) {
          source = matchedSource;
        }
      }

      // If the order is native, override any default source
      if (metadata.source) {
        source = await sources.getOrInsert(metadata.source);
      } else {
        source = undefined;
      }

      // Handle: price conversion
      const currency = info.paymentToken;
      if ((await getCurrency(currency)).metadata?.erc20Incompatible) {
        return results.push({
          id,
          status: "incompatible-currency",
        });
      }

      const currencyPrice = price.toString();
      const currencyValue = value.toString();

      let needsConversion = false;
      if (
        ![
          Sdk.Common.Addresses.Native[config.chainId],
          Sdk.Common.Addresses.WNative[config.chainId],
        ].includes(currency)
      ) {
        needsConversion = true;

        // If the currency is anything other than ETH/WETH, we convert
        // `price` and `value` from that currency denominations to the
        // ETH denomination
        {
          const prices = await getUSDAndNativePrices(currency, price.toString(), currentTime, {
            nonZeroCommunityTokens: true,
          });
          if (!prices.nativePrice) {
            // Getting the native price is a must
            return results.push({
              id,
              status: "failed-to-convert-price",
            });
          }
          price = bn(prices.nativePrice);
        }
        {
          const prices = await getUSDAndNativePrices(currency, value.toString(), currentTime, {
            nonZeroCommunityTokens: true,
          });
          if (!prices.nativePrice) {
            // Getting the native price is a must
            return results.push({
              id,
              status: "failed-to-convert-price",
            });
          }
          value = bn(prices.nativePrice);
        }
      }

      // Handle: normalized value
      const currencyNormalizedValue =
        info.side === "sell"
          ? bn(currencyValue).add(missingRoyaltyAmount).toString()
          : bn(currencyValue).sub(missingRoyaltyAmount).toString();

      const prices = await getUSDAndNativePrices(currency, currencyNormalizedValue, currentTime, {
        nonZeroCommunityTokens: true,
      });
      if (!prices.nativePrice) {
        // Getting the native price is a must
        return results.push({
          id,
          status: "failed-to-convert-price",
        });
      }
      const normalizedValue = bn(prices.nativePrice).toString();

      if (info.side === "buy" && order.params.kind === "single-token" && validateBidValue) {
        const typedInfo = info as typeof info & { tokenId: string };
        const tokenId = typedInfo.tokenId;
        const seaportBidPercentageThreshold = 80;

        try {
          const collectionTopBidValue = await topBidsCache.getCollectionTopBidValue(
            info.contract,
            Number(tokenId)
          );

          if (collectionTopBidValue) {
            if (Number(value.toString()) <= collectionTopBidValue) {
              return results.push({
                id,
                status: "bid-too-low",
              });
            }
          } else {
            const collectionFloorAskValue = await getCollectionFloorAskValue(
              info.contract,
              Number(tokenId)
            );

            if (collectionFloorAskValue) {
              const percentage = (Number(value.toString()) / collectionFloorAskValue) * 100;

              if (percentage < seaportBidPercentageThreshold) {
                return results.push({
                  id,
                  status: "bid-too-low",
                });
              }
            }
          }
        } catch (error) {
          logger.warn(
            "orders-mintify-save",
            `Bid value validation - error. orderId=${id}, contract=${info.contract}, tokenId=${tokenId}, error=${error}`
          );
        }
      }

      // Handle: off-chain cancellation via replacement
      if (
        order.params.zone === Sdk.SeaportBase.Addresses.ReservoirV16CancellationZone[config.chainId]
      ) {
        const replacedOrderResult = await idb.oneOrNone(
          `
            SELECT
              orders.raw_data
            FROM orders
            WHERE orders.id = $/id/
          `,
          {
            id: order.params.salt,
          }
        );
        if (
          replacedOrderResult &&
          // Replacement is only possible if the replaced order is an off-chain cancellable one
          replacedOrderResult.raw_data.zone ===
            Sdk.SeaportBase.Addresses.ReservoirV16CancellationZone[config.chainId]
        ) {
          await offchainCancel.seaport.doReplacement({
            newOrders: [order.params],
            replacedOrders: [replacedOrderResult.raw_data],
            orderKind: "mintify",
          });
        }
      }

      const validFrom = `date_trunc('seconds', to_timestamp(${startTime}))`;
      const validTo = endTime
        ? `date_trunc('seconds', to_timestamp(${order.params.endTime}))`
        : "'infinity'";
      orderValues.push({
        id,
        kind: "mintify",
        side: info.side,
        fillability_status: fillabilityStatus,
        approval_status: approvalStatus,
        token_set_id: tokenSetId,
        token_set_schema_hash: toBuffer(schemaHash),
        maker: toBuffer(order.params.offerer),
        taker: toBuffer(info.taker),
        price: price.toString(),
        value: value.toString(),
        currency: toBuffer(info.paymentToken),
        currency_price: currencyPrice.toString(),
        currency_value: currencyValue.toString(),
        needs_conversion: needsConversion,
        quantity_remaining: quantityRemaining,
        valid_between: `tstzrange(${validFrom}, ${validTo}, '[]')`,
        nonce: bn(order.params.counter).toString(),
        source_id_int: source?.id,
        is_reservoir: true,
        contract: toBuffer(info.contract),
        conduit: toBuffer(
          new Sdk.Mintify.Exchange(config.chainId).deriveConduit(order.params.conduitKey)
        ),
        fee_bps: feeBps,
        fee_breakdown: feeBreakdown || null,
        dynamic: info.isDynamic ?? null,
        raw_data: order.params,
        expiration: validTo,
        missing_royalties: missingRoyalties,
        normalized_value: normalizedValue,
        currency_normalized_value: currencyNormalizedValue,
        originated_at: metadata.originatedAt ?? null,
      });

      const unfillable =
        fillabilityStatus !== "fillable" ||
        approvalStatus !== "approved" ||
        // Skip private orders
        info.taker !== AddressZero
          ? true
          : undefined;

      results.push({
        id,
        status: "success",
        unfillable,
      });

      if (!unfillable) {
        await addPendingData([
          JSON.stringify({
            kind: "mintify",
            data: order.params,
          }),
        ]);
      }
    } catch (error) {
      logger.warn(
        "orders-mintify-save",
        `Failed to handle order (will retry). orderParams=${JSON.stringify(
          orderParams
        )}, metadata=${JSON.stringify(metadata)}, error=${error}`
      );
    }
  };

  // Process all orders concurrently
  const limit = pLimit(15);
  await Promise.all(
    orderInfos.map((orderInfo) =>
      limit(async () =>
        handleOrder(
          orderInfo.orderParams as Sdk.SeaportBase.Types.OrderComponents,
          orderInfo.metadata
        )
      )
    )
  );

  if (orderValues.length) {
    const columns = new pgp.helpers.ColumnSet(
      [
        "id",
        "kind",
        "side",
        "fillability_status",
        "approval_status",
        "token_set_id",
        "token_set_schema_hash",
        "maker",
        "taker",
        "price",
        "value",
        "currency",
        "currency_price",
        "currency_value",
        "needs_conversion",
        "quantity_remaining",
        { name: "valid_between", mod: ":raw" },
        "nonce",
        "source_id_int",
        "is_reservoir",
        "contract",
        "conduit",
        "fee_bps",
        { name: "fee_breakdown", mod: ":json" },
        "dynamic",
        "raw_data",
        { name: "expiration", mod: ":raw" },
        { name: "missing_royalties", mod: ":json" },
        "normalized_value",
        "currency_normalized_value",
        "originated_at",
      ],
      {
        table: "orders",
      }
    );

    await idb.none(pgp.helpers.insert(orderValues, columns) + " ON CONFLICT DO NOTHING");

    await orderUpdatesByIdJob.addToQueue(
      results
        .filter((r) => r.status === "success" && !r.unfillable)
        .map(
          ({ id }) =>
            ({
              context: `new-order-${id}`,
              id,
              trigger: {
                kind: "new-order",
              },
              ingestMethod,
              ingestDelay,
            } as OrderUpdatesByIdJobPayload)
        )
    );
  }

  return results;
};
