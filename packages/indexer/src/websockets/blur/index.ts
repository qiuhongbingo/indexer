import * as Sdk from "@reservoir0x/sdk";
import { io } from "socket.io-client";

import { logger } from "@/common/logger";
import { config } from "@/config/index";
import { blurBidsBufferJob } from "@/jobs/order-updates/misc/blur-bids-buffer-job";
import { blurListingsRefreshJob } from "@/jobs/order-updates/misc/blur-listings-refresh-job";
import { orderbookOrdersJob } from "@/jobs/orderbook/orderbook-orders-job";

const COMPONENT = "blur-websocket";

if (
  [1, 81457].includes(config.chainId) &&
  config.doWebsocketWork &&
  config.blurWsUrl &&
  config.blurWsApiKey
) {
  const client = io(config.blurWsUrl, {
    transports: ["websocket"],
    auth: {
      "api-key": config.blurWsApiKey,
    },
  });

  client.on("connect", () => {
    logger.info(COMPONENT, `Connected to Blur via websocket (${config.blurWsUrl})`);
  });

  client.on("connect_error", (error) => {
    logger.error(COMPONENT, `Error from Blur websocket: ${error}`);
  });

  // Listings
  client.on(
    config.chainId === 1 ? "newTopsOfBooks" : "blastNewTopsOfBooks",
    async (message: string) => {
      try {
        const parsedMessage: {
          contractAddress: string;
          tops: {
            tokenId: string;
            topAsk: {
              amount: string;
              unit: string;
              createdAt: string;
              marketplace: string;
            } | null;
          }[];
        } = JSON.parse(message);

        const collection = parsedMessage.contractAddress.toLowerCase();
        if (
          config.chainId === 81457 &&
          collection !== "0x16594af3945fcb290c6cd9de998698a3216f6e1a" &&
          collection !== "0x1195cf65f83b3a5768f3c496d3a05ad6412c64b7"
        ) {
          return;
        }

        const orderInfos = parsedMessage.tops.map((t) => ({
          kind: "blur-listing",
          info: {
            orderParams: {
              collection,
              tokenId: t.tokenId,
              price: t.topAsk?.marketplace === "BLUR" ? t.topAsk.amount : undefined,
              createdAt: t.topAsk?.marketplace === "BLUR" ? t.topAsk.createdAt : undefined,
              fromWebsocket: true,
            },
            metadata: {},
          },
          ingestMethod: "websocket",
        }));

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await orderbookOrdersJob.addToQueue(orderInfos as any);
        await blurListingsRefreshJob.addToQueue(collection);
      } catch (error) {
        logger.error(COMPONENT, `Error handling listing: ${error} (message = ${message})`);
      }
    }
  );

  // Collection bids
  client.on(
    config.chainId === 1 ? "CollectionBidsPrice" : "blastCollectionBidsPrice",
    async (message: string) => {
      try {
        const parsedMessage: {
          contractAddress: string;
          updates: Sdk.Blur.Types.BlurBidPricePoint[];
        } = JSON.parse(message);

        const collection = parsedMessage.contractAddress.toLowerCase();
        if (
          config.chainId === 81457 &&
          collection !== "0x16594af3945fcb290c6cd9de998698a3216f6e1a" &&
          collection !== "0x1195cf65f83b3a5768f3c496d3a05ad6412c64b7"
        ) {
          return;
        }

        const pricePoints = parsedMessage.updates;

        await blurBidsBufferJob.addToQueue(
          {
            collection,
          },
          pricePoints
        );
      } catch (error) {
        logger.error(COMPONENT, `Error handling collection bid: ${error} (message = ${message})`);
      }
    }
  );

  // Trait bids
  if (config.chainId === 1) {
    client.on("trait_bidLevels", async (message: string) => {
      try {
        type PricePointWithAttribute = Sdk.Blur.Types.BlurBidPricePoint & {
          criteriaType: string;
          criteriaValue: { [key: string]: string };
        };

        const parsedMessage: {
          contractAddress: string;
          updates: PricePointWithAttribute[];
        } = JSON.parse(message);

        const collection = parsedMessage.contractAddress.toLowerCase();
        const allTraitUpdates = parsedMessage.updates.filter((d) => d.criteriaType === "TRAIT");

        // Group all updates by their corresponding trait
        const groupedTraitUpdates: {
          [attributeId: string]: PricePointWithAttribute[];
        } = {};
        for (const update of allTraitUpdates) {
          const keys = Object.keys(update.criteriaValue);
          if (keys.length === 1) {
            const attributeKey = keys[0];
            const attributeValue = update.criteriaValue[attributeKey];

            const attributeId = `${attributeKey}:${attributeValue}`;
            if (!groupedTraitUpdates[attributeId]) {
              groupedTraitUpdates[attributeId] = [];
            }
            groupedTraitUpdates[attributeId].push(update);
          }
        }

        await Promise.all(
          Object.keys(groupedTraitUpdates).map(async (attributeId) => {
            const [attributeKey, attributeValue] = attributeId.split(":");
            await blurBidsBufferJob.addToQueue(
              {
                collection,
                attribute: {
                  key: attributeKey,
                  value: attributeValue,
                },
              },
              groupedTraitUpdates[attributeId]
            );
          })
        );
      } catch (error) {
        logger.error(COMPONENT, `Error handling trait bid: ${error} (message = ${message})`);
      }
    });
  }
}
