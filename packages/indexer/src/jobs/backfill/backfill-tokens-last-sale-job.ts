import { idb, ridb, pgp } from "@/common/db";

import { AbstractRabbitMqJobHandler } from "@/jobs/abstract-rabbit-mq-job-handler";
import { RabbitMQMessage } from "@/common/rabbit-mq";
import { fromBuffer, toBuffer } from "@/common/utils";
import _ from "lodash";
import { redis } from "@/common/redis";
import { logger } from "@/common/logger";

export type BackfillTokensLastSaleJobCursor = {
  txHash: string;
  logIndex: number;
  batchIndex: number;
  createdTs: number;
};

export type BackfillTokensLastSaleJobPayload = {
  cursor?: BackfillTokensLastSaleJobCursor;
};

export class BackfillTokensLastSaleJob extends AbstractRabbitMqJobHandler {
  queueName = "backfill-tokens-last-sale-queue";
  maxRetries = 10;
  concurrency = 1;
  persistent = false;
  lazyMode = false;
  singleActiveConsumer = true;

  public async process(payload: BackfillTokensLastSaleJobPayload) {
    const cursor = payload.cursor as BackfillTokensLastSaleJobCursor;

    let continuationFilter = "";

    const limit = (await redis.get(`${this.queueName}-limit`)) || 500;

    if (cursor) {
      continuationFilter = `AND (fill_events_2.created_at, fill_events_2.tx_hash, fill_events_2.log_index, fill_events_2.batch_index) < (to_timestamp($/createdTs/), $/txHash/, $/logIndex/, $/batchIndex/)`;
    }

    const results = await ridb.manyOrNone(
      `
          SELECT
            fill_events_2.tx_hash,
            fill_events_2.log_index,
            fill_events_2.batch_index,
            fill_events_2.created_at,
            fill_events_2.contract,
            fill_events_2.token_id,
            fill_events_2.timestamp,
            fill_events_2.price,
            extract(epoch from fill_events_2.created_at) created_ts
          FROM fill_events_2
          WHERE order_kind != 'mint'
          ${continuationFilter}
          ORDER BY fill_events_2.created_at DESC, fill_events_2.tx_hash DESC, fill_events_2.log_index DESC, fill_events_2.batch_index DESC
          LIMIT $/limit/
          `,
      {
        createdTs: cursor?.createdTs,
        txHash: cursor?.txHash ? toBuffer(cursor.txHash) : null,
        logIndex: cursor?.logIndex,
        batchIndex: cursor?.batchIndex,
        limit,
      }
    );

    if (results.length) {
      const tokensUpdateColumns = new pgp.helpers.ColumnSet(
        ["contract", "token_id", "last_sale_timestamp", "last_sale_value"],
        {
          table: "tokens",
        }
      );

      const tokensUpdateValues = results.map((result) => ({
        contract: result.contract,
        token_id: result.token_id,
        last_sale_timestamp: result.timestamp,
        last_sale_value: result.price,
      }));

      const updateQuery = `
              UPDATE tokens SET 
                last_sale_timestamp = x.last_sale_timestamp,
                last_sale_value = CAST(x.last_sale_value AS numeric)
              FROM (VALUES ${pgp.helpers.values(
                tokensUpdateValues,
                tokensUpdateColumns
              )}) AS x(contract, token_id, last_sale_timestamp, last_sale_value)
              WHERE CAST(x.contract AS bytea) = tokens.contract
              AND x.token_id::numeric = tokens.token_id
              AND COALESCE(tokens.last_sale_timestamp, 0) < x.last_sale_timestamp`;

      await idb.none(updateQuery);

      logger.info(
        this.queueName,
        JSON.stringify({
          message: `Backfilled ${results.length} tokens.  limit=${limit}`,
          cursor,
        })
      );

      if (results.length == limit) {
        const lastResult = _.last(results);

        return {
          addToQueue: true,
          addToQueueCursor: {
            txHash: fromBuffer(lastResult.tx_hash),
            logIndex: lastResult.log_index,
            batchIndex: lastResult.batch_index,
            createdTs: lastResult.created_ts,
          } as BackfillTokensLastSaleJobCursor,
        };
      }
    }

    return { addToQueue: false };
  }

  public async onCompleted(
    rabbitMqMessage: RabbitMQMessage,
    processResult: {
      addToQueue: boolean;
      addToQueueCursor: BackfillTokensLastSaleJobCursor;
    }
  ) {
    if (processResult.addToQueue) {
      await this.addToQueue(processResult.addToQueueCursor, 1 * 1000);
    }
  }

  public async addToQueue(cursor?: BackfillTokensLastSaleJobCursor, delay = 0) {
    await this.send({ payload: { cursor } }, delay);
  }
}

export const backfillTokensLastSaleJob = new BackfillTokensLastSaleJob();
