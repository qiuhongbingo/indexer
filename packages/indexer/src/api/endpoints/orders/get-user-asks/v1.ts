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
import { CollectionSets } from "@/models/collection-sets";
import * as Boom from "@hapi/boom";

const version = "v1";

export const getUserAsksV1Options: RouteOptions = {
  description: "User Asks (listings)",
  notes: "Get a list of asks (listings), filtered by maker.",
  tags: ["api", "Accounts", "marketplace"],
  plugins: {
    "hapi-swagger": {
      order: 5,
    },
  },
  validate: {
    params: Joi.object({
      user: Joi.string()
        .lowercase()
        .pattern(/^0x[a-fA-F0-9]{40}$/)
        .required()
        .description(
          "Filter to a particular user. Example: `0xF296178d553C8Ec21A2fBD2c5dDa8CA9ac905A00`"
        ),
    }),
    query: Joi.object({
      ids: Joi.alternatives(Joi.array().items(Joi.string()), Joi.string()).description(
        "Order id(s) to search for."
      ),
      status: Joi.string()
        .valid("active", "inactive", "expired", "cancelled", "filled")
        .description(
          "activeª^º = currently valid\ninactiveª^ = temporarily invalid\nexpiredª^, cancelledª^, filledª^ = permanently invalid"
        ),
      collection: Joi.string()
        .lowercase()
        .description(
          "Filter to a particular collection with collection-id. Example: `0x8d04a8c79ceb0889bdd12acdf3fa9d207ed3ff63`"
        ),
      community: Joi.string()
        .lowercase()
        .description("Filter to a particular community. Example: `artblocks`"),
      collectionsSetId: Joi.string()
        .lowercase()
        .description(
          "Filter to a particular collection set. Requires `maker` to be passed. Example: `8daa732ebe5db23f267e58d52f1c9b1879279bcdf4f78b8fb563390e6946ea65`"
        ),
      sortBy: Joi.string()
        .valid("createdAt", "price")
        .default("createdAt")
        .description(
          "Order the items are returned in the response. Sorting by `price` is ascending order / Sorting by `createdAt` is descending order. "
        ),
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
    }).oxor("collection", "community", "collectionsSetId"),
  },
  response: {
    schema: Joi.object({
      orders: Joi.array().items(JoiOrder),
      continuation: Joi.string().pattern(regex.base64).allow(null),
    }).label(`getUserAsks${version.toUpperCase()}Response`),
    failAction: (_request, _h, error) => {
      logger.error(`get-user-asks-${version}-handler`, `Wrong response schema: ${error}`);
      throw error;
    },
  },
  handler: async (request: Request) => {
    const query = request.query as any;

    (query as any).user = toBuffer(request.params.user);

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
        `orders.maker = $/user/`,
        `orders.side = 'sell'`,
        `orders.taker = '\\x0000000000000000000000000000000000000000' OR orders.taker IS NULL`,
      ];

      if (query.ids) {
        if (Array.isArray(query.ids)) {
          conditions.push(`orders.id IN ($/ids:csv/)`);
        } else {
          conditions.push(`orders.id = $/ids/`);
        }
      }

      let orderStatusFilter =
        "orders.fillability_status = 'fillable' AND orders.approval_status = 'approved'";

      switch (query.status) {
        case "active": {
          orderStatusFilter = `orders.fillability_status = 'fillable' AND orders.approval_status = 'approved'`;
          break;
        }
        case "inactive": {
          // Potentially-valid orders
          orderStatusFilter = `orders.fillability_status = 'no-balance' OR (orders.fillability_status = 'fillable' AND orders.approval_status != 'approved')`;
          break;
        }
        case "expired": {
          orderStatusFilter = `orders.fillability_status = 'expired'`;
          break;
        }
        case "filled": {
          orderStatusFilter = `orders.fillability_status = 'filled'`;
          break;
        }
        case "cancelled": {
          orderStatusFilter = `orders.fillability_status = 'cancelled'`;
          break;
        }
      }

      conditions.push(orderStatusFilter);

      if (query.collection) {
        const [contract] = query.collection.split(":");

        (query as any).contract = toBuffer(contract);
        conditions.push(`orders.contract = $/contract/`);

        if (!query.collection.match(regex.address)) {
          baseQuery += `
            JOIN LATERAL (
              SELECT
                contract,
                token_id
              FROM
                token_sets_tokens
              WHERE
                token_sets_tokens.token_set_id = orders.token_set_id LIMIT 1) tst ON TRUE
            JOIN tokens ON tokens.contract = tst.contract
              AND tokens.token_id = tst.token_id
          `;

          conditions.push(`tokens.collection_id = $/collection/`);
        }
      }

      if (query.community) {
        baseQuery +=
          "JOIN (SELECT DISTINCT contract FROM collections WHERE community = $/community/) c ON orders.contract = c.contract";
      }

      if (query.collectionsSetId) {
        query.collectionsIds = await CollectionSets.getCollectionsIds(query.collectionsSetId);

        if (_.isEmpty(query.collectionsIds)) {
          throw Boom.badRequest(`No collections for collection set ${query.collectionsSetId}`);
        }

        baseQuery += `
            JOIN LATERAL (
              SELECT
                contract,
                token_id
              FROM
                token_sets_tokens
              WHERE
                token_sets_tokens.token_set_id = orders.token_set_id
              LIMIT 1) tst ON TRUE
            JOIN tokens ON tokens.contract = tst.contract
              AND tokens.token_id = tst.token_id
          `;

        conditions.push(`tokens.collection_id IN ($/collectionsIds:csv/)`);
      }

      if (query.continuation) {
        const [sortOrderValueOrCreatedAt, sortOrderId] = splitContinuation(
          query.continuation,
          /^\d+(.\d+)?_0x[a-f0-9]{64}$/
        );

        (query as any).sortOrderValueOrCreatedAt = sortOrderValueOrCreatedAt;
        (query as any).sortOrderId = sortOrderId;

        if (query.sortBy === "price") {
          if (query.normalizeRoyalties) {
            conditions.push(
              `(orders.normalized_value, orders.id) > ($/sortOrderValueOrCreatedAt/, $/sortOrderId/)`
            );
          } else {
            conditions.push(
              `(orders.price, orders.id) > ($/sortOrderValueOrCreatedAt/, $/sortOrderId/)`
            );
          }
        } else {
          conditions.push(
            `(orders.created_at, orders.id) < (to_timestamp($/sortOrderValueOrCreatedAt/), $/sortOrderId/)`
          );
        }
      }

      if (conditions.length) {
        baseQuery += " WHERE " + conditions.map((c) => `(${c})`).join(" AND ");
      }

      // Sorting
      if (query.sortBy === "price") {
        if (query.normalizeRoyalties) {
          baseQuery += ` ORDER BY orders.normalized_value, orders.fee_bps, orders.id`;
        } else {
          baseQuery += ` ORDER BY orders.price, orders.fee_bps, orders.id`;
        }
      } else {
        baseQuery += ` ORDER BY orders.created_at DESC, orders.id DESC`;
      }

      // Pagination
      baseQuery += ` LIMIT $/limit/`;

      const rawResult = await redb.manyOrNone(baseQuery, query);

      let continuation = null;

      if (rawResult.length === query.limit) {
        const lastResult = rawResult[rawResult.length - 1];

        if (query.sortBy === "price") {
          if (query.normalizeRoyalties) {
            continuation = buildContinuation(
              lastResult.normalized_value ?? lastResult.price + "_" + lastResult.id
            );
          } else {
            continuation = buildContinuation(lastResult.price + "_" + lastResult.id);
          }
        } else {
          continuation = buildContinuation(lastResult.created_at + "_" + lastResult.id);
        }
      }

      const result = rawResult.map(async (r) => {
        return await getJoiOrderObject(
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
            includeRawData: query.includeRawData,
            includeDynamicPricing: query.includeDynamicPricing,
            normalizeRoyalties: query.normalizeRoyalties,
            displayCurrency: query.displayCurrency,
            resizeImageUrl: query.includeCriteriaMetadata,
          }
        );
      });

      return {
        orders: await Promise.all(result),
        continuation,
      };
    } catch (error) {
      logger.error(`get-user-asks-${version}-handler`, `Handler failure: ${error}`);
      throw error;
    }
  },
};
