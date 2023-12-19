/* eslint-disable @typescript-eslint/no-explicit-any */

import { idb } from "@/common/db";

import { Orders } from "@/utils/orders";
import { OrderEventInfo } from "@/elasticsearch/indexes/activities/event-handlers/base";
import _ from "lodash";
import { logger } from "@/common/logger";
import {
  AskDocumentInfo,
  BaseAskEventHandler,
} from "@/elasticsearch/indexes/asks/event-handlers/base";

export class AskCreatedEventHandler extends BaseAskEventHandler {
  async generateAsk(): Promise<AskDocumentInfo | null> {
    const query = `
          ${AskCreatedEventHandler.buildBaseQuery()}
          AND id = $/orderId/
          LIMIT 1;
        `;

    const data = await idb.oneOrNone(query, {
      orderId: this.orderId,
    });

    if (data) {
      const id = this.getAskId();
      const document = this.buildDocument(data);

      return { id, document };
    }

    return null;
  }

  public static buildBaseQuery(onlyActive = true) {
    const orderCriteriaSelectQueryPart = Orders.buildCriteriaQuery(
      "orders",
      "token_set_id",
      false,
      "token_set_schema_hash"
    );

    return `
             SELECT           
              orders.id AS "order_id",
              orders.price AS "order_pricing_price",
              orders.currency AS "order_pricing_currency",
              orders.currency_price AS "order_pricing_currency_price",
              orders.value AS "order_pricing_value",
              orders.currency_value AS "order_pricing_currency_value",
              orders.normalized_value AS "order_pricing_normalized_value",
              orders.currency_normalized_value AS "order_pricing_currency_normalized_value",
              orders.quantity_filled AS "order_quantity_filled",
              orders.quantity_remaining AS "order_quantity_remaining",
              orders.fee_bps AS "order_pricing_fee_bps",
              orders.source_id_int AS "order_source_id_int",
              orders.maker AS "order_maker",
              orders.taker AS "order_taker",
              orders.kind AS "order_kind",
              orders.dynamic AS "order_dynamic",
              orders.raw_data AS "order_raw_data",
              orders.missing_royalties AS "order_missing_royalties",
              DATE_PART('epoch', LOWER(orders.valid_between)) AS "order_valid_from",
              COALESCE(
                NULLIF(DATE_PART('epoch', UPPER(orders.valid_between)), 'Infinity'),
                0
              ) AS "order_valid_until",
              orders.token_set_id AS "order_token_set_id",
              (${orderCriteriaSelectQueryPart}) AS order_criteria,
              orders.created_at AS "order_created_at",
              extract(epoch from orders.updated_at) updated_ts,
              t.*
            FROM orders
            JOIN LATERAL (
                    SELECT
                        tokens.token_id,
                        tokens.contract,
                        tokens.name AS "token_name",
                        tokens.image AS "token_image",
                        tokens.media AS "token_media",
                        tokens.is_flagged AS "token_is_flagged",
                        tokens.is_spam AS "token_is_spam",
                        tokens.rarity_rank AS "token_rarity_rank",
                        collections.id AS "collection_id", 
                        collections.name AS "collection_name", 
                        collections.is_spam AS "collection_is_spam",
                        (collections.metadata ->> 'imageUrl')::TEXT AS "collection_image",
                        (
                        SELECT 
                          array_agg(
                            json_build_object(
                              'key', ta.key, 'kind', attributes.kind, 
                              'value', ta.value
                            )
                          ) 
                        FROM 
                          token_attributes ta 
                          JOIN attributes ON ta.attribute_id = attributes.id 
                        WHERE 
                          ta.contract = tokens.contract
                          AND ta.token_id = tokens.token_id
                          AND ta.key != ''
                      ) AS "token_attributes" 
                    FROM tokens
                    JOIN collections on collections.id = tokens.collection_id
                    WHERE decode(substring(split_part(orders.token_set_id, ':', 2) from 3), 'hex') = tokens.contract
                    AND (split_part(orders.token_set_id, ':', 3)::NUMERIC(78, 0)) = tokens.token_id
                    LIMIT 1
                 ) t ON TRUE
            WHERE orders.side = 'sell'
            ${
              onlyActive
                ? `AND orders.fillability_status = 'fillable' AND orders.approval_status = 'approved'`
                : ""
            }
            AND orders.kind != 'element-erc1155'
                 `;
  }

  static async generateAsks(events: OrderEventInfo[]): Promise<AskDocumentInfo[]> {
    const asks: AskDocumentInfo[] = [];

    const asksFilter = [];

    for (const event of events) {
      asksFilter.push(`('${event.orderId}')`);
    }

    const results = await idb.manyOrNone(
      `
                ${AskCreatedEventHandler.buildBaseQuery()}
                WHERE (id) IN ($/asksFilter:raw/)';  
                `,
      { asksFilter: _.join(asksFilter, ",") }
    );

    for (const result of results) {
      try {
        const event = events.find((event) => event.orderId === result.id);

        if (event) {
          const eventHandler = new AskCreatedEventHandler(result.id);

          const id = eventHandler.getAskId();
          const document = eventHandler.buildDocument(result);

          asks.push({ id, document });
        } else {
          logger.warn(
            "ask-created-event-handler",
            JSON.stringify({
              topic: "generate-asks",
              message: `Invalid order. orderId=${result.order_id}`,
              result,
            })
          );
        }
      } catch (error) {
        logger.error(
          "ask-created-event-handler",
          JSON.stringify({
            topic: "generate-asks",
            message: `Error build document. error=${error}`,
            result,
            error,
          })
        );
      }
    }

    return asks;
  }
}