import { idb } from "@/common/db";

import { AbstractRabbitMqJobHandler } from "@/jobs/abstract-rabbit-mq-job-handler";
import { redis } from "@/common/redis";
import { logger } from "@/common/logger";
import _ from "lodash";

export class BackfillTokensLastSaleJob extends AbstractRabbitMqJobHandler {
  queueName = "backfill-tokens-last-sale-queue";
  maxRetries = 10;
  concurrency = 1;
  persistent = false;
  lazyMode = false;
  singleActiveConsumer = true;

  public async process() {
    const limit = (await redis.get(`${this.queueName}-limit`)) || 1;

    const results = await idb.manyOrNone(
      `
            WITH x AS (
              SELECT 
                contract, 
                token_id, 
                CASE WHEN last_buy_timestamp > last_sell_timestamp THEN last_buy_timestamp ELSE last_sell_timestamp END AS last_sale_timestamp, 
                CASE WHEN last_buy_timestamp > last_sell_timestamp THEN last_buy_value ELSE last_sell_value END AS last_sale_value 
              FROM 
                tokens 
              WHERE 
                last_sale_value IS NULL 
                AND (
                  last_buy_value IS NOT NULL 
                  OR last_sell_value IS NOT NULL 
                ) 
              LIMIT $/limit/
            ) 
            UPDATE 
              tokens 
            SET 
              last_sale_value = x.last_sale_value, 
              last_sale_timestamp = x.last_sale_timestamp 
            FROM 
              x 
            WHERE 
              tokens.contract = x.contract 
              AND tokens.token_id = x.token_id
            RETURNING x.contract, x.token_id
          `,
      {
        limit,
      }
    );

    const lastResult = _.last(results);

    logger.info(
      this.queueName,
      JSON.stringify({
        message: `Backfilled ${results.length} tokens.  limit=${limit}`,
        lastResult,
      })
    );

    if (results.length == limit) {
      await this.addToQueue();
    }
  }

  public async addToQueue(delay = 0) {
    await this.send({ payload: {} }, delay);
  }
}

export const backfillTokensLastSaleJob = new BackfillTokensLastSaleJob();
