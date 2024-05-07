/* eslint-disable @typescript-eslint/no-explicit-any */

import { Request, RouteOptions } from "@hapi/hapi";

import Joi from "joi";

import { redb } from "@/common/db";
import { logger } from "@/common/logger";
import { JoiOrder, getJoiOrderObject } from "@/common/joi";
import {
  buildContinuation,
  getNetAmount,
  regex,
  splitContinuation,
  toBuffer,
} from "@/common/utils";

import { Orders } from "@/utils/orders";
import _ from "lodash";

const version = "v1";

export const getTokenAsksV1Options: RouteOptions = {
  description: "Token Asks (listings)",
  notes: "Get a list of asks (listings), filtered by token.",
  tags: ["api", "Tokens"],
  plugins: {
    "hapi-swagger": {
      order: 5,
    },
  },
  validate: {
    params: Joi.object({
      token: Joi.string()
        .lowercase()
        .pattern(/^0x[a-fA-F0-9]{40}:[0-9]+$/)
        .description(
          "The token to get asks for. Example: `0x8d04a8c79ceb0889bdd12acdf3fa9d207ed3ff63:123`"
        )
        .required(),
    }),
    query: Joi.object({
      includeCriteriaMetadata: Joi.boolean()
        .default(false)
        .description("If true, criteria metadata is included in the response."),
      includeRawData: Joi.boolean()
        .default(false)
        .description("If true, raw data is included in the response."),
      includeDynamicPricing: Joi.boolean()
        .default(false)
        .description("If true, dynamic pricing data will be returned in the response."),
      normalizeRoyalties: Joi.boolean()
        .default(false)
        .description("If true, prices will include missing royalties to be added on-top."),
      continuation: Joi.string()
        .pattern(regex.base64)
        .description("Use continuation token to request next offset of items."),
      limit: Joi.number()
        .integer()
        .min(1)
        .max(50)
        .default(50)
        .description("Amount of items returned in response. Max limit is 50."),
      displayCurrency: Joi.string()
        .lowercase()
        .pattern(regex.address)
        .description("Return result in given currency"),
    }),
  },
  response: {
    schema: Joi.object({
      orders: Joi.array().items(JoiOrder),
      continuation: Joi.string().pattern(regex.base64).allow(null),
    }).label(`getTokenAsks${version.toUpperCase()}Response`),
    failAction: (_request, _h, error) => {
      logger.error(`get-token-asks-${version}-handler`, `Wrong response schema: ${error}`);
      throw error;
    },
  },
  handler: async (request: Request) => {
    const query = request.query as any;

    const [contract, tokenId] = request.params.token.split(":");

    (query as any).contract = toBuffer(contract);
    (query as any).tokenId = tokenId;

    try {
      const criteriaBuildQuery = Orders.buildCriteriaQueryV2(
        "orders",
        "token_set_id",
        query.includeCriteriaMetadata,
        "token_set_schema_hash"
      );

      let baseQuery = `
        SELECT
          contracts.kind AS "contract_kind",
          orders.id,
          orders.kind,
          orders.side,
          orders.token_set_id,
          orders.token_set_schema_hash,
          orders.contract,
          orders.maker,
          orders.taker,
          orders.currency,
          orders.price,
          orders.value,
          orders.currency_price,
          orders.currency_value,
          orders.normalized_value,
          orders.currency_normalized_value,
          orders.missing_royalties,
          dynamic,
          DATE_PART('epoch', LOWER(orders.valid_between)) AS valid_from,
          COALESCE(
            NULLIF(DATE_PART('epoch', UPPER(orders.valid_between)), 'Infinity'),
            0
          ) AS valid_until,
          orders.source_id_int,
          orders.quantity_filled,
          orders.quantity_remaining,
          coalesce(orders.fee_bps, 0) AS fee_bps,
          orders.fee_breakdown,
          COALESCE(
            NULLIF(DATE_PART('epoch', orders.expiration), 'Infinity'),
            0
          ) AS expiration,
          orders.is_reservoir,
          extract(epoch from orders.created_at) AS created_at,
          (
            CASE
              WHEN orders.fillability_status = 'filled' THEN 'filled'
              WHEN orders.fillability_status = 'cancelled' THEN 'cancelled'
              WHEN orders.fillability_status = 'expired' THEN 'expired'
              WHEN orders.fillability_status = 'no-balance' THEN 'inactive'
              WHEN orders.approval_status = 'no-approval' THEN 'inactive'
              WHEN orders.approval_status = 'disabled' THEN 'inactive'
              ELSE 'active'
            END
          ) AS status,
          extract(epoch from orders.updated_at) AS updated_at,
          orders.originated_at,
          (${criteriaBuildQuery}) AS criteria
          ${query.includeRawData || query.includeDynamicPricing ? ", orders.raw_data" : ""}
        FROM orders
        JOIN LATERAL (
          SELECT kind
          FROM contracts
          WHERE contracts.address = orders.contract
        ) contracts ON TRUE
      `;

      // Filters
      const conditions: string[] = [
        `orders.side = 'sell'`,
        `orders.contract = $/contract/`,
        `orders.fillability_status = 'fillable' AND orders.approval_status = 'approved'`,
        `orders.taker = '\\x0000000000000000000000000000000000000000' OR orders.taker IS NULL`,
        `orders.token_set_id = 'token:${contract}:${tokenId}'`,
      ];

      switch (query.type) {
        case "token": {
          conditions.push(`orders.token_set_id LIKE 'token:%'`);
          break;
        }
        case "collection": {
          conditions.push(`(
                orders.token_set_id LIKE 'contract:%'
                OR orders.token_set_id LIKE 'range:%'
                OR (orders.token_set_id LIKE 'list:%' AND token_sets.attribute_id IS NULL)
                OR orders.token_set_id LIKE 'dynamic:collection-non-flagged:%'
              )`);
          break;
        }
        case "attribute": {
          conditions.push(
            `(orders.token_set_id LIKE 'list:%' AND token_sets.attribute_id IS NOT NULL)`
          );
          break;
        }
        case "custom": {
          conditions.push(`(
                orders.token_set_id LIKE 'list:%' 
                AND token_sets.collection_id IS NULL
                AND token_sets.attribute_id IS NULL
              )`);
          break;
        }
      }

      if (query.continuation) {
        const [sortOrderPrice, sortOrderId] = splitContinuation(
          query.continuation,
          /^\d+(.\d+)?_0x[a-f0-9]{64}$/
        );

        (query as any).sortOrderPrice = sortOrderPrice;
        (query as any).sortOrderId = sortOrderId;

        if (query.normalizeRoyalties) {
          conditions.push(
            `(orders.normalized_value, orders.id) > ($/sortOrderPrice/, $/sortOrderId/)`
          );
        } else {
          conditions.push(`(orders.price, orders.id) > ($/sortOrderPrice/, $/sortOrderId/)`);
        }
      }

      if (conditions.length) {
        baseQuery += " WHERE " + conditions.map((c) => `(${c})`).join(" AND ");
      }

      // Sorting
      if (query.normalizeRoyalties) {
        baseQuery += ` ORDER BY orders.normalized_value, orders.fee_bps, orders.id`;
      } else {
        baseQuery += ` ORDER BY orders.price, orders.fee_bps, orders.id`;
      }

      // Pagination
      baseQuery += ` LIMIT $/limit/`;

      const rawResult = await redb.manyOrNone(baseQuery, query);

      let continuation = null;

      if (rawResult.length === query.limit) {
        const lastResult = rawResult[rawResult.length - 1];

        if (query.normalizeRoyalties) {
          continuation = buildContinuation(
            lastResult.normalized_value ?? lastResult.price + "_" + lastResult.id
          );
        } else {
          continuation = buildContinuation(lastResult.price + "_" + lastResult.id);
        }
      }

      const result = rawResult.map(async (r) =>
        getJoiOrderObject(
          {
            id: r.id,
            kind: r.kind,
            side: r.side,
            status: r.status,
            tokenSetId: r.token_set_id,
            tokenSetSchemaHash: r.token_set_schema_hash,
            contract: r.contract,
            contractKind: r.contract_kind,
            maker: r.maker,
            taker: r.taker,
            prices: {
              gross: {
                amount: query.normalizeRoyalties
                  ? r.currency_normalized_value ?? r.price
                  : r.currency_price ?? r.price,
                nativeAmount: query.normalizeRoyalties ? r.normalized_value ?? r.price : r.price,
              },
              net: {
                amount: getNetAmount(r.currency_price ?? r.price, _.min([r.fee_bps, 10000])),
                nativeAmount: getNetAmount(r.price, _.min([r.fee_bps, 10000])),
              },
              currency: r.currency,
            },
            validFrom: r.valid_from,
            validUntil: r.valid_until,
            quantityFilled: r.quantity_filled,
            quantityRemaining: r.quantity_remaining,
            criteria: r.criteria,
            sourceIdInt: r.source_id_int,
            feeBps: r.fee_bps,
            feeBreakdown: r.fee_bps === 0 ? [] : r.fee_breakdown,
            expiration: r.expiration,
            isReservoir: r.is_reservoir,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
            originatedAt: r.originated_at,
            rawData: r.raw_data,
            missingRoyalties: r.missing_royalties,
            dynamic: r.dynamic,
          },
          {
            normalizeRoyalties: query.normalizeRoyalties,
            includeRawData: query.includeRawData,
            includeDynamicPricing: query.includeDynamicPricing,
            displayCurrency: query.displayCurrency,
            resizeImageUrl: query.includeCriteriaMetadata,
          }
        )
      );

      return {
        orders: await Promise.all(result),
        continuation,
      };
    } catch (error) {
      logger.error(`get-token-asks-${version}-handler`, `Handler failure: ${error}`);
      throw error;
    }
  },
};
