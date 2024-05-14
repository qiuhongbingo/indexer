/* eslint-disable @typescript-eslint/no-explicit-any */

import { Request, RouteOptions } from "@hapi/hapi";
import Joi from "joi";

import { idb } from "@/common/db";
import { logger } from "@/common/logger";
import { fromBuffer, regex, toBuffer } from "@/common/utils";

const version = "v2";

export const getTransactionSyncedV2Options: RouteOptions = {
  description: "Check Transaction Status",
  notes: "Get a boolean response on whether a particular transaction was synced or not.",
  tags: ["api", "Manage Orders", "marketplace"],
  plugins: {
    "hapi-swagger": {
      order: 10,
    },
  },
  validate: {
    query: Joi.object({
      txHash: Joi.alternatives()
        .try(
          Joi.array()
            .max(80)
            .items(
              Joi.string()
                .lowercase()
                .pattern(/^0x[a-fA-F0-9]{64}$/)
            )
            .required(),
          Joi.string()
            .lowercase()
            .pattern(/^0x[a-fA-F0-9]{64}$/)
            .required()
        )
        .description(
          "Filter to a particular transaction. Example: `0x04654cc4c81882ed4d20b958e0eeb107915d75730110cce65333221439de6afc`"
        ),
      includeTransfers: Joi.boolean()
        .default(false)
        .description("If true, the depth of each order is included in the response."),
      limit: Joi.number()
        .integer()
        .min(1)
        .max(50)
        .default(50)
        .description("Amount of items returned in response. Max limit is 50."),
    }),
  },
  response: {
    schema: Joi.object({
      transactions: Joi.array().items(
        Joi.object({
          hash: Joi.string().required(),
          synced: Joi.boolean().required(),
          transfers: Joi.array().items(
            Joi.object({
              id: Joi.string(),
              token: Joi.object({
                contract: Joi.string().lowercase().pattern(regex.address),
                tokenId: Joi.string().pattern(regex.number),
              }),
              from: Joi.string().lowercase().pattern(regex.address),
              to: Joi.string().lowercase().pattern(regex.address),
              amount: Joi.string().description("Can be more than 1 if erc1155."),
              block: Joi.number(),
              logIndex: Joi.number(),
              batchIndex: Joi.number(),
              timestamp: Joi.number(),
            })
          ),
        })
      ),
    }).label(`getTransactionSynced${version.toUpperCase()}Response`),
    failAction: (_request, _h, error) => {
      logger.error(`get-transaction-synced-${version}-handler`, `Wrong response schema: ${error}`);
      throw error;
    },
  },
  handler: async (request: Request) => {
    const query = request.query as any;

    if (!Array.isArray(query.txHash)) {
      query.txHash = [query.txHash];
    }

    query.txHash = query.txHash.map((txHash: string) => toBuffer(txHash));

    let selectTransfersQueryPart = "";
    let joinTransfersQueryPart = "";

    if (query.includeTransfers) {
      selectTransfersQueryPart = ", t.*";
      joinTransfersQueryPart = `
        LEFT JOIN LATERAL (
          SELECT array_agg(
              json_build_object(
                'token', json_build_object(
                  'contract', concat('0x', encode(nte.address, 'hex')),
                  'tokenId', nte.token_id::text
                ),
                'from', concat('0x', encode(nte.from, 'hex')),
                'to', concat('0x', encode(nte.to, 'hex')),
                'amount', nte.amount::text,
                'block', nte.block,
                'logIndex', nte.log_index,
                'batchIndex', nte.batch_index,
                'timestamp', nte.timestamp
              )
            ) as "transfers"
          FROM nft_transfer_events nte
          WHERE nte.tx_hash = transactions.hash
        ) t ON TRUE
        `;
    }
    const baseQuery = `
        SELECT 
            hash
            ${selectTransfersQueryPart}
        FROM transactions
        ${joinTransfersQueryPart}
        WHERE transactions.hash IN ($/txHash:csv/)
      `;

    const rawResult = await idb.manyOrNone(baseQuery, query);

    const transactions = [];

    for (const txHash of query.txHash) {
      const transaction = rawResult.find((result: any) => result.hash.equals(txHash));

      if (transaction) {
        transactions.push({
          hash: fromBuffer(txHash),
          synced: true,
          transfers: transaction.transfers,
        });
      } else {
        transactions.push({ hash: fromBuffer(txHash), synced: false });
      }
    }

    return { transactions };
  },
};
